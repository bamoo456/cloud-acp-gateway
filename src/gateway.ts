/**
 * acp-gateway — puts an SSE+POST transport in front of one or more ACP agents so
 * a remote ACP client (e.g. https://github.com/wiedymi/swift-acp) can drive them
 * over a network / private VPN.
 *
 * Host-agnostic: a k8s pod, a VM, or bare metal — nothing here is
 * Kubernetes-specific. It is a *transparent* JSON-RPC relay (it does not
 * reimplement ACP) that adds the things a raw shell can't:
 *
 *   - auth: shared credentials (a VPN is a network boundary, not an auth one)
 *   - per-agent replayable ledger: every agent->client frame is appended to a
 *     JSONL file and assigned a monotonic seq; a dropped client reconnects with
 *     Last-Event-ID=<seq> and the gateway replays everything after it
 *   - agent lifecycle + switching: define multiple agents in agents.json and
 *     pick one per connection with ?agent=<name>. Each runs independently and
 *     keeps its own history, so you can hop between e.g. two Claude Code setups
 *     (or Claude Code and another ACP agent) without losing either session.
 *
 * Transport: the client opens an SSE stream (GET ssePath) for the agent->client
 * direction — each frame is one `data:` event tagged with its ledger seq as `id:`
 * — and POSTs client->agent frames to rpcPath. Agent stdio is newline-delimited
 * JSON-RPC. Byte-transparent both ways.
 */
import http from "node:http";
import https from "node:https";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, isRequest, isResponse, sessionIdOf, cwdOf, type Frame } from "./frames.ts";
import { IdMux } from "./idmux.ts";
import { Subscriptions } from "./subscriptions.ts";
import { OnceGate } from "./oncegate.ts";
import { SseSink, type ClientSink } from "./sink.ts";
import { Ledger, type LedgerEntry } from "./ledger.ts";
import { basicAuthOk, wsAuthOk } from "./auth.ts";
import { resolveTls } from "./tls.ts";
import { accessUrls } from "./access.ts";
import { Db, type InboxItem, type InboxStatus, type TranscriptMeta } from "./db.ts";
import Database from "better-sqlite3";
import { handleLogin, getSession, registerLoginAgent } from "./login.ts";
import { handleTerminal, setCwdResolver } from "./terminal.ts";
import { handleUpload } from "./uploads.ts";
import { usageLimits, codexUsageLimits } from "./usage-limits.ts";
import {
  changes as workspaceChanges, fileDiff as workspaceFileDiff, preview as workspacePreview,
  tree as workspaceTree, find as workspaceFind, grep as workspaceGrep,
  outputFolder as workspaceOutputFolder,
  revChanges as workspaceRevChanges, commits as workspaceCommits,
  inlineImageType, repoRoot, validRev, MAX_RAW_BYTES, MAX_COMMITS, type RevSpec,
} from "./workspace.ts";
import {
  readDraft, readDrafts, writeDraft, parseComments, reviewScopeKey, MAX_DRAFTS_BYTES,
} from "./review.ts";
import { renderHtmlFile } from "./htmlinline.ts";
import { buildClientConfig } from "./client-config.ts";
import { afterCursor, bySearchOrder, encodeCursor, escapeRegExp, findHits, MAX_HITS_IN_SESSION, searchQueryParams, type SearchHit, type SearchQuery } from "./search-core.ts";

const ROOT = path.join(__dirname, "..");

// Exposed via /healthz so a fleet of gateway instances can be told apart by
// version (e.g. from a console listing several saved gateways).
export const GATEWAY_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// Load config from a .env file next to the gateway if one exists, so secrets like
// ACPG_AUTH_USER / ACPG_AUTH_TOKEN can live in a file instead of the shell. Real environment
// variables take precedence over .env (Node does not override what's already set).
// First drop any present-but-EMPTY ACPG_*/ACPB_* var: tools like `make` inject an
// empty value when `export`-ing an unset variable, and that blank would otherwise
// shadow the real value in .env. An empty config value is never meaningful.
for (const k of Object.keys(process.env)) {
  if (
    (k.startsWith("ACPG_") || k.startsWith("ACPB_")) &&
    process.env[k] === ""
  )
    delete process.env[k];
}
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env file — rely on the process environment
}
// Backward compatibility (#46): the env prefix was renamed ACPB_* -> ACPG_* when
// the project moved from "bridge" to "gateway". Honor the legacy ACPB_* names as
// aliases when the new ACPG_* form is unset, so existing .env / k8s manifests /
// systemd units keep working. Done after .env load so file-provided ACPB_* are
// aliased too. Warn once so operators know to migrate; the aliases are a transition
// shim, not a permanent contract.
let warnedLegacyEnvPrefix = false;
for (const k of Object.keys(process.env)) {
  if (!k.startsWith("ACPB_")) continue;
  const renamed = "ACPG_" + k.slice("ACPB_".length);
  if (process.env[renamed] === undefined) {
    process.env[renamed] = process.env[k];
    if (!warnedLegacyEnvPrefix) {
      console.warn(
        "env: ACPB_* variables are deprecated; rename them to ACPG_* " +
          "(legacy ACPB_* names are still honored for now)",
      );
      warnedLegacyEnvPrefix = true;
    }
  }
}

// ---------------------------------------------------------------- config ----
// `defaults` are this agent's own starting controls (config option id -> value,
// e.g. {"model": "opus[1m]", "effort": "xhigh"}), applied to every session the
// gateway creates. They exist because the agent's own defaults come from its
// CLI's global config (~/.claude/settings.json for claude-agent-acp), which the
// user also changes for their terminal — the gateway needs a default of its own
// that a terminal `/model` can't move. Values the session doesn't offer are
// dropped, like any other control re-apply.
type AgentProfile = { cmd: string; args: string[]; cwd: string; defaults?: Record<string, string> };

function resolveCmd(cmd: string): string {
  // Relative agent commands resolve against the gateway's install dir, NOT the
  // agent's own cwd (which is the project the agent operates on).
  return path.isAbsolute(cmd) ? cmd : path.resolve(ROOT, cmd);
}

export function loadAgents(): Record<string, AgentProfile> {
  const file = process.env.ACPG_AGENTS_FILE ?? path.join(ROOT, "agents.json");
  // cwd for entries that omit one: ACPG_AGENT_CWD if set, else the user's home
  // dir (~). NOT process.cwd() — that's the gateway install dir, not a project
  // the agent should operate on.
  const defaultCwd = process.env.ACPG_AGENT_CWD || os.homedir();
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      Partial<AgentProfile>
    >;
    const out: Record<string, AgentProfile> = {};
    for (const [name, p] of Object.entries(raw)) {
      if (!p.cmd) {
        console.error(`FATAL: agent "${name}" in ${file} has no "cmd"`);
        process.exit(1);
      }
      const cmd = resolveCmd(p.cmd);
      // Drop entries whose binary isn't on this host. A shared agents.json
      // template (e.g. with opencode pointing at /opt/homebrew/bin/opencode)
      // should not crash the gateway on a machine that only has Claude and
      // Codex installed — the missing agent just gets hidden from the
      // switcher. Check the file system, not PATH: `resolveCmd` only handles
      // absolute or gateway-relative paths, so `existsSync` is the right test
      // for what we'll actually spawn.
      if (!fs.existsSync(cmd)) {
        console.warn(
          `agents: skipping "${name}" — cmd not found at ${cmd}`,
        );
        continue;
      }
      out[name] = {
        cmd,
        args: p.args ?? [],
        cwd: p.cwd ?? defaultCwd,
        // Only string values: every ACP select-type control takes a string, and a
        // number/bool/null in the file would otherwise reach the adapter as one.
        defaults: p.defaults && typeof p.defaults === "object"
          ? Object.fromEntries(Object.entries(p.defaults).filter(([, v]) => typeof v === "string"))
          : undefined,
      };
    }
    if (Object.keys(out).length === 0) {
      console.error(`FATAL: ${file} defines no usable agents (all entries skipped)`);
      process.exit(1);
    }
    return out;
  }
  // No agents file: warn loudly — a missing agents.json silently drops every
  // extra agent (e.g. codex), leaving only claude with no hint why.
  console.warn(
    `agents: no agents file at ${file}; falling back to a single claude-only agent`,
  );
  // Fallback: a single agent configured from env (defaults to claude-agent-acp).
  return {
    claude: {
      cmd: resolveCmd(
        process.env.ACPG_AGENT_CMD ??
          path.join("node_modules", ".bin", "claude-agent-acp"),
      ),
      args: (process.env.ACPG_AGENT_ARGS ?? "").split(" ").filter(Boolean),
      cwd: defaultCwd,
    },
  };
}

const cfg = {
  listen: process.env.ACPG_LISTEN ?? "0.0.0.0:8080",
  // SSE downstream + POST upstream transport (the only client transport). sse = the
  // event-stream a client GETs; rpc = where it POSTs frames.
  ssePath: process.env.ACPG_SSE_PATH ?? "/acp/sse",
  rpcPath: process.env.ACPG_RPC_PATH ?? "/acp/rpc",
  // Interval for SSE keepalive comments: keeps proxies/LBs from idling the stream out
  // and surfaces a dead peer on the next write. Invalid/non-positive falls back.
  sseKeepaliveMs: (() => {
    const n = Number(process.env.ACPG_SSE_KEEPALIVE_MS ?? "15000");
    return Number.isFinite(n) && n > 0 ? n : 15000;
  })(),
  authUser: process.env.ACPG_AUTH_USER ?? "",
  authToken: process.env.ACPG_AUTH_TOKEN ?? "",
  ledgerDir: process.env.ACPG_LEDGER_DIR ?? "/data",
  agents: loadAgents(),
  defaultAgent: process.env.ACPG_DEFAULT_AGENT ?? "",
  // Cap the size of a single upstream POST body so a malformed or oversized frame
  // can't be buffered without bound before the gateway parses it. ACP prompt/diff
  // frames are normally far smaller than the 16 MiB default. Invalid/non-positive
  // values fall back.
  maxPayload: (() => {
    const n = Number(process.env.ACPG_MAX_PAYLOAD ?? "16777216");
    return Number.isFinite(n) && n > 0 ? n : 16777216;
  })(),
  // Cap on a single /uploads POST body. Independent of maxPayload: that cap
  // bounds a JSON-RPC frame buffered fully in memory before parsing, but an
  // upload streams straight to disk (uploads.ts), so its constraint is disk
  // usage/transfer time rather than peak memory — sized generously enough for
  // real documents (a scanned/image-heavy PDF can comfortably exceed 16 MiB).
  // Invalid/non-positive values fall back.
  uploadMaxBytes: (() => {
    const n = Number(process.env.ACPG_UPLOAD_MAX_BYTES ?? "52428800");
    return Number.isFinite(n) && n > 0 ? n : 52428800;
  })(),
};
if (!cfg.authUser) {
  console.error("FATAL: ACPG_AUTH_USER is required");
  process.exit(1);
}
if (!cfg.authToken) {
  console.error("FATAL: ACPG_AUTH_TOKEN is required");
  process.exit(1);
}
if (!cfg.defaultAgent) cfg.defaultAgent = Object.keys(cfg.agents)[0];

// TLS config. Resolved lazily at listen time (not here) so that importing this
// module — e.g. tests with ACPG_NO_LISTEN=1 — never triggers cert generation.
const tlsOptions = {
  enabled: (process.env.ACPG_TLS ?? "on").toLowerCase() !== "off",
  certPath: process.env.ACPG_TLS_CERT || undefined,
  keyPath: process.env.ACPG_TLS_KEY || undefined,
  dir: process.env.ACPG_TLS_DIR || path.join(cfg.ledgerDir, "tls"),
  san: process.env.ACPG_TLS_SAN || undefined,
};

// --------------------------------------------------------------- history ----
// Read agent-native session stores directly so the console can LIST and VIEW
// past conversations for an agent's cwd without paying the cost of resuming the
// agent. Claude Code stores project-scoped JSONL under ~/.claude; Codex stores
// active and archived rollout JSONL plus an index under CODEX_HOME (~/.codex).
// The Claude ACP adapter binary. The package moved from
// @zed-industries/claude-code-acp (bin: claude-code-acp) to
// @agentclientprotocol/claude-agent-acp (bin: claude-agent-acp); match both so
// existing agents.json configs keep working after the rename.
function isClaudeAcpCmd(cmd: string): boolean {
  const base = path.basename(cmd);
  return base.includes("claude-code-acp") || base.includes("claude-agent-acp");
}
export function supportsClaudeHistory(cmd: string): boolean {
  return isClaudeAcpCmd(cmd);
}
type HistoryProvider = "claude" | "codex" | "opencode";
function historyProviderFor(cmd: string): HistoryProvider | null {
  const base = path.basename(cmd);
  if (isClaudeAcpCmd(cmd)) return "claude";
  if (base.includes("codex-acp")) return "codex";
  // opencode runs as `opencode acp`, so its binary name is just `opencode`.
  if (base.includes("opencode")) return "opencode";
  return null;
}
export function supportsAgentHistory(cmd: string): boolean {
  return historyProviderFor(cmd) !== null;
}
// Which providers can answer /history/discovered — i.e. recover each session's
// own cwd from its transcript, so the console can list conversations belonging
// to folders it is not currently sitting in. opencode is out because its
// sessions live in an indexed DB keyed by directory, with no transcript to
// recover a cwd from. Advertised per-agent in the client config rather than
// re-derived client-side: both the web sidebar and the iOS console used to
// hardcode `kind === "claude"`, which is why codex conversations from other
// folders were invisible in each of them.
const DISCOVERABLE_PROVIDERS = new Set<HistoryProvider>(["claude", "codex"]);
export function supportsHistoryDiscovery(cmd: string): boolean {
  const provider = historyProviderFor(cmd);
  return provider !== null && DISCOVERABLE_PROVIDERS.has(provider);
}
// Optimistic default used only until the agent reports its real capability at
// initialize (see Gateway.sessionLoad). This used to sniff for codex-acp and
// guess `false`, from the era when it couldn't resume over ACP — but
// `observedSessionLoad` is in-memory, so every gateway restart reverted codex to
// that stale guess, and the web sidebar's Recent tab hard-drops any agent
// advertising `sessionLoad: false` (`recentReopenable`). Codex conversations
// therefore vanished from Recent after each restart and could not come back:
// only opening a codex session heals the guess, and Recent is exactly the list
// that wouldn't offer one. Guessing true inverts that into a transient the
// handshake corrects downward within one connection.
export function supportsAgentSessionLoad(_cmd: string): boolean {
  return true;
}
export function agentSkinFor(cmd: string): "codex" | "opencode" | undefined {
  const base = path.basename(cmd);
  if (base.includes("codex-acp")) return "codex";
  if (base.includes("opencode")) return "opencode";
  return undefined;
}
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const encodeProjectPath = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const projectDirFor = (cwd: string) => path.join(CLAUDE_DIR, "projects", encodeProjectPath(cwd));
const claudeProjectsRoot = () => path.join(CLAUDE_DIR, "projects");

// encodeProjectPath alone can point at a directory the CLI never wrote: the CLI
// truncates encoded names it considers too long (~200 chars) and appends a short
// hash, and clients can send a cwd whose encoding doesn't match the transcript's
// real location (stale sidebar folder, the empty-cwd → agent-default fallback,
// symlinked paths). Resolving strictly via the computed name then 404s sessions
// that DO exist on disk ("Couldn't load conversation"). These fallbacks recover
// the real location; both take the primary computed path first so the common
// case stays a single existsSync.
async function realpathOr(p: string): Promise<string> {
  try { return await fs.promises.realpath(p); } catch { return path.resolve(p); }
}

// Locate a session transcript: the computed <encoded cwd>/<sid>.jsonl when it
// exists, else the unique <sid>.jsonl anywhere under the projects root (session
// ids are UUIDs, so a filename match is unambiguous). The id is pattern-guarded
// so a crafted "session id" can't traverse out of the store.
export async function findClaudeSessionFile(cwd: string, sessionId: string, projectsRoot = claudeProjectsRoot()): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  const primary = path.join(projectsRoot, encodeProjectPath(cwd), sessionId + ".jsonl");
  if (fs.existsSync(primary)) return primary;
  return findClaudeSessionFileById(sessionId, projectsRoot);
}

// Deleting resolves a conversation by id, then checks the cwd the conversation
// itself records — every provider stores one. `withinRoot` is how the HTTP layer
// injects the ACPG_FS_ROOT bound without the helpers importing that policy; a
// conversation whose cwd can't be determined is allowed through, since refusing
// would make an unreadable transcript undeletable.
export interface DeleteHistoryOpts {
  projectsRoot?: string;
  withinRoot?: (cwd: string) => boolean;
}
function allowedCwd(cwd: string | null | undefined, opts?: DeleteHistoryOpts): boolean {
  if (!opts?.withinRoot || !cwd) return true;
  return opts.withinRoot(cwd);
}

// The id-only half of the lookup above: session ids are UUIDs, so a filename
// match anywhere under the projects root is unambiguous — no cwd needed. Same
// pattern guard, so a crafted "session id" can't traverse out of the store.
export async function findClaudeSessionFileById(sessionId: string, projectsRoot = claudeProjectsRoot()): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(projectsRoot, d.name, sessionId + ".jsonl");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Delete a conversation's transcript, located by id alone. `withinRoot` gates it
// on the cwd the transcript itself records — a real boundary, unlike trusting a
// cwd the caller supplied (which this lookup would fall back off of anyway). The
// custom-title sidecar entry goes with it, taken from the transcript's own
// directory so a truncated or symlinked project dir still gets cleaned.
async function deleteClaudeSession(sessionId: string, opts?: DeleteHistoryOpts): Promise<boolean> {
  const file = await findClaudeSessionFileById(sessionId, opts?.projectsRoot ?? claudeProjectsRoot());
  if (!file) return false;
  const { cwd } = await claudeTranscriptSummary(file);
  if (!allowedCwd(cwd, opts)) return false;
  try { await fs.promises.unlink(file); } catch { return false; }
  await clearTitleIn(path.dirname(file), sessionId);
  return true;
}

// Session transcripts only — `agent-` files are sidechains, and a project dir can
// also hold gateway sidecars (.acpb-titles.json), which say nothing about where
// the conversations are.
async function hasClaudeTranscripts(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.readdir(dir)).some((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  } catch { return false; }
}

// Locate the project dir for a cwd: the computed name when it holds this cwd's
// transcripts, else the dir whose newest transcript records this cwd (realpath-
// compared, since all transcripts in one project dir share the same cwd). Covers
// listing sessions for a cwd whose encoded name the CLI truncated.
//
// The computed name has to be judged on its CONTENTS, not merely on existing: a
// rename writes its sidecar to that path and creates the directory, so an
// exists() test lets an empty gateway-made folder shadow the CLI's real one and
// report a folder full of conversations as empty. Callers treat null as "use the
// computed name anyway", so a folder with no transcripts at all still behaves
// exactly as before.
export async function findClaudeProjectDir(cwd: string, projectsRoot = claudeProjectsRoot()): Promise<string | null> {
  const primary = path.join(projectsRoot, encodeProjectPath(cwd));
  if (await hasClaudeTranscripts(primary)) return primary;
  const want = await realpathOr(cwd);
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsRoot, d.name);
    let files: string[];
    try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-")); } catch { continue; }
    let best: { file: string; mtime: number } | null = null;
    for (const f of files) {
      try {
        const st = await fs.promises.stat(path.join(dir, f));
        if (!best || st.mtimeMs > best.mtime) best = { file: f, mtime: st.mtimeMs };
      } catch { /* ignore */ }
    }
    if (!best) continue;
    const summary = await claudeTranscriptSummary(path.join(dir, best.file));
    if (summary.cwd && (await realpathOr(summary.cwd)) === want) return dir;
  }
  return null;
}
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const codexIndexFile = () => path.join(codexHome(), "session_index.jsonl");
const codexSessionsDir = () => path.join(codexHome(), "sessions");
const codexArchivedDir = () => path.join(codexHome(), "archived_sessions");

// opencode keeps its conversation store under the XDG data dir. Recent builds
// (the SQLite migration) put it all in one DB, `opencode.db`, with `session`
// rows (metadata, incl. the project `directory`), `message` rows, and `part`
// rows — message/part payloads live in each row's JSON `data` column, the same
// shapes the older file-per-record layout used. Honor XDG_DATA_HOME.
const opencodeDbFile = () => {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
};

// Open the opencode DB read-only for one query, then close. Best effort: a
// missing / locked / corrupt DB returns `fallback` so history degrades to empty
// rather than throwing. read-only + WAL lets it run alongside a live opencode.
function withOpenCodeDb<T>(fn: (db: Database.Database) => T, fallback: T): T {
  let db: Database.Database | null = null;
  try {
    db = new Database(opencodeDbFile(), { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// Same, but writable — deleting a conversation is the one thing the gateway
// changes in opencode's store. Degrades the same way: a locked DB (opencode
// mid-write) returns `fallback` so the caller reports the delete as failed
// instead of throwing.
function withOpenCodeDbWrite<T>(fn: (db: Database.Database) => T, fallback: T): T {
  let db: Database.Database | null = null;
  try {
    db = new Database(opencodeDbFile(), { fileMustExist: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// Custom conversation titles (from rename) — a per-cwd sidecar next to the
// session files. claude-code owns the .jsonl files, so titles live separately.
const titlesFileIn = (dir: string) => path.join(dir, ".acpb-titles.json");
const titlesFile = (cwd: string) => titlesFileIn(projectDirFor(cwd));
async function readTitlesIn(dir: string): Promise<Record<string, string>> {
  try {
    const o = JSON.parse(await fs.promises.readFile(titlesFileIn(dir), "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch { return {}; }
}
// `projectsRoot` is the caller's store root when it has one (the discovery walk
// carries it, and tests inject a temp root); without it the sidecar is addressed
// under the real CLAUDE_DIR, which is the same path in production. Either way the
// encoding matches writeTitle's, so every listing sees the file a rename wrote.
const readTitles = (cwd: string, projectsRoot?: string) =>
  readTitlesIn(projectsRoot ? path.join(projectsRoot, encodeProjectPath(cwd)) : projectDirFor(cwd));
// Persists the custom title and returns the one now in effect — "" when the
// rename cleared it (the derived title takes over again). Callers need that
// value: the sidecar is not the only place a title is cached.
async function writeTitle(cwd: string, sessionId: string, title: string): Promise<string> {
  const t = await readTitles(cwd);
  const trimmed = title.trim().slice(0, 120);
  if (trimmed) t[sessionId] = trimmed; else delete t[sessionId]; // empty title reverts to the derived one
  await fs.promises.mkdir(projectDirFor(cwd), { recursive: true });
  await fs.promises.writeFile(titlesFile(cwd), JSON.stringify(t));
  return trimmed;
}
// How deep /history/rename looks when re-deriving the title a CLEARED rename
// falls back to. The listing's own ceiling: past it a conversation has no recency
// row worth correcting either, since the recents table caps at 50 across every
// folder.
const RENAME_DERIVE_LIMIT = 200;
// Drop a deleted session's custom title. Takes the sidecar's directory rather
// than a cwd: deletion resolves a session by id, and for claude the transcript's
// own directory is the authoritative one — projectDirFor(cwd) can point somewhere
// else entirely when the CLI truncated the encoded name or the cwd is symlinked.
// Never creates the file: an absent entry is simply nothing to clear.
async function clearTitleIn(dir: string, sessionId: string): Promise<void> {
  const t = await readTitlesIn(dir);
  if (!(sessionId in t)) return;
  delete t[sessionId];
  await fs.promises.writeFile(titlesFileIn(dir), JSON.stringify(t));
}

// ACPG_FS_ROOT bounds which host directories the console may browse and pick as
// a cwd. Everything must resolve within it (realpath + prefix guard).
const FS_ROOT = (() => {
  const r = process.env.ACPG_FS_ROOT || os.homedir();
  try { return fs.realpathSync(r); } catch { return path.resolve(r); }
})();

// Where uploaded (non-image) composer attachments live — the gateway's own
// private storage, deliberately NOT under FS_ROOT (that's the user's browsable
// project tree; an "uploads" folder in it would pollute their repo).
const UPLOADS_DIR = path.join(cfg.ledgerDir, "uploads");

// realpath a path that may not exist (yet, or at all): walk up to the nearest
// existing ancestor, realpath *that*, then reattach the parts that don't
// exist. A plain fs.realpathSync throws for a missing file, and falling back
// to the un-resolved path there is what broke this: macOS's /tmp is a symlink
// to /private/tmp, so a real, allowed, merely-nonexistent path like
// /tmp/report.png resolved to a form that no longer matched the (realpath'd)
// root — the gateway reported "outside the conversation's project" for a file
// that was never there in the first place, instead of "not found". `..` is
// collapsed by path.resolve() before any of this runs, so a traversal
// attempt is caught the same way it always was.
function realpathLenient(p: string): string {
  const resolved = path.resolve(p);
  try { return fs.realpathSync(resolved); } catch { /* missing — resolve the ancestor instead */ }
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved; // reached the filesystem root
  return path.join(realpathLenient(parent), path.basename(resolved));
}
function resolveWithinRootBase(p: string, root: string): string | null {
  if (!p) return null;
  let safeRoot: string;
  try { safeRoot = fs.realpathSync(root); } catch { safeRoot = path.resolve(root); }
  const abs = realpathLenient(p);
  return abs === safeRoot || abs.startsWith(safeRoot + path.sep) ? abs : null;
}
export function resolveWithinRoot(p: string): string | null {
  return resolveWithinRootBase(p, FS_ROOT);
}
// terminal.ts's general shell needs a cwd to spawn in but must not import the
// FS_ROOT containment policy itself — inject it once, same as
// registerLoginAgent injects the agent allowlist.
setCwdResolver((raw) => resolveWithinRoot(raw) ?? FS_ROOT);

// Directories the file-preview panel may read OUTSIDE the conversation's own
// project. Colon-separated, PATH-style: ACPG_PREVIEW_ROOTS=/tmp:/var/exports
//
// It exists because an agent's output does not always land in the checkout —
// "write the screenshot to /tmp" is an ordinary instruction, and a viewer that
// then refuses to show the file is reporting its own configuration rather than
// the work. Making that an explicit list rather than the default keeps the
// panel's reach something a deployment states out loud: the credential does not
// silently become a read-any-file capability.
const PREVIEW_ROOTS: string[] = (process.env.ACPG_PREVIEW_ROOTS ?? "")
  .split(":")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
// ACPG_PREVIEW_FILTER_ENABLED=0 drops the path filter entirely: the preview then
// reads any file the gateway process can, and ACPG_PREVIEW_ROOTS stops mattering.
// For a single-user gateway on a machine you already own, enumerating roots is
// bookkeeping without a threat it answers. It is off-by-choice, not by default,
// because the trade is real: with it disabled the gateway credential IS a
// read-any-file capability on that host.
const PREVIEW_FILTER_ENABLED = !["0", "off", "false"].includes(
  (process.env.ACPG_PREVIEW_FILTER_ENABLED ?? "1").trim().toLowerCase(),
);
async function listDirs(dir: string) {
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  const out: Array<{ name: string; git: boolean }> = [];
  for (const e of ents) {
    // Include hidden (dot) directories so the folder switcher can browse into
    // them, e.g. .config or .github. (.git is shown too — it's a real folder.)
    if (!e.isDirectory()) continue;
    out.push({ name: e.name, git: fs.existsSync(path.join(dir, e.name, ".git")) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Directories never worth walking for an "@ file" reference: version-control
// metadata and bulky generated/dependency trees that would drown real source
// files (and make the walk expensive). Dotfiles/dotdirs are skipped separately.
const FILE_IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage", ".git",
]);
// Bounds on a single "@ file" walk so a huge tree can't stall the request or
// return an unbounded payload — the menu only shows a handful of matches anyway.
const FILE_WALK_MAX_DEPTH = 8;
const FILE_WALK_MAX_RESULTS = 200;

// Enumerate files under `dir` (already resolved within FS_ROOT) as cwd-relative
// POSIX paths, for the composer's "@ file" picker. Skips dotfiles/dotdirs and
// the ignore set above; an optional case-insensitive substring `query` filters
// by path. Bounded in depth and count. Never escapes `dir` — it only descends.
export async function listFiles(dir: string, query = "", limit = FILE_WALK_MAX_RESULTS): Promise<string[]> {
  const q = query.trim().toLowerCase();
  const out: string[] = [];
  async function walk(cur: string, rel: string, depth: number): Promise<void> {
    if (out.length >= limit) return;
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".")) continue; // dotfiles & dotdirs (incl. .git)
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (FILE_IGNORE_DIRS.has(e.name) || depth >= FILE_WALK_MAX_DEPTH) continue;
        await walk(path.join(cur, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        if (!q || childRel.toLowerCase().includes(q)) out.push(childRel);
      }
    }
  }
  await walk(dir, "", 0);
  // Surface the most relevant first: a basename hit beats a mid-path hit, then
  // shorter (shallower) paths, then alphabetical — so "@app" finds App.tsx fast.
  if (q) {
    out.sort((a, b) => {
      const ab = a.slice(a.lastIndexOf("/") + 1).toLowerCase().includes(q) ? 0 : 1;
      const bb = b.slice(b.lastIndexOf("/") + 1).toLowerCase().includes(q) ? 0 : 1;
      return ab - bb || a.length - b.length || a.localeCompare(b);
    });
  }
  return out;
}

// What the preview panel may read, given the conversation's `cwd`:
//
//   1. anything under `cwd` itself — the project being worked in
//   2. anything under an ACPG_PREVIEW_ROOTS entry — the explicit escape hatch
//   3. anything under the git repo `cwd` sits in — because /workspace/changes
//      lists the whole checkout, so a conversation opened on a subdirectory
//      would otherwise show repo-wide rows it then refused to open
//
// `cwd` is not the client's to choose freely: it is checked against FS_ROOT
// first, exactly as the folder picker is. Without that, a request could name
// `cwd=/` and rule 1 would hand back the filesystem.
//
// Rule 3 costs a `git rev-parse`, so it is only consulted when 1 and 2 have
// already failed — the ordinary case (a file inside the project) never pays for
// it. `resolveWithinRootBase` realpaths both sides, so neither a "../" chain nor
// a symlink out of the tree widens any of the three.
//
// ACPG_PREVIEW_FILTER_ENABLED=0 replaces all three rules with "yes". The path is
// still realpath'd, so `display` below reads the same for symlinks either way.
// The `cwd` → FS_ROOT check in resolveWorkspaceTarget is a separate axis and
// stays on regardless: this toggle governs which FILES are readable, not which
// folders a client may claim to be working in.
async function allowedPreviewPath(abs: string, cwd: string): Promise<string | null> {
  if (!PREVIEW_FILTER_ENABLED) return realpathLenient(abs);
  const direct = resolveWithinRootBase(abs, cwd) ?? PREVIEW_ROOTS.reduce<string | null>(
    (hit, root) => hit ?? resolveWithinRootBase(abs, root), null,
  );
  if (direct) return direct;
  const repo = await repoRoot(cwd);
  return repo ? resolveWithinRootBase(abs, repo) : null;
}

// Folders whose *strict descendants* may be listed whole as output folders. Not
// access grants — allowedPreviewPath still decides what is readable — but the
// answer to "is this folder plausibly this turn's output, or is it somewhere
// everything on the host lives?".
//
// $HOME and the temp dir are here rather than in PREVIEW_ROOTS because the two
// lists answer different questions, and a deployment that widens one must not
// silently widen the other: ACPG_PREVIEW_ROOTS says which files a client may
// read, this says which folders are worth listing. That is also why the temp dir
// is included unconditionally — a gateway running with the path filter off has
// no PREVIEW_ROOTS at all, and without this the feature would quietly do nothing
// on exactly the hosts that opted into reading everything.
const OUTPUT_FOLDER_BOUNDARIES = [os.homedir(), os.tmpdir(), "/tmp"];
// One panel's worth of folders. The client sends candidates derived from the
// thread's own tool calls; a turn that scattered writes across more directories
// than this is not a turn whose output a list can summarise anyway.
const MAX_OUTPUT_FOLDERS = 8;

// Whether `dir` may be listed whole as a folder this conversation wrote into.
// Three gates, and it must pass all of them:
//
//   access    — allowedPreviewPath, exactly as every other /workspace route. A
//               folder whose files the viewer would refuse to open must not be
//               listed either.
//   git       — anything inside the conversation's checkout is refused. There
//               git status is the authority and already reports it; a second
//               source over the top would duplicate every dirty file and drag
//               in build output git deliberately ignores.
//   relevance — it must be a boundary's STRICT descendant, and never a boundary
//               itself. One `Write /tmp/report.html` makes /tmp a folder this
//               conversation "wrote into", and listing that is the host's
//               scratch space rather than this turn's work. Both halves are
//               needed: a preview root under the temp dir would otherwise
//               qualify as a descendant of the temp dir and be listed whole,
//               which is the same mistake one level up. Requiring a strict
//               descendant of *something* also refuses `/Users` for free.
async function allowedOutputFolder(dir: string, cwd: string): Promise<string | null> {
  const abs = await allowedPreviewPath(dir, cwd);
  if (!abs) return null;
  const repo = await repoRoot(cwd);
  if (repo && resolveWithinRootBase(abs, repo)) return null;
  // Resolved through the same function that resolved `abs`, so the comparisons
  // below are between realpath'd values without a second copy of that logic.
  // The filesystem root is dropped: every path is strictly inside it, so
  // ACPG_FS_ROOT=/ would otherwise make every folder on the host an output one.
  const boundaries = [cwd, FS_ROOT, ...PREVIEW_ROOTS, ...OUTPUT_FOLDER_BOUNDARIES]
    .map((b) => resolveWithinRootBase(b, b))
    .filter((b): b is string => !!b && b !== path.parse(b).root);
  if (boundaries.includes(abs)) return null;
  return boundaries.some((b) => abs.startsWith(b + path.sep)) ? abs : null;
}

// Which revision a /workspace request is about: null for the working tree (the
// panel's original and commonest case), a RevSpec for one commit or one branch.
//
// `false` is the third answer and is deliberately not folded into null: a
// request that named a revision we won't accept must be refused, not quietly
// answered with the working tree's diff. That is the difference between "no
// revision asked for" and "the revision asked for is not one we will run".
function revSpecFrom(q: URLSearchParams): RevSpec | null | false {
  const commit = q.get("rev") ?? "";
  const base = q.get("base") ?? "";
  // One diff has one revision. Both set is a client bug, and picking either
  // would show a diff nobody asked for.
  if (commit && base) return false;
  if (commit) return validRev(commit) ? { commit } : false;
  if (base) return validRev(base) ? { base } : false;
  return null;
}

// Resolve a /workspace/* request's target file. `cwd` supplies the git and
// relative-path context and must itself sit inside FS_ROOT; `path` is either
// absolute (how /workspace/changes addresses every file it lists) or
// cwd-relative. Null means "refuse" — a missing parameter or a path outside
// everything allowedPreviewPath permits.
// `rootIsCwd` is for the tree, whose top level has no path to send: an omitted
// `path` there means "the folder this conversation runs in", not "refuse".
async function resolveWorkspaceTarget(q: URLSearchParams, rootIsCwd = false): Promise<{ cwd: string; abs: string; display: string } | null> {
  const cwd = resolveWithinRoot(q.get("cwd") ?? "");
  if (!cwd) return null;
  const raw = q.get("path") ?? "";
  if (!raw && !rootIsCwd) return null;
  const abs = raw
    ? await allowedPreviewPath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw), cwd)
    : cwd;
  if (!abs) return null;
  const rel = path.relative(cwd, abs);
  // Files under cwd read better by their short path; anything else (a sibling
  // package elsewhere in the same repo) keeps its absolute path rather than
  // being shown as a "../../" chain nobody can parse at a glance.
  const display = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
  return { cwd, abs, display };
}

// One JSON request body, capped. Over the cap rejects with "too-large" rather
// than "bad-json" so the caller can answer 413: a client that sent too much can
// act on that, and cannot act on "malformed".
function readJsonBody(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Stop buffering but keep draining: destroying the request mid-upload
      // costs the client its connection and the error response with it.
      if (size > max) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) { reject(new Error("too-large")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("bad-json")); }
    });
    req.on("error", () => reject(new Error("bad-json")));
  });
}

// Raw bytes for one file: the <img> source behind an image preview, and the
// download fallback for everything else.
//
// The content-type is an allowlist, never a guess: this route serves files
// whose contents an agent (or the repo) chose, from the console's *own* origin
// — the origin holding the gateway credential injected into the SPA config. So
// anything that isn't a plain raster image goes out as application/octet-stream
// with an attachment disposition. That, plus nosniff and a deny-everything CSP,
// is what stops an .html or .svg sitting in the checkout from executing script
// against that origin. Text-ish files are still readable — /workspace/file
// returns them as escaped text, which is the view you want anyway.
function serveWorkspaceRaw(res: http.ServerResponse, abs: string): void {
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { res.writeHead(404); res.end(); return; }
  if (!st.isFile()) { res.writeHead(404); res.end(); return; }
  if (st.size > MAX_RAW_BYTES) { res.writeHead(413); res.end(); return; }
  const image = inlineImageType(abs);
  const base = path.basename(abs);
  // Header values are latin1: a filename with CJK or emoji (routine for
  // agent-generated screenshots) would throw ERR_INVALID_CHAR from writeHead.
  // Send an ASCII-folded name for old parsers and the real one via RFC 5987.
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.writeHead(200, {
    "content-type": image ?? "application/octet-stream",
    "content-length": String(st.size),
    "content-disposition": `${image ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
  });
  const stream = fs.createReadStream(abs);
  // Headers are already out, so a mid-read failure can't become a status code —
  // dropping the connection is the only way left to signal a partial body.
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// Server-side state shared across all clients/IPs (favorite folders today).
// Opened lazily on first use, NOT at import: tests import this module with
// ACPG_NO_LISTEN=1 and must not create a SQLite file under the default /data.
let _db: Db | null = null;
function db(): Db {
  if (!_db) _db = new Db(path.join(cfg.ledgerDir, "state.sqlite"));
  return _db;
}

// `tool_result` is internal — used to pair a tool's output/status back onto its
// `tool_use` block (they live on different messages), then stripped before the
// view is sent. The client-facing blocks are only text/thought/tool.
export type ViewBlock = {
  type: "text" | "thought" | "tool" | "tool_result" | "image";
  text?: string; name?: string;
  toolCallId?: string; status?: "completed" | "failed"; output?: string;
  // tool blocks: the files the call acted on, and which ACP kind of act it was.
  // A live turn gets both straight from ACP; a replayed transcript has to have
  // them recovered here, or a resumed conversation shows no files at all.
  locations?: string[]; kind?: string;
  // image blocks: raw base64 in `data` (+ `mimeType`) or a link in `uri`
  mimeType?: string; data?: string; uri?: string;
};
type HistorySessionItem = { sessionId: string; title: string | null; updatedAt: string };
type DiscoveredHistorySessionItem = HistorySessionItem & { cwd: string; source: "claude-cli" | "codex-cli" };
export type ViewMessage = { role: "user" | "assistant"; blocks: ViewBlock[] };
type HistoryMessagesResult = { messages: ViewMessage[]; total: number; start: number; truncated: boolean };

// One page of a transcript. Two modes: `limit` alone gives the tail (what every
// caller wanted before paging existed), while `from`/`to` gives an absolute
// half-open range. Absolute indices are what make paging safe on a running
// conversation — transcripts are append-only, so an index already assigned never
// moves, whereas an offset counted from the tail shifts as messages arrive.
// `start` is the returned page's first index; `start > 0` is how a client knows
// older messages exist.
export const MAX_HISTORY_PAGE = 2000;

export function sliceMessages(
  msgs: ViewMessage[],
  opts: { limit?: number; from?: number; to?: number },
): HistoryMessagesResult {
  const total = msgs.length;
  if (opts.from !== undefined || opts.to !== undefined) {
    const lo = Math.min(Math.max(opts.from ?? 0, 0), total);
    const hi = Math.min(Math.max(opts.to ?? total, lo), Math.min(lo + MAX_HISTORY_PAGE, total));
    return { messages: msgs.slice(lo, hi), total, start: lo, truncated: lo > 0 };
  }
  const limit = opts.limit ?? 0;
  const truncated = limit > 0 && total > limit;
  return {
    messages: truncated ? msgs.slice(-limit) : msgs,
    total,
    start: truncated ? total - limit : 0,
    truncated,
  };
}

// Query-string half of the paging contract. A range is all-or-nothing: if either
// bound is missing or unparseable the request degrades to the plain tail page,
// which is always a safe answer, rather than inventing a bound.
export function historyPageParams(q: URLSearchParams): { limit: number; from?: number; to?: number } {
  const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "120", 10) || 120, 1), MAX_HISTORY_PAGE);
  const rawFrom = q.get("from");
  const rawTo = q.get("to");
  if (rawFrom === null || rawTo === null) return { limit };
  const from = parseInt(rawFrom, 10);
  const to = parseInt(rawTo, 10);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { limit };
  const lo = Math.max(from, 0);
  return { limit, from: lo, to: Math.min(Math.max(to, lo), lo + MAX_HISTORY_PAGE) };
}

// Paging re-reads the same transcript once per page, so hold the parsed result
// against the file's stat. mtime+size changes on every append, so a running
// conversation can never be served a stale tail. Small LRU: the working set is
// "the conversations someone is scrolling through right now".
const HISTORY_PARSE_CACHE_MAX = 8;
const historyParseCache = new Map<string, { mtimeMs: number; size: number; msgs: ViewMessage[] }>();

// Exported for the I3 test: search must never add to or evict from this cache.
export function historyParseCacheSize(): number { return historyParseCache.size; }

async function cachedParse(file: string, parse: () => Promise<ViewMessage[]>): Promise<ViewMessage[]> {
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(file); } catch { return parse(); }
  const hit = historyParseCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    historyParseCache.delete(file);          // re-insert to move it to the LRU tail
    historyParseCache.set(file, hit);
    return hit.msgs;
  }
  const msgs = await parse();
  historyParseCache.delete(file);
  historyParseCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, msgs });
  while (historyParseCache.size > HISTORY_PARSE_CACHE_MAX) {
    const oldest = historyParseCache.keys().next().value;
    if (oldest === undefined) break;
    historyParseCache.delete(oldest);
  }
  return msgs;
}

// Flatten a tool_result's content (string | block array) to text, capped so a
// huge tool output (e.g. a big file read) doesn't bloat the history payload.
function toolResultText(content: unknown): string {
  let s = "";
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = (content as Array<Record<string, unknown>>)
      .map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  s = s.trim();
  const CAP = 4000;
  return s.length > CAP ? s.slice(0, CAP) + "\n… (truncated)" : s;
}

// Claude transcript image blocks carry their bytes under `source`, either
// base64-inlined ({ type: "base64", media_type, data }) or as a URL
// ({ type: "url", url }). Map either to a view image block.
function claudeImageBlock(source: unknown): ViewBlock | null {
  if (!source || typeof source !== "object") return null;
  const s = source as Record<string, unknown>;
  if (s.type === "base64" && typeof s.data === "string" && s.data) {
    return { type: "image", mimeType: typeof s.media_type === "string" ? s.media_type : "image/png", data: s.data };
  }
  if (s.type === "url" && typeof s.url === "string" && s.url) {
    return { type: "image", mimeType: typeof s.media_type === "string" ? s.media_type : "image/png", uri: s.url };
  }
  return null;
}

// Claude Code expands a slash command (e.g. `/model default`) into internal
// wrapper markup inside the user message — <command-name>/<command-args>/
// <command-message> for the invocation, <local-command-stdout>/
// <local-command-stderr> for its output, and a <system-reminder> plus a plain
// "Caveat:" line telling the model to ignore it. The CLI hides this, but it
// otherwise rides through the gateway and renders as a fake "user" message
// (markdown escapes the tags, so they show as literal text). Strip these known
// wrapper blocks wherever we normalize content so they never reach the client,
// while leaving genuine user angle-bracket text untouched.
const COMMAND_WRAPPER_TAGS = "command-name|command-args|command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder";
const COMMAND_WRAPPER_BLOCK = new RegExp(`<(${COMMAND_WRAPPER_TAGS})>[\\s\\S]*?<\\/\\1>`, "g");
const COMMAND_CAVEAT = /Caveat: The messages below were generated by the user while running local commands\. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to\.?/g;
export function stripCommandMarkup(text: string): string {
  return text.replace(COMMAND_WRAPPER_BLOCK, "").replace(COMMAND_CAVEAT, "").trim();
}

// A live turn's tool call arrives over ACP already carrying `kind` and
// `locations`. A transcript carries neither — only the CLI's own tool name and
// its raw input — so replaying one has to recover both, or a resumed
// conversation reports that it touched no files at all.
//
// Mapping the name to the ACP kind here rather than in the client keeps one
// vocabulary on the wire: every consumer downstream sees "edit"/"read", never
// "Edit"/"Read".
const CLAUDE_TOOL_KINDS: Record<string, string> = {
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Read: "read", NotebookRead: "read",
  Glob: "search", Grep: "search", WebSearch: "search",
  Bash: "execute", BashOutput: "execute", KillShell: "execute",
  WebFetch: "fetch",
  Task: "think", TodoWrite: "think",
};
// The input keys Claude's file tools name their target with. Deliberately a
// fixed list: a tool whose input merely *contains* a path-looking string (Bash's
// `command`) has not told us which file it touched, and guessing one would put
// files in the panel that the agent never wrote.
const TOOL_PATH_KEYS = ["file_path", "notebook_path", "path"];

function toolInputLocations(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const rec = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of TOOL_PATH_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

function normalizeContent(content: unknown): ViewBlock[] {
  const out: ViewBlock[] = [];
  if (typeof content === "string") {
    const stripped = stripCommandMarkup(content);
    if (stripped) out.push({ type: "text", text: stripped });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string" && b.text) { const t = stripCommandMarkup(b.text); if (t) out.push({ type: "text", text: t }); }
    else if (b.type === "image") { const img = claudeImageBlock(b.source); if (img) out.push(img); }
    else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) out.push({ type: "thought", text: b.thinking });
    else if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "tool";
      const locations = toolInputLocations(b.input);
      out.push({
        type: "tool", name, toolCallId: typeof b.id === "string" ? b.id : undefined,
        kind: CLAUDE_TOOL_KINDS[name] ?? "other",
        ...(locations.length ? { locations } : {}),
      });
    }
    else if (b.type === "tool_result") out.push({ type: "tool_result", toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined, status: b.is_error ? "failed" : "completed", output: toolResultText(b.content) });
  }
  return out;
}

async function claudeTranscriptSummary(file: string): Promise<{ cwd: string | null; title: string | null; entrypoint: string | null }> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let cwd: string | null = null;
  let title: string | null = null;
  let entrypoint: string | null = null;
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let e: { type?: string; isSidechain?: boolean; cwd?: unknown; entrypoint?: unknown; message?: { content?: unknown } };
      try { e = JSON.parse(t); } catch { continue; }
      if (!cwd && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
      // Rides along with cwd (the CLI writes both on the same entries) and is
      // deliberately NOT part of the exit condition below: transcripts written
      // before the CLI recorded it would then be streamed to EOF every time.
      if (!entrypoint && typeof e.entrypoint === "string" && e.entrypoint) entrypoint = e.entrypoint;
      if (!title && e.type === "user" && !e.isSidechain) {
        const blocks = normalizeContent(e.message?.content);
        const txt = blocks.find((b) => b.type === "text")?.text;
        if (txt && txt.trim()) title = txt.trim().replace(/\s+/g, " ").slice(0, 80);
      }
      if (cwd && title) {
        rl.close();
        break;
      }
    }
  } catch {
    /* ignore */
  }
  return { cwd, title, entrypoint };
}

// A transcript's recency must come from its CONTENT, not its file mtime. Claude
// Code rewrites transcripts without appending a turn (trailing `system` entries
// like away_summary / turn_duration / stop_hook_summary, and the `last-prompt`
// bookkeeping line), so mtime moves while the conversation stands still: rows
// showed "27s ago" for week-old sessions AND — because the same mtime drove the
// `slice(limit)` cut — phantom-touched sessions evicted genuinely-recent ones
// from the list entirely. Both the ranking and the cut below use the derived
// activity instead, cached per transcript so an unchanged file costs zero reads.

// The tail is read in chunks and scanned backwards; a transcript can be tens of
// MB, so it is never read whole (the head scan for cwd/title stops early too).
const TAIL_CHUNK_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

type ClaudeEntryHead = { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: unknown };

// The timestamp of an entry that counts as conversation activity: a real user
// prompt or an assistant turn. `system` (away_summary, turn_duration, …),
// `attachment` and `last-prompt` (which carries no timestamp at all) are
// bookkeeping the CLI writes on its own — exactly the noise that makes mtime
// untrustworthy. Normalized to a comparable ISO instant.
function claudeActivityAt(e: ClaudeEntryHead): string | null {
  const real = e.type === "assistant" || (e.type === "user" && e.isSidechain !== true && e.isMeta !== true);
  if (!real || typeof e.timestamp !== "string") return null;
  const ms = Date.parse(e.timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Last real turn in a transcript, found by scanning its tail backwards. Expands
// the window (doubling) when a tail holds nothing but bookkeeping, then gives up
// rather than dragging a huge file through memory.
async function claudeLastActivityAt(file: string, size: number): Promise<string | null> {
  if (size <= 0) return null;
  for (let chunk = TAIL_CHUNK_BYTES; ; chunk = Math.min(chunk * 2, TAIL_MAX_BYTES)) {
    const start = Math.max(0, size - chunk);
    let text: string;
    try {
      const fh = await fs.promises.open(file, "r");
      try {
        const buf = Buffer.alloc(size - start);
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally { await fh.close(); }
    } catch { return null; }
    const lines = text.split("\n");
    if (start > 0) lines.shift(); // started mid-file: the first line is a fragment
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      let e: ClaudeEntryHead;
      try { e = JSON.parse(t) as ClaudeEntryHead; } catch { continue; }
      const at = claudeActivityAt(e);
      if (at) return at;
    }
    if (start === 0 || chunk >= TAIL_MAX_BYTES) return null; // whole file (or the cap) scanned
  }
}

// The transcript cache lives in the shared prefs DB. Resolved once per listing so
// an unopenable store (no writable ledger dir — e.g. a test that only imports
// this module) degrades to deriving everything from the files.
function transcriptStore(injected?: Db): Db | null {
  if (injected) return injected;
  try { return db(); } catch { return null; }
}

type ClaudeTranscriptMeta = { cwd: string | null; title: string | null; lastActivityAt: string | null; entrypoint: string | null };

// One transcript's metadata, re-deriving only what can have changed. An unchanged
// (file, size, mtime) triple is a full hit: no file is opened at all. Otherwise
// the tail is rescanned for the last turn, while cwd/title — immutable per
// session — are read from the head only when the cache has never recorded them
// ("" records "scanned, none found": a title-less transcript has no early exit,
// so re-deriving it would stream the whole file on every rewrite).
async function claudeTranscriptMeta(
  sessionId: string, file: string, size: number, mtimeMs: number, store: Db | null,
): Promise<ClaudeTranscriptMeta> {
  let row: TranscriptMeta | null = null;
  try { row = store?.transcriptMeta(sessionId) ?? null; } catch { /* cache miss */ }
  const sameFile = !!row && row.file === file;
  if (row && sameFile && row.size === size && row.mtimeMs === mtimeMs) {
    return { cwd: row.cwd || null, title: row.title || null, lastActivityAt: row.lastActivityAt, entrypoint: row.entrypoint || null };
  }
  const head = row && sameFile && row.title !== null
    ? { cwd: row.cwd, title: row.title, entrypoint: row.entrypoint }
    : await claudeTranscriptSummary(file);
  const lastActivityAt = await claudeLastActivityAt(file, size);
  try {
    store?.saveTranscriptMeta({
      sessionId, file, cwd: head.cwd ?? "", title: head.title ?? "",
      entrypoint: head.entrypoint ?? "", lastActivityAt, size, mtimeMs,
    });
  } catch { /* the cache is an optimization, never a hard dependency */ }
  return { cwd: head.cwd || null, title: head.title || null, lastActivityAt, entrypoint: head.entrypoint || null };
}

// The newer of two ISO instants, either of which may be missing or unparseable.
// Never returns something the ranking below can't compare.
function laterIso(a: string | null, b: string | null): string | null {
  const am = a ? Date.parse(a) : NaN;
  const bm = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(am)) return Number.isFinite(bm) ? b : null;
  if (!Number.isFinite(bm)) return a;
  return bm > am ? b : a;
}

// Turn traffic the gateway pumped itself, merged into the transcript recency
// below: sessions driven only through the gateway are the half the CLI's own
// files may not have caught up with, so the DB is their only fresh source.
function lastMessageAts(store: Db | null): Map<string, string> {
  try { return store?.lastMessageAtBySession() ?? new Map(); } catch { return new Map(); }
}

// Rank by real conversation activity, newest first; a transcript with none sorts
// after every transcript that has some. mtime breaks ties WITHIN a rank but is
// never a rank of its own — that is the seam the phantom touches came through.
type ClaudeRecency = { recencyAt: string | null; mtime: number };
function byClaudeRecency(a: ClaudeRecency, b: ClaudeRecency): number {
  const am = a.recencyAt ? Date.parse(a.recencyAt) : -Infinity;
  const bm = b.recencyAt ? Date.parse(b.recencyAt) : -Infinity;
  if (am !== bm) return bm - am;
  return b.mtime - a.mtime;
}

// One transcript as the search and discovery paths both see it: located, with
// the cwd it records and its REAL last activity.
//
// `mtime` does NOT mean the same thing on both producers, and only the claude
// arm holds the invariant byClaudeRecency describes:
//   - claudeTranscriptCandidates: a tiebreak WITHIN a recencyAt rank, never a
//     rank of its own — that is the seam the phantom touches came through.
//   - codexTranscriptCandidates: `recencyAt` is session_index.jsonl's
//     `updated_at` and nothing else, and most rollouts have no index entry at
//     all (measured on one real corpus: 459 of 567, 81%). For those, mtime is
//     the last-resort rank AND — new with /history/search — the sole since/until
//     bound, so a bulk touch of ~/.codex would both reorder them and move them
//     in and out of a date filter, exactly as one did to ~/.claude. That is the
//     seam to close if it ever happens.
// The tempting swap is not the fix: all 567 of those rollouts do carry a head
// timestamp, but it is the session's START time, so substituting it wholesale
// would rank a conversation that ran for hours by when it began. Closing this
// properly means each rollout's LAST timestamped line — the codex equivalent of
// what claudeTranscriptMeta already derives — which stage A deliberately does
// not pay for on every session on disk.
type TranscriptCandidate = {
  sessionId: string; file: string; cwd: string | null; title: string | null;
  recencyAt: string | null; mtime: number; source: "claude-cli" | "codex-cli";
};

// A `claude -p` (or `codex exec`) run writes a transcript per invocation, so a
// cron job that summarizes ten podcasts leaves ten one-shot conversations — each
// in its own throwaway cwd, each its own folder in the sidebar. That is machine
// traffic, not something anyone had a conversation in, so the listings skip it by
// default; ACPG_HISTORY_HEADLESS=on lists it like any other session.
//
// "sdk-cli" is exactly the `-p` entrypoint. The interactive CLI writes "cli", and
// the SDK — including the ACP adapter the gateway itself drives — writes
// "sdk-ts", so a headless SDK script is indistinguishable from the gateway's own
// sessions and stays visible. A transcript with no entrypoint at all (written
// before the CLI recorded it) is likewise kept: unknown is not headless.
// codexMetaFromLine reads codex's counterpart off its own head line.
const isHeadlessEntrypoint = (entrypoint: string | null) => entrypoint === "sdk-cli";
// Read per call, not once at import: tests toggle it, and it costs nothing.
const headlessIncluded = () =>
  ["1", "on", "true"].includes((process.env.ACPG_HISTORY_HEADLESS ?? "").trim().toLowerCase());

async function claudeTranscriptCandidates(projectsRoot: string, store: Db | null): Promise<TranscriptCandidate[]> {
  let projects: fs.Dirent[];
  try { projects = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); } catch { return []; }

  const files: Array<{ sessionId: string; file: string; size: number; mtime: number }> = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsRoot, project.name);
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("agent-")) continue;
      const file = path.join(dir, entry.name);
      try {
        const st = await fs.promises.stat(file);
        files.push({ sessionId: entry.name.replace(/\.jsonl$/, ""), file, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* ignore */ }
    }
  }

  const messaged = lastMessageAts(store);
  const includeHeadless = headlessIncluded();
  const out: TranscriptCandidate[] = [];
  for (const f of files) {
    const meta = await claudeTranscriptMeta(f.sessionId, f.file, f.size, f.mtime, store);
    if (!includeHeadless && isHeadlessEntrypoint(meta.entrypoint)) continue;
    out.push({
      sessionId: f.sessionId, file: f.file, cwd: meta.cwd, title: meta.title,
      recencyAt: laterIso(meta.lastActivityAt, messaged.get(f.sessionId) ?? null),
      mtime: f.mtime, source: "claude-cli",
    });
  }
  return out;
}

export async function discoverClaudeHistory(opts?: { projectsRoot?: string; fsRoot?: string; limit?: number; store?: Db }): Promise<DiscoveredHistorySessionItem[]> {
  const projectsRoot = opts?.projectsRoot ?? path.join(CLAUDE_DIR, "projects");
  const fsRoot = opts?.fsRoot ?? FS_ROOT;
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 200);
  const store = transcriptStore(opts?.store);

  // Resolve every candidate's activity BEFORE ranking: the sort and the limit cut
  // have to agree on one value, or a phantom-touched transcript still evicts a
  // genuinely-recent session. Cheap in steady state — unchanged files are cached.
  const metas = await claudeTranscriptCandidates(projectsRoot, store);
  metas.sort(byClaudeRecency);

  const out: DiscoveredHistorySessionItem[] = [];
  const seen = new Set<string>();
  for (const m of metas) {
    if (out.length >= limit) break;
    if (!m.cwd) continue;
    // The cwd may come from the cache, so it is guarded here (not at derive time).
    const cwd = resolveWithinRootBase(m.cwd, fsRoot);
    if (!cwd) continue;
    const key = cwd + "\n" + m.sessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sessionId: m.sessionId,
      title: m.title,
      // No derivable activity: fall back to mtime so the client still renders a date.
      updatedAt: m.recencyAt ?? new Date(m.mtime).toISOString(),
      cwd,
      source: "claude-cli",
    });
  }
  // Renames override the derived title here exactly as they do in
  // listClaudeHistory — one sidecar read per surviving folder, after the limit
  // cut. Leaving this out was a real bug, not a missing nicety: discovery feeds
  // the sidebar's cross-folder Recent list, so a conversation the user had
  // renamed came back wearing the first-prompt title it was renamed away from.
  const customByCwd = new Map<string, Record<string, string>>();
  for (const cwd of new Set(out.map((s) => s.cwd))) customByCwd.set(cwd, await readTitles(cwd, projectsRoot));
  for (const s of out) s.title = customByCwd.get(s.cwd)?.[s.sessionId] ?? s.title;
  return out;
}

async function listClaudeHistory(cwd: string, limit: number, projectsRoot?: string, store?: Db): Promise<HistorySessionItem[]> {
  const dir = (await findClaudeProjectDir(cwd, projectsRoot)) ?? path.join(projectsRoot ?? claudeProjectsRoot(), encodeProjectPath(cwd));
  let files: string[];
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const cache = transcriptStore(store);
  const messaged = lastMessageAts(cache);
  const includeHeadless = headlessIncluded();
  const sess = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  const metas = (await Promise.all(
    sess.map(async (f) => {
      const fp = path.join(dir, f);
      let st: fs.Stats;
      try { st = await fs.promises.stat(fp); } catch { return null; }
      const sessionId = f.replace(/\.jsonl$/, "");
      const mtime = Math.round(st.mtimeMs);
      const meta = await claudeTranscriptMeta(sessionId, fp, st.size, mtime, cache);
      return { sessionId, mtime, ...meta, recencyAt: laterIso(meta.lastActivityAt, messaged.get(sessionId) ?? null) };
    }),
  )).filter((m): m is NonNullable<typeof m> => !!m)
    .filter((m) => includeHeadless || !isHeadlessEntrypoint(m.entrypoint));
  const top = metas.sort(byClaudeRecency).slice(0, limit);
  const custom = await readTitles(cwd, projectsRoot); // custom (renamed) titles override the derived one
  return top.map((m) => ({
    sessionId: m.sessionId,
    title: custom[m.sessionId] ?? m.title,
    updatedAt: m.recencyAt ?? new Date(m.mtime).toISOString(),
  }));
}

// Claude Code injects these as user-role text when a turn is interrupted — one
// per pending tool call, so a single cancel of a parallel-tool turn writes a
// whole run of them. They are bookkeeping, not something the user typed (the CLI
// hides them), so drop them from the rendered thread.
const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

async function parseClaudeHistoryMessages(file: string, sessionId: string): Promise<ViewMessage[]> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const msgs: ViewMessage[] = [];
  const toolById = new Map<string, ViewBlock>(); // pair tool_result output/status onto its tool_use block
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let e: { type?: string; isSidechain?: boolean; sessionId?: string; message?: { role?: string; content?: unknown } };
    try { e = JSON.parse(t); } catch { continue; }
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain) continue;
    if (e.sessionId && sessionId && e.sessionId !== sessionId) continue;
    const role = e.message?.role === "assistant" ? "assistant" : e.message?.role === "user" ? "user" : null;
    if (!role) continue;
    const blocks: ViewBlock[] = [];
    for (const b of normalizeContent(e.message?.content)) {
      if (b.type === "tool_result") {
        const tool = b.toolCallId ? toolById.get(b.toolCallId) : undefined;
        if (tool) { tool.status = b.status; if (b.output) tool.output = b.output; }
        continue; // paired onto the tool_use block above; not a standalone view block
      }
      if (role === "user" && b.type === "text" && typeof b.text === "string" && INTERRUPT_MARKERS.has(b.text.trim())) continue;
      if (b.type === "tool" && b.toolCallId) toolById.set(b.toolCallId, b);
      blocks.push(b);
    }
    if (!blocks.length) continue; // skip tool-result-only / empty turns
    msgs.push({ role, blocks });
  }
  return msgs;
}

export async function readClaudeHistoryMessages(file: string, sessionId: string, limit: number): Promise<HistoryMessagesResult> {
  return sliceMessages(await parseClaudeHistoryMessages(file, sessionId), { limit });
}

type CodexIndexEntry = { id: string; thread_name?: string; updated_at?: string };
type CodexSessionFile = { id: string; cwd: string; file: string; updatedAt: string; isSubagent: boolean; isHeadless: boolean };

async function readCodexIndex(): Promise<Map<string, CodexIndexEntry>> {
  const out = new Map<string, CodexIndexEntry>();
  let raw = "";
  try { raw = await fs.promises.readFile(codexIndexFile(), "utf8"); } catch { return out; }
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<CodexIndexEntry>;
      if (typeof o.id === "string") out.set(o.id, { id: o.id, thread_name: o.thread_name, updated_at: o.updated_at });
    } catch { /* ignore corrupt index lines */ }
  }
  return out;
}

async function readFirstJsonLine(file: string): Promise<Record<string, unknown> | null> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try { return JSON.parse(t) as Record<string, unknown>; } catch { return null; }
    }
  } catch { return null; }
  return null;
}

function isSubagentCodexPayload(payload: Record<string, unknown>): boolean {
  const source = payload.source;
  const legacyMarker = source !== null && typeof source === "object" && !Array.isArray(source)
    && Object.prototype.hasOwnProperty.call(source, "subagent");
  return legacyMarker || payload.thread_source === "subagent";
}

function codexMetaFromLine(line: Record<string, unknown> | null): { id: string; cwd: string; timestamp?: string; isSubagent: boolean; isHeadless: boolean } | null {
  const payload = line?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.cwd === "string"
    ? {
      id: p.id,
      cwd: p.cwd,
      timestamp: typeof p.timestamp === "string" ? p.timestamp : undefined,
      isSubagent: isSubagentCodexPayload(p),
      // `codex exec` — codex's `claude -p`. The TUI writes "cli" and the ACP
      // adapter the gateway drives writes "vscode", so neither is caught; a
      // rollout whose `source` is the object form (the subagent shape
      // isSubagentCodexPayload reads) or missing entirely counts as
      // not-headless, same as Claude's.
      isHeadless: p.source === "exec",
    }
    : null;
}

function dateValue(value: string | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

async function listJsonlFilesRecursively(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listJsonlFilesRecursively(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

async function codexSessionFileFromPath(file: string): Promise<CodexSessionFile | null> {
  const meta = codexMetaFromLine(await readFirstJsonLine(file));
  if (!meta) return null;
  let mtime = "";
  try { mtime = new Date((await fs.promises.stat(file)).mtimeMs).toISOString(); } catch { /* ignore */ }
  return {
    id: meta.id, cwd: meta.cwd, file, updatedAt: mtime || meta.timestamp || "",
    isSubagent: meta.isSubagent, isHeadless: meta.isHeadless,
  };
}

async function listCodexArchivedSessions(): Promise<CodexSessionFile[]> {
  let files: string[];
  try { files = await fs.promises.readdir(codexArchivedDir()); } catch { return []; }
  const out: CodexSessionFile[] = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const file = path.join(codexArchivedDir(), f);
    const session = await codexSessionFileFromPath(file);
    if (session) out.push(session);
  }
  return out;
}

async function listCodexActiveSessions(): Promise<CodexSessionFile[]> {
  const files = await listJsonlFilesRecursively(codexSessionsDir());
  const sessions = await Promise.all(files.map(codexSessionFileFromPath));
  return sessions.filter((s): s is CodexSessionFile => !!s);
}

async function listCodexSessionFiles(): Promise<CodexSessionFile[]> {
  const [archived, active] = await Promise.all([listCodexArchivedSessions(), listCodexActiveSessions()]);
  const byId = new Map<string, CodexSessionFile>();
  for (const s of [...archived, ...active]) {
    const existing = byId.get(s.id);
    if (!existing) {
      byId.set(s.id, s);
      continue;
    }
    const newer = dateValue(s.updatedAt) >= dateValue(existing.updatedAt) ? s : existing;
    byId.set(s.id, {
      ...newer,
      isSubagent: existing.isSubagent || s.isSubagent,
      isHeadless: existing.isHeadless || s.isHeadless,
    });
  }
  return [...byId.values()];
}

// The one gate both codex listings route through — the per-folder list and the
// discovery/search walk — so the headless cut lands in the same place the
// subagent cut already does.
function isUserVisibleCodexSession(session: CodexSessionFile): boolean {
  if (session.isSubagent) return false;
  return !session.isHeadless || headlessIncluded();
}

function sameCwd(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isSyntheticCodexUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("# AGENTS.md instructions for ") || trimmed.startsWith("<environment_context>");
}

function normalizeCodexContent(content: unknown, opts: { skipSyntheticUserText?: boolean } = {}): ViewBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ViewBlock[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== "object") continue;
    if ((b.type === "input_text" || b.type === "output_text" || b.type === "text") && typeof b.text === "string" && b.text) {
      if (opts.skipSyntheticUserText && isSyntheticCodexUserText(b.text)) continue;
      out.push({ type: "text", text: b.text });
    } else if (b.type === "input_image" || b.type === "image") {
      const img = codexImageBlock(b);
      if (img) out.push(img);
    }
  }
  return out;
}

// Codex image blocks carry an `image_url` (commonly a data: URL, sometimes a
// remote link). Split a data URL into mimeType + base64; keep a link as a uri.
function codexImageBlock(b: Record<string, unknown>): ViewBlock | null {
  const url = typeof b.image_url === "string" ? b.image_url
    : (b.image_url && typeof b.image_url === "object" && typeof (b.image_url as Record<string, unknown>).url === "string"
      ? (b.image_url as Record<string, string>).url : "");
  if (!url) return null;
  const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (m) return { type: "image", mimeType: m[1] || "image/png", data: m[2] };
  return { type: "image", mimeType: "image/png", uri: url };
}

function codexReasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return (summary as Array<Record<string, unknown>>)
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function firstCodexUserText(file: string): Promise<string | null> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let e: { type?: string; payload?: { type?: string; role?: string; content?: unknown } };
      try { e = JSON.parse(t); } catch { continue; }
      if (e.type !== "response_item" || e.payload?.type !== "message" || e.payload.role !== "user") continue;
      const txt = normalizeCodexContent(e.payload.content, { skipSyntheticUserText: true }).find((b) => b.type === "text")?.text;
      if (txt && txt.trim()) {
        rl.close();
        return txt.trim().replace(/\s+/g, " ").slice(0, 80);
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function listCodexHistory(cwd: string, limit: number): Promise<HistorySessionItem[]> {
  const [index, sessions] = await Promise.all([readCodexIndex(), listCodexSessionFiles()]);
  const custom = await readTitles(cwd);
  const matching = sessions
    .filter((s) => isUserVisibleCodexSession(s) && sameCwd(s.cwd, cwd))
    .map((s) => ({ ...s, index: index.get(s.id) }))
    .sort((a, b) => dateValue(b.index?.updated_at || b.updatedAt) - dateValue(a.index?.updated_at || a.updatedAt))
    .slice(0, limit);
  return Promise.all(matching.map(async (s) => ({
    sessionId: s.id,
    title: custom[s.id] ?? s.index?.thread_name ?? (await firstCodexUserText(s.file)),
    updatedAt: s.index?.updated_at ?? s.updatedAt,
  })));
}

// Codex's own recency lives in session_index.jsonl. CodexSessionFile.updatedAt
// is mtime-derived, so it is the fallback only — same rule as I1. `thread_name`
// comes from the same index read, so it is free; what is NOT derived here is the
// firstCodexUserText fallback, which streams a rollout. Paying that per session
// on disk is the difference between a listing and reading a gigabyte.
async function codexTranscriptCandidates(): Promise<TranscriptCandidate[]> {
  const [index, sessions] = await Promise.all([readCodexIndex(), listCodexSessionFiles()]);
  return sessions.filter(isUserVisibleCodexSession).map((s) => ({
    sessionId: s.id, file: s.file, cwd: s.cwd,
    title: index.get(s.id)?.thread_name ?? null,
    recencyAt: index.get(s.id)?.updated_at ?? null,
    mtime: dateValue(s.updatedAt), source: "codex-cli" as const,
  }));
}

// Codex counterpart to discoverClaudeHistory: every rollout on disk, whatever
// folder it belongs to. listCodexSessionFiles already recovers each session's
// cwd from its rollout head — listCodexHistory only filters that down to one
// cwd — so discovery is the same walk minus the sameCwd cut, plus the FS_ROOT
// guard that normal history browsing gets from validating ?cwd=.
//
// Titles are derived AFTER the limit cut, deliberately: firstCodexUserText
// streams a rollout until it finds a real (non-synthetic) user message, and
// paying that for every session on disk instead of the <=limit that survive is
// the difference between a listing and reading into a gigabyte of transcripts.
export async function discoverCodexHistory(opts?: { fsRoot?: string; limit?: number }): Promise<DiscoveredHistorySessionItem[]> {
  const fsRoot = opts?.fsRoot ?? FS_ROOT;
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 200);

  const candidates = await codexTranscriptCandidates();
  const within: TranscriptCandidate[] = [];
  for (const c of candidates) {
    const cwd = c.cwd ? resolveWithinRootBase(c.cwd, fsRoot) : null;
    if (!cwd) continue;
    within.push({ ...c, cwd });
  }
  const top = within
    .sort((a, b) => (dateValue(b.recencyAt ?? undefined) || b.mtime) - (dateValue(a.recencyAt ?? undefined) || a.mtime))
    .slice(0, limit);

  // One readTitles per distinct surviving folder rather than per session.
  const customByCwd = new Map<string, Record<string, string>>();
  for (const cwd of new Set(top.map((s) => s.cwd as string))) customByCwd.set(cwd, await readTitles(cwd));

  return Promise.all(top.map(async (s) => ({
    sessionId: s.sessionId,
    title: customByCwd.get(s.cwd as string)?.[s.sessionId] ?? s.title ?? (await firstCodexUserText(s.file)),
    updatedAt: s.recencyAt ?? new Date(s.mtime).toISOString(),
    cwd: s.cwd as string,
    source: "codex-cli" as const,
  })));
}

export type SearchCandidate = {
  sessionId: string; file: string; cwd: string; title: string | null;
  source: "claude-cli" | "codex-cli"; agentName: string; recencyMs: number;
};

export type SearchScope = { projectsRoot?: string; fsRoot?: string; store?: Db; cwd?: string | null };

// Providers whose conversations can be searched. opencode is out for the same
// reason it is out of DISCOVERABLE_PROVIDERS: no transcript to recover a cwd
// from, and the FS_ROOT guard on message content depends on having one.
const SEARCHABLE_PROVIDERS: HistoryProvider[] = ["claude", "codex"];

// Stage A. Every searchable transcript, with the cwd it records and its REAL
// last activity, filtered and ordered. Nothing here opens a transcript for its
// content — that is stage B, and it only ever sees candidates that survived the
// FS_ROOT guard below.
export async function searchCandidates(
  agents: Array<{ name: string; cmd: string }>,
  params: SearchQuery,
  opts?: SearchScope,
): Promise<{ candidates: SearchCandidate[]; skipped: string[] }> {
  const fsRoot = opts?.fsRoot ?? FS_ROOT;
  const store = transcriptStore(opts?.store);
  const wanted = params.agents ? new Set(params.agents) : null;

  // One agent name per provider — a provider's store is the same store whichever
  // configured agent you came in under (agents.example.json ships two claudes).
  // So with no ?agent= filter, results are attributed to whichever agent is first
  // in cfg.agents for that provider. That is deliberate and matches
  // deleteHistorySession's reasoning: an agent name says where a conversation was
  // seen from, it does not identify the conversation.
  const agentByProvider = new Map<HistoryProvider, string>();
  const skipped = new Set<string>();
  for (const a of agents) {
    if (wanted && !wanted.has(a.name)) continue;
    const provider = historyProviderFor(a.cmd);
    if (!provider) continue;
    if (!SEARCHABLE_PROVIDERS.includes(provider)) { skipped.add(provider); continue; }
    if (!agentByProvider.has(provider)) agentByProvider.set(provider, a.name);
  }

  const raw: TranscriptCandidate[] = [];
  if (agentByProvider.has("claude")) {
    raw.push(...await claudeTranscriptCandidates(opts?.projectsRoot ?? claudeProjectsRoot(), store));
  }
  if (agentByProvider.has("codex")) {
    raw.push(...await codexTranscriptCandidates());
  }

  const candidates: SearchCandidate[] = [];
  for (const c of raw) {
    // Scoped to one conversation: every other candidate is dropped before its
    // cwd is even resolved, so the scan reads exactly one file.
    if (params.sessionId && c.sessionId !== params.sessionId) continue;
    // I2: the cwd the transcript itself records, guarded before the file is read.
    if (!c.cwd) continue;
    const cwd = resolveWithinRootBase(c.cwd, fsRoot);
    if (!cwd) continue;
    if (opts?.cwd && !sameCwd(cwd, opts.cwd)) continue;

    // I1: bound on real activity; mtime is only the fallback when there is none.
    const parsed = c.recencyAt ? Date.parse(c.recencyAt) : NaN;
    const recencyMs = Number.isFinite(parsed) ? parsed : c.mtime;
    if (params.sinceMs !== null && recencyMs < params.sinceMs) continue;
    if (params.untilMs !== null && recencyMs > params.untilMs) continue;
    if (params.cursor && !afterCursor(params.cursor, { recencyMs, sessionId: c.sessionId })) continue;

    candidates.push({
      sessionId: c.sessionId, file: c.file, cwd, title: c.title, source: c.source,
      agentName: agentByProvider.get(c.source === "claude-cli" ? "claude" : "codex") ?? "",
      recencyMs,
    });
  }

  // Shared with afterCursor above, not restated here: the filter and the sort
  // must agree on "sorts after" or a resumed scan repeats or skips sessions.
  candidates.sort(bySearchOrder);
  return { candidates, skipped: [...skipped] };
}

// Wall-clock ceiling for one search. A server constant, never a query parameter:
// a client must not be able to ask the gateway for a 60-second scan.
export const SEARCH_BUDGET_MS = 2000;

export type SearchResultSession = {
  sessionId: string; source: "claude-cli" | "codex-cli"; agentName: string;
  cwd: string; title: string | null; updatedAt: string;
  hitCount: number; hits: SearchHit[];
};

export type SearchResponse = {
  results: SearchResultSession[]; truncated: boolean; cursor: string | null;
  skipped: string[]; scanned: { files: number; bytes: number; ms: number };
};

// Stage C parses directly instead of through cachedParse: historyParseCache holds
// 8 entries for the conversation someone is scrolling RIGHT NOW, and one search
// would flush it. This cache is request-scoped and dies with the response (I3).
async function parseForSearch(c: SearchCandidate, cache: Map<string, ViewMessage[]>): Promise<ViewMessage[]> {
  const hit = cache.get(c.file);
  if (hit) return hit;
  const msgs = c.source === "claude-cli"
    ? await parseClaudeHistoryMessages(c.file, c.sessionId)
    : await parseCodexHistoryMessages(c.file);
  cache.set(c.file, msgs);
  return msgs;
}

export async function searchTranscripts(
  agents: Array<{ name: string; cmd: string }>,
  params: SearchQuery,
  opts?: SearchScope & { budgetMs?: number; clock?: () => number },
): Promise<SearchResponse> {
  const { candidates, skipped } = await searchCandidates(agents, params, opts);
  const budgetMs = opts?.budgetMs ?? SEARCH_BUDGET_MS;
  const clock = opts?.clock ?? (() => Date.now());
  const startedAt = clock();

  // Stage B probe. The query goes through the same UTF-8 → latin1 mapping the
  // file bytes do, so a CJK term still lines up; latin1 + /i can only be MORE
  // permissive than a true match, so it yields false positives, never misses.
  const probe = params.query.probe
    ? new RegExp(escapeRegExp(Buffer.from(params.query.probe, "utf8").toString("latin1")), "i")
    : null;

  const results: SearchResultSession[] = [];
  const parsed = new Map<string, ViewMessage[]>();
  let files = 0, bytes = 0, examined = 0;
  let last: SearchCandidate | null = null;

  for (const c of candidates) {
    if (results.length >= params.limit || clock() - startedAt >= budgetMs) break;
    examined++;
    last = c;

    let buf: Buffer;
    try { buf = await fs.promises.readFile(c.file); } catch { continue; }
    files++; bytes += buf.length;
    if (probe && !probe.test(buf.toString("latin1"))) continue;

    const { hits, hitCount } = findHits(await parseForSearch(c, parsed), params.query,
      { role: params.role ?? undefined, max: params.sessionId ? MAX_HITS_IN_SESSION : undefined });
    if (hitCount === 0) continue;

    results.push({
      sessionId: c.sessionId, source: c.source, agentName: c.agentName, cwd: c.cwd,
      title: c.title, updatedAt: new Date(c.recencyMs).toISOString(), hitCount, hits,
    });
  }

  // Titles are resolved only for sessions that actually matched: firstCodexUserText
  // streams a rollout, and readTitles hits the disk once per folder. Paying either
  // per candidate instead of per result is the difference between a search and a
  // full read of the corpus.
  const customByCwd = new Map<string, Record<string, string>>();
  for (const cwd of new Set(results.map((r) => r.cwd))) customByCwd.set(cwd, await readTitles(cwd));
  for (const r of results) {
    if (r.title === null && r.source === "codex-cli") {
      const file = candidates.find((c) => c.sessionId === r.sessionId)?.file;
      if (file) r.title = await firstCodexUserText(file);
    }
    r.title = customByCwd.get(r.cwd)?.[r.sessionId] ?? r.title;
  }

  const truncated = examined < candidates.length;
  return {
    results,
    truncated,
    cursor: truncated && last ? encodeCursor({ recencyMs: last.recencyMs, sessionId: last.sessionId }) : null,
    skipped,
    scanned: { files, bytes, ms: Math.round(clock() - startedAt) },
  };
}

async function findCodexSessionFile(cwd: string, sessionId: string): Promise<CodexSessionFile | null> {
  const sessions = await listCodexSessionFiles();
  return sessions.find((s) => s.id === sessionId && sameCwd(s.cwd, cwd)) ?? null;
}

// Delete a codex conversation: unlink its rollout file (active or archived).
// session_index.jsonl is deliberately left alone — listCodexHistory walks the
// filesystem and only joins the index onto files it found, so an index entry
// with no rollout is already invisible. Rewriting that append-only file would be
// far riskier than the stale line it removes.
async function deleteCodexSession(sessionId: string, opts?: DeleteHistoryOpts): Promise<boolean> {
  const session = await findCodexSessionFileById(sessionId);
  if (!session || !allowedCwd(session.cwd, opts)) return false;
  try { await fs.promises.unlink(session.file); } catch { return false; }
  await clearTitleIn(projectDirFor(session.cwd), sessionId);
  return true;
}

async function parseCodexHistoryMessages(file: string): Promise<ViewMessage[]> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const msgs: ViewMessage[] = [];
  const toolById = new Map<string, ViewBlock>();
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let e: { type?: string; payload?: Record<string, unknown> };
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type !== "response_item" || !e.payload) continue;
    const p = e.payload;
    if (p.type === "message") {
      const role = p.role === "assistant" ? "assistant" : p.role === "user" ? "user" : null;
      if (!role) continue;
      const blocks = normalizeCodexContent(p.content, { skipSyntheticUserText: role === "user" });
      if (blocks.length) msgs.push({ role, blocks });
    } else if (p.type === "function_call") {
      const callId = typeof p.call_id === "string" ? p.call_id : undefined;
      const block: ViewBlock = { type: "tool", name: typeof p.name === "string" ? p.name : "tool", toolCallId: callId };
      if (callId) toolById.set(callId, block);
      msgs.push({ role: "assistant", blocks: [block] });
    } else if (p.type === "function_call_output") {
      const callId = typeof p.call_id === "string" ? p.call_id : undefined;
      const tool = callId ? toolById.get(callId) : undefined;
      if (tool) {
        tool.status = "completed";
        if (p.output !== undefined) tool.output = toolResultText(p.output);
      }
    } else if (p.type === "reasoning") {
      const text = codexReasoningText(p.summary);
      if (text) msgs.push({ role: "assistant", blocks: [{ type: "thought", text }] });
    }
  }
  return msgs;
}

// Locate a Codex rollout by session id alone. Unlike findCodexSessionFile, this
// ignores cwd — the id is a globally unique UUID, and the repair below runs even
// when the session/load request didn't carry a cwd to match against.
async function findCodexSessionFileById(sessionId: string): Promise<CodexSessionFile | null> {
  const sessions = await listCodexSessionFiles();
  return sessions.find((s) => s.id === sessionId) ?? null;
}

// Codex tool-call payload types. A rollout pairs each call with one
// `<call>_output` sharing its call_id; an unpaired trailing call is the
// signature of a mid-tool-call interruption.
const CODEX_TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

// A Codex session killed between *issuing* a tool call (e.g. apply_patch) and
// *recording its result* leaves the rollout ending on a function_call /
// custom_tool_call with no matching `*_output`. On `resume` the model is handed
// an unfinished tool invocation it must reconcile, so it sits on "thinking"
// indefinitely (issue #61). codex-acp reads the rollout from disk on
// session/load (restore_session → replay_history) without sanitizing it, so we
// trim that incomplete tail here, before the load is forwarded.
//
// This mirrors Codex's own posture — its fix for the stuck-on-resume class of
// bug marks incomplete turns interrupted / drops them rather than fabricating a
// result (openai/codex#14125), and the documented workaround for #12382 is to
// trim the rollout JSONL back to the last complete boundary. We do the same: cut
// everything after the last *settled* conversational item (an assistant/user
// `message` or a tool `*_output`), discarding the dangling call, any reasoning
// that led into it, and trailing event lines. No data is fabricated.
//
// Conservative by design: only acts when the *final* response item is itself a
// tool call still missing its output (the precise mid-tool-call interruption).
// A healthy rollout ending on a message/output is left untouched. Idempotent —
// after the trim the last item is a settled one, so a re-run is a no-op.
// Returns true iff the rollout was trimmed.
export async function repairInterruptedCodexRollout(file: string): Promise<boolean> {
  let raw: string;
  try { raw = await fs.promises.readFile(file, "utf8"); } catch { return false; }

  // Physical lines, dropping the single empty tail a trailing newline produces.
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const outputCallIds = new Set<string>();
  let lastResponseType = "";
  let lastResponseCallId = "";
  let firstResponseIdx = -1;
  let anchorIdx = -1; // index of the last settled item (message / *_output)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let e: { type?: string; payload?: Record<string, unknown> };
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type !== "response_item" || !e.payload) continue;
    if (firstResponseIdx < 0) firstResponseIdx = i;
    const p = e.payload;
    const ptype = typeof p.type === "string" ? p.type : "";
    const callId = typeof p.call_id === "string" ? p.call_id : "";
    lastResponseType = ptype;
    lastResponseCallId = callId;
    if (ptype.endsWith("_output")) { if (callId) outputCallIds.add(callId); anchorIdx = i; }
    else if (ptype === "message") anchorIdx = i;
  }

  if (!CODEX_TOOL_CALL_TYPES.has(lastResponseType) || !lastResponseCallId || outputCallIds.has(lastResponseCallId))
    return false;

  // Keep through the last settled item; if there is none, keep only the leading
  // preamble (session_meta / turn_context) before the first response item.
  const cutAfter = anchorIdx >= 0 ? anchorIdx : firstResponseIdx - 1;
  const kept = lines.slice(0, cutAfter + 1);
  await fs.promises.writeFile(file, kept.length ? kept.join("\n") + "\n" : "");
  return true;
}

// Find and trim the rollout for a Codex session about to be resumed. Best
// effort: a missing file or read/write error is swallowed (logged) so a resume
// is never blocked by repair — at worst it falls back to the old hang.
export async function repairInterruptedCodexSession(sessionId: string): Promise<boolean> {
  try {
    const found = await findCodexSessionFileById(sessionId);
    if (!found) return false;
    return await repairInterruptedCodexRollout(found.file);
  } catch (e) {
    console.warn(`codex rollout repair failed for ${sessionId}:`, e);
    return false;
  }
}

// ---- opencode -----------------------------------------------------------
// opencode does not use a single append-only JSONL (claude/codex do); it keeps
// the conversation in opencode.db, so the reader aggregates SQL rows:
// session metadata -> the session's message rows -> each message's part rows.
// `hasMessages` is derived (not an opencode field): opencode persists a session
// row the moment a `session/new` arrives, before any prompt, so the history list
// uses it to hide the empty sessions an eager client leaves behind.
type OpenCodeSessionInfo = {
  id?: string; projectID?: string; directory?: string; parentID?: string;
  title?: string; time?: { created?: number; updated?: number }; hasMessages?: boolean;
};
type OpenCodeMessageInfo = { id?: string; sessionID?: string; role?: string; time?: { created?: number } };
type OpenCodeToolState = { status?: string; output?: string; error?: string };
type OpenCodePart = {
  id?: string; type?: string; text?: string;
  tool?: string; callID?: string; state?: OpenCodeToolState;
  mime?: string; url?: string; filename?: string;
};

function parseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

// Every top-level session, returned in the reader's existing shape. The SQLite
// store keeps session fields as columns; message/part payloads (queried below)
// stay as JSON in their `data` column.
function listOpenCodeSessions(): OpenCodeSessionInfo[] {
  return withOpenCodeDb((db) => {
    const rows = db.prepare(
      `SELECT s.id, s.parent_id, s.directory, s.title, s.time_created, s.time_updated,
              EXISTS(SELECT 1 FROM message m WHERE m.session_id = s.id) AS has_messages
       FROM session s`,
    ).all() as Array<{
      id: string; parent_id: string | null; directory: string | null;
      title: string | null; time_created: number | null; time_updated: number | null;
      has_messages: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      directory: r.directory ?? undefined,
      parentID: r.parent_id ?? undefined,
      title: r.title ?? undefined,
      time: { created: r.time_created ?? undefined, updated: r.time_updated ?? undefined },
      hasMessages: !!r.has_messages,
    }));
  }, []);
}

// Earliest user message's first text part — the title fallback when a session has
// no derived title yet.
function firstOpenCodeUserText(sessionId: string): string | null {
  return withOpenCodeDb((db) => {
    const msgs = db.prepare(
      "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    ).all(sessionId) as Array<{ id: string; data: string }>;
    const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id");
    for (const m of msgs) {
      if (parseJson<OpenCodeMessageInfo>(m.data)?.role !== "user") continue;
      for (const p of partStmt.all(m.id) as Array<{ data: string }>) {
        const part = parseJson<OpenCodePart>(p.data);
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return part.text.trim().replace(/\s+/g, " ").slice(0, 80);
        }
      }
    }
    return null;
  }, null);
}

async function listOpenCodeHistory(cwd: string, limit: number): Promise<HistorySessionItem[]> {
  const custom = await readTitles(cwd);
  const matching = listOpenCodeSessions()
    // Skip child (sub-agent) sessions, and the empty session rows opencode writes
    // on every `session/new` before a prompt is ever sent — neither is a real
    // user conversation.
    .filter((s) => !s.parentID && s.hasMessages && typeof s.directory === "string" && sameCwd(s.directory, cwd))
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, limit);
  return matching.map((s) => {
    const id = s.id as string;
    const derived = s.title && s.title.trim() ? s.title.trim() : null;
    return {
      sessionId: id,
      title: custom[id] ?? derived ?? firstOpenCodeUserText(id),
      updatedAt: s.time?.updated ? new Date(s.time.updated).toISOString() : "",
    };
  });
}

// opencode tool parts are self-contained (each carries its own completed/error
// state with output), so unlike claude/codex there's no cross-message pairing.
function openCodeFileBlock(part: OpenCodePart): ViewBlock | null {
  const mime = typeof part.mime === "string" ? part.mime : "";
  const url = typeof part.url === "string" ? part.url : "";
  if (!mime.startsWith("image/") || !url) return null; // only images render; other files are skipped
  const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (m) return { type: "image", mimeType: m[1] || mime, data: m[2] };
  return { type: "image", mimeType: mime, uri: url };
}

function openCodePartBlock(part: OpenCodePart): ViewBlock | null {
  switch (part.type) {
    case "text":
      return part.text && part.text.trim() ? { type: "text", text: part.text } : null;
    case "reasoning":
      return part.text && part.text.trim() ? { type: "thought", text: part.text } : null;
    case "tool": {
      const st = part.state ?? {};
      const status = st.status === "completed" ? "completed" : st.status === "error" ? "failed" : undefined;
      const raw = st.status === "completed" ? st.output : st.status === "error" ? st.error : undefined;
      return {
        type: "tool",
        name: typeof part.tool === "string" ? part.tool : "tool",
        toolCallId: typeof part.callID === "string" ? part.callID : undefined,
        status,
        output: raw ? toolResultText(raw) : undefined,
      };
    }
    case "file":
      return openCodeFileBlock(part);
    default:
      return null; // step-start/step-finish/snapshot/patch/agent carry nothing to render
  }
}

function parseOpenCodeHistoryMessages(sessionId: string): ViewMessage[] {
  return withOpenCodeDb((db) => {
    const out: ViewMessage[] = [];
    const messages = db.prepare(
      "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    ).all(sessionId) as Array<{ id: string; data: string }>;
    const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id");
    for (const m of messages) {
      const info = parseJson<OpenCodeMessageInfo>(m.data);
      const role = info?.role === "assistant" ? "assistant" : info?.role === "user" ? "user" : null;
      if (!role) continue;
      const blocks: ViewBlock[] = [];
      for (const p of partStmt.all(m.id) as Array<{ data: string }>) {
        const part = parseJson<OpenCodePart>(p.data);
        const b = part ? openCodePartBlock(part) : null;
        if (b) blocks.push(b);
      }
      if (blocks.length) out.push({ role, blocks });
    }
    return out;
  }, [] as ViewMessage[]);
}

// Delete an opencode conversation. Unlike claude/codex there is no file to
// unlink — the conversation is rows across three tables, so all of it goes in
// one transaction (part -> message -> session, children first since nothing
// enforces the FKs). Sub-agent sessions (parent_id) go with their parent: the
// reader hides them, so leaving them behind would orphan rows nothing can reach.
function deleteOpenCodeSession(sessionId: string): boolean {
  return withOpenCodeDbWrite((db) => {
    const kids = db.prepare("SELECT id FROM session WHERE parent_id = ?").all(sessionId) as Array<{ id: string }>;
    const ids = [sessionId, ...kids.map((k) => k.id)];
    const holes = ids.map(() => "?").join(",");
    const run = db.transaction((targets: string[]) => {
      db.prepare(`DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id IN (${holes}))`).run(...targets);
      db.prepare(`DELETE FROM message WHERE session_id IN (${holes})`).run(...targets);
      return db.prepare(`DELETE FROM session WHERE id IN (${holes})`).run(...targets).changes;
    });
    return run(ids) > 0;
  }, false);
}

export async function listAgentHistory(cmd: string, cwd: string, limit: number, opts?: { projectsRoot?: string; store?: Db }): Promise<HistorySessionItem[]> {
  const provider = historyProviderFor(cmd);
  if (provider === "claude") return listClaudeHistory(cwd, limit, opts?.projectsRoot, opts?.store);
  if (provider === "codex") return listCodexHistory(cwd, limit);
  if (provider === "opencode") return listOpenCodeHistory(cwd, limit);
  return [];
}

export async function readAgentHistoryMessages(
  cmd: string,
  cwd: string,
  sessionId: string,
  limit: number,
  opts?: { projectsRoot?: string; from?: number; to?: number },
): Promise<HistoryMessagesResult | null> {
  const page = { limit, from: opts?.from, to: opts?.to };
  const provider = historyProviderFor(cmd);
  if (provider === "claude") {
    // Resolve via the computed path first, then by session id anywhere under
    // the projects root — see findClaudeSessionFile for why the computed name
    // alone 404s transcripts that exist (CLI long-path truncation, stale cwd).
    const base = opts?.projectsRoot ?? claudeProjectsRoot();
    const file = await findClaudeSessionFile(cwd, sessionId, base);
    if (!file || !file.startsWith(base + path.sep)) return null;
    return sliceMessages(await cachedParse(file, () => parseClaudeHistoryMessages(file, sessionId)), page);
  }
  if (provider === "codex") {
    const found = await findCodexSessionFile(cwd, sessionId);
    if (!found) return null;
    return sliceMessages(await cachedParse(found.file, () => parseCodexHistoryMessages(found.file)), page);
  }
  if (provider === "opencode") {
    // Scope to the requesting cwd: the id is globally unique, but confirm the
    // session's project directory matches so one cwd can't read another's thread.
    const sessions = listOpenCodeSessions();
    const found = sessions.find((s) => s.id === sessionId && typeof s.directory === "string" && sameCwd(s.directory, cwd));
    if (!found) return null;
    return sliceMessages(parseOpenCodeHistoryMessages(sessionId), page);
  }
  return null;
}

async function deleteFromProvider(provider: HistoryProvider, sessionId: string, opts?: DeleteHistoryOpts): Promise<boolean> {
  if (provider === "claude") return deleteClaudeSession(sessionId, opts);
  if (provider === "codex") return deleteCodexSession(sessionId, opts);
  const found = listOpenCodeSessions().find((s) => s.id === sessionId);
  if (!found || !allowedCwd(found.directory, opts)) return false;
  return deleteOpenCodeSession(sessionId);
}

// Cheapest lookup first, because this walks providers until one claims the id.
// claude is a readdir; opencode is one indexed query; codex has to read the head
// of every rollout on disk, so it goes last.
const PROVIDER_DELETE_ORDER: HistoryProvider[] = ["claude", "opencode", "codex"];

// Permanently delete one conversation from whichever agent store holds it, given
// the commands of the configured agents. Neither an agent name nor a cwd is taken
// from the caller, and that is the point:
//   cwd   — the claude lookup falls back to an id scan across project dirs, so a
//           supplied cwd never bounded anything. The FS_ROOT check now runs
//           against the cwd the conversation itself records (`withinRoot`).
//   agent — two agents can share one provider AND its transcript store
//           (agents.example.json ships "claude" and "claude-infra"), so an agent
//           name doesn't identify a conversation, it only says where it was seen
//           from. Deleting one is the same operation whichever name you came in
//           under, and the gateway-side cleanup has to span all of them anyway.
// Only the providers actually configured are tried, so a host without opencode
// never touches its DB. Returns false when no configured provider has the id, the
// conversation lives outside `withinRoot`, or the store refused (opencode DB
// locked) — the caller still clears the gateway-side records either way, so a
// half-present conversation can always be tidied away.
export async function deleteHistorySession(cmds: string[], sessionId: string, opts?: DeleteHistoryOpts): Promise<boolean> {
  const configured = new Set(cmds.map(historyProviderFor).filter((p): p is HistoryProvider => p !== null));
  for (const provider of PROVIDER_DELETE_ORDER) {
    if (!configured.has(provider)) continue;
    if (await deleteFromProvider(provider, sessionId, opts)) return true;
  }
  return false;
}

// ----------------------------------------------------------------- agent ----
// Spawns an ACP agent and gateways its stdio. claude-agent-acp reuses the host's
// existing `claude` login (~/.claude); the gateway passes the env through as-is.
class Agent {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  // Pending respawn after an exit/spawn-failure; cleared on kill() so a dead
  // (or never-spawnable) agent doesn't keep the process alive or come back.
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  // An agent must stay alive at least this long before we consider it healthy
  // and clear the backoff. A process that spawns but exits immediately never
  // reaches this threshold, so its restarts keep accumulating and back off.
  private static readonly HEALTHY_UPTIME_MS = 15000;
  constructor(
    private profile: AgentProfile,
    private onLine: (frame: Buffer) => void,
    private onExit?: () => void,
  ) {
    this.start();
  }
  private start() {
    const env = { ...process.env };
    console.log(
      `agent: spawning ${this.profile.cmd} ${this.profile.args.join(" ")} (cwd=${this.profile.cwd})`,
    );
    const proc = spawn(this.profile.cmd, this.profile.args, {
      cwd: this.profile.cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
      // Own process group (the adapter becomes group leader): the per-session CLI
      // children it spawns inherit the group, so kill() can take the whole tree
      // down at once instead of orphaning them. stdio stays piped, so the gateway
      // still drives the adapter and a gateway exit still closes its stdin (which
      // the adapter treats as EOF → dispose → exit) — detached only changes the
      // group, not the pipe lifetime.
      detached: true,
    });
    this.proc = proc;
    // A failed spawn emits "error" with no "exit"; a normal run emits "exit"
    // with no "error". Either way we tear down once and back off — this guard
    // keeps a single process from scheduling two respawns if both ever fire.
    let settled = false;
    const respawn = () => {
      if (settled) return;
      settled = true;
      // Only null out the live proc if it's still THIS proc — a manual
      // restart() may have already swapped in a fresh replacement via
      // start(); killing that one too would make the gateway flap.
      if (this.proc === proc) this.proc = null;
      if (this.healthyTimer) {
        clearTimeout(this.healthyTimer);
        this.healthyTimer = null;
      }
      // A respawned agent loses in-memory ACP sessions; client should
      // session/load to resume (claude-agent-acp persists under ~/.claude).
      // Any prompts that were in flight died with the process.
      this.onExit?.();
      if (this.stopped) return;
      // If a manual restart() already swapped in a fresh proc, don't
      // schedule another one — the replacement is up. Without this guard
      // the backoff respawn would orphan the live replacement 2s later.
      if (this.proc && this.proc !== proc) return;
      const delay = Math.min(1000 * 2 ** this.restarts++, 15000);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, delay);
    };
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      if (line.length) this.onLine(Buffer.from(line, "utf8"));
    });
    proc.on("spawn", () => {
      // Reset backoff only once the agent has proven it can stay alive; a
      // process that exits before this fires keeps its accumulated restarts.
      this.healthyTimer = setTimeout(() => {
        this.restarts = 0;
        this.healthyTimer = null;
      }, Agent.HEALTHY_UPTIME_MS);
      this.healthyTimer.unref?.();
    });
    // A bad agent profile (missing cmd, ENOENT, EACCES) makes spawn emit an
    // "error" event. Node treats an unhandled ChildProcess "error" as fatal
    // and would take down the whole gateway, so we must listen for it and treat
    // it like any other agent failure: surface it and retry the channel with
    // backoff while other agents keep running.
    proc.on("error", (err) => {
      console.error(
        `agent: failed to spawn ${this.profile.cmd}: ${err instanceof Error ? err.message : err}; respawning`,
      );
      respawn();
    });
    proc.on("exit", (code, sig) => {
      console.error(`agent: exited code=${code} sig=${sig}; respawning`);
      respawn();
    });
  }
  send(frame: Buffer) {
    const p = this.proc;
    if (p && p.stdin && p.stdin.writable) {
      p.stdin.write(frame);
      p.stdin.write("\n");
    } else {
      console.warn("agent: dropped client frame (agent not ready)");
    }
  }
  kill() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }
    const proc = this.proc;
    if (!proc || proc.pid === undefined) return;
    const pid = proc.pid;
    // Signal the whole process group (negative pid) so the adapter's per-session
    // CLI children die with it instead of orphaning. Fall back to the lone process
    // if the group is already gone. SIGTERM lets the adapter dispose gracefully;
    // escalate to SIGKILL for anything that ignores it.
    const signalGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-pid, sig); } catch { try { proc.kill(sig); } catch { /* already dead */ } }
    };
    signalGroup("SIGTERM");
    const force = setTimeout(() => signalGroup("SIGKILL"), 1500);
    force.unref?.();
  }
  // Bounce the subprocess so a fresh one re-reads credentials (e.g. after an
  // interactive re-login). Unlike kill(), this leaves `stopped` false, so the
  // existing exit handler respawns it; if it's currently between respawns,
  // it's already on its way back. Resets the backoff since this is intentional.
  restart() {
    if (this.stopped) return;
    this.restarts = 0;
    if (this.restartTimer) {
      // Pull a pending backoff respawn forward to now.
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.start();
      return;
    }
    if (!this.proc) return; // nothing to bounce
    // The original SIGTERM-and-let-respawn-do-it path was leaving a 2-second
    // backoff window in which the broadcast _gateway/agent_restart client
    // reconnect was sending `initialize` to a dead process (backoff delay =
    // 1000 * 2^(this.restarts++) = 2000ms after a fresh restart()). Worse, the
    // OLD process's exit handler would fire AFTER start() and call respawn()
    // which `this.proc = null`s the freshly-spawned replacement. We swap
    // the live proc out, start the replacement, then SIGKILL the old one
    // (group kill so any child tree dies too). The old proc's exit handler
    // is still wired to a respawn() closure, but `proc` is no longer it —
    // and crucially, the old respawn() will run onExit, drain idmux, and
    // broadcast _gateway/agent_restart, which is the side effect we
    // actually want (so clients learn the agent is gone). It then short-
    // circuits the backoff respawn because `this.proc` is now proc#2.
    const old = this.proc;
    this.proc = null;
    let replaced: ChildProcess | null = null;
    let startErr: unknown = null;
    try {
      this.start();
      replaced = this.proc;
    } catch (e) {
      startErr = e;
    } finally {
      // ALWAYS kill the old proc, even if start() threw (e.g. ENOENT) — if
      // we left the old one alive, it would be an orphan with no exit
      // handler ever wired (we already nulled this.proc), leaking the
      // process and its child tree.
      if (old.pid !== undefined) {
        try { process.kill(-old.pid, "SIGKILL"); } catch { try { old.kill("SIGKILL"); } catch { /* already dead */ } }
      }
      if (startErr) {
        // Roll back so the gateway keeps the previous agent alive; the normal
        // crash backoff (respawn on exit) will retry from there. Restoring
        // old is critical: without it this.proc === null and nothing would
        // ever restart the channel.
        this.proc = old;
        console.error(`agent: restart() failed to spawn replacement, kept old: ${String(startErr)}`);
      }
    }
  }
}

// --------------------------------------------------------------- channel ----
export interface Conn { id: string; sink: ClientSink; }

interface AgentLike { send(frame: Buffer): void; kill(): void; restart(): void; }

// A session is "active" while its prompt turn is running, "awaiting-input" while
// the agent is blocked on a permission request (it needs the user before it can
// continue). Both count as running; the badge surfaces them.
export type TaskState = "active" | "awaiting-input";
// cwd is the folder the session runs in, captured from session/new|load|prompt.
// It lets a device that never opened the session locally still show the right
// folder and jump accurately — without it, a cross-device task can only show a
// short id and can't be reopened precisely.
export interface RunningTask { sessionId: string; state: TaskState; cwd?: string; title?: string; }
// The concatenated text of a prompt's text blocks (trimmed). Used both to mirror
// a prompt to other viewers and — capped — to label its running task.
function promptText(params: unknown): string {
  const blocks = (params as { prompt?: unknown } | undefined)?.prompt;
  if (!Array.isArray(blocks)) return "";
  const joined = blocks
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text"
      ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
  return stripCommandMarkup(joined);
}
// --- idle session reaping ---------------------------------------------------
// claude-agent-acp / codex-acp spawn one backing CLI per ACP session and keep it
// alive for the session's lifetime (no protocol "end a turn" reaps it — only
// session/close does). Nothing in the gateway used to send session/close, so every
// session a client ever opened leaked a `claude`/`codex` subprocess until the
// adapter exited. To bound that, the gateway keeps at most MAX_LIVE_SESSIONS live
// sessions per agent (LRU) and reaps any session idle for SESSION_IDLE_TTL_MS.
// Reaping sends ACP session/close (claude/codex: closeSession → teardownSession →
// abort the query → kill the CLI). The conversation is not lost — it persists on
// disk, so a later client frame transparently re-loads it via session/load.
const MAX_LIVE_SESSIONS = Math.max(1, Number(process.env.ACPG_MAX_LIVE_SESSIONS) || 5);
// Exported so the reaping tests can probe the window between the two TTLs rather
// than hardcode wall-clock numbers that a config change would silently invalidate.
export const SESSION_IDLE_TTL_MS = Math.max(10_000, Number(process.env.ACPG_SESSION_IDLE_TTL_MS) || 180_000);
// Completion is detected from the prompt's response (precise, immediate); the TTL
// only bounds how long /running keeps advertising a turn whose response never
// arrived at all — the agent died between heartbeats, or a Codex reply forked a
// fresh session and abandoned this one. "awaiting-input" never expires by TTL: a
// human can take any amount of time to answer, so it clears only when the user
// cancels the turn, the agent resumes (a fresh frame), the turn ends (response),
// or the agent exits.
//
// This value is NOT load-bearing for reaping. `promptsInFlight`/`pendingPerms` are
// what reapIdle and firstEvictable consult, precisely because they cannot be
// retracted by a clock; leaning on `tasks` is what let the reaper tear down live
// turns. Keeping it above SESSION_IDLE_TTL_MS (hence declared after it) is now
// only about not lying in the UI: a silently running turn — one `xcodebuild test`
// emits no ACP frames for minutes — should still show as running. The margin is
// deliberately small, because a turn that really is dead also lingers this long as
// a phantom bolt badge, and /history/session refuses to delete the conversation
// with 409 "conversation is running" for the whole window.
export const TASK_TTL_MS = SESSION_IDLE_TTL_MS + 60_000;
// Gateway-originated requests (the reaping session/close, the transparent
// session/load, and the control re-apply below) carry a fake origin conn id so
// their agent response/replay routes to no real connection and is harmlessly
// dropped. Distinct ids so logs can tell which path a stray frame came from.
const CLOSE_SENTINEL = "__gw_close__";
const REVIVE_SENTINEL = "__gw_revive__";
const CONTROL_SENTINEL = "__gw_control__";

// --- session controls across a rebuilt session ------------------------------
// claude-agent-acp keeps a session's mode/model/effort/agent in the adapter's
// memory only — the transcript is written to disk, these are not. So a session
// that left memory (reaped above, LRU-evicted, adapter restarted, or its
// session-defining params changed) comes back from `session/load` at its
// DEFAULTS, silently discarding what the user chose. No client can repair that on
// its own: a revive's load response routes to a sentinel and is dropped, so the
// client never even sees it, and several clients each re-applying their own
// last-known values would fight each other. The gateway therefore remembers the
// values it saw a client set and puts them back after a load, before anything
// else reaches the rebuilt session.
//
// Also persisted (session_controls in state.sqlite), because a gateway restart is
// exactly when the memory is needed: it takes every adapter session with it, and
// the next session/load rebuilds one from disk at its defaults — with the values
// the conversation was running gone from memory, only the table still knows them.
//
// Recorded from the first control snapshot a session reports, not just from what a
// client explicitly set: a conversation nobody ever switched by hand still ran on
// SOMETHING, and resuming it onto whatever the CLI's global config now says is the
// same silent change this whole mechanism exists to prevent.
//
// How long to wait for the adapter to acknowledge one re-applied control. A
// re-apply holds that session's parked frames, and a prompt held forever is worse
// than a prompt that runs in the wrong mode, so the wait is bounded and the frames
// go through either way. Read per call so tests can shorten it.
const controlAckTimeoutMs = (): number =>
  Math.max(50, Number(process.env.ACPG_CONTROL_ACK_TIMEOUT_MS) || 5_000);

// The two ways a client sets a session control. The adapter models mode as a
// config option too, so `session/set_mode` is recorded under the same `mode` id
// and both paths stay comparable.
function controlOf(method: string, params: unknown): { configId: string; value: string } | null {
  const p = (params ?? {}) as { configId?: unknown; value?: unknown; modeId?: unknown };
  if (method === "session/set_mode" && typeof p.modeId === "string") {
    return { configId: "mode", value: p.modeId };
  }
  if (method === "session/set_config_option" && typeof p.configId === "string" && typeof p.value === "string") {
    return { configId: p.configId, value: p.value };
  }
  return null;
}

// What a session/load (or session/set_config_option) result says this session's
// controls currently are, and which values it will accept. `null` when the result
// carries no control information at all (an agent with neither concept, or a bare
// `{ sessionId }`) — nothing to compare against means nothing to re-apply.
function controlSnapshot(result: unknown): {
  values: Map<string, string>;
  allowed: Map<string, Set<string>>;
  // Ids the result described ONLY as a mode, which must go back via
  // session/set_mode — session/set_config_option would be an unknown method there.
  viaSetMode: Set<string>;
} | null {
  const r = (result ?? {}) as { configOptions?: unknown; modes?: { currentModeId?: unknown; availableModes?: unknown } };
  const values = new Map<string, string>();
  const allowed = new Map<string, Set<string>>();
  const viaSetMode = new Set<string>();
  let sawAny = false;
  // `modes` first so that an agent reporting both has its configOptions win — and
  // the mode go back the way the client set it.
  if (r.modes && typeof r.modes === "object") {
    sawAny = true;
    if (typeof r.modes.currentModeId === "string") values.set("mode", r.modes.currentModeId);
    if (Array.isArray(r.modes.availableModes)) {
      allowed.set("mode", new Set(r.modes.availableModes
        .map((m) => (m as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string")));
    }
    viaSetMode.add("mode");
  }
  if (Array.isArray(r.configOptions)) {
    sawAny = true;
    for (const raw of r.configOptions) {
      const o = raw as { id?: unknown; currentValue?: unknown; options?: unknown };
      if (typeof o.id !== "string") continue;
      if (typeof o.currentValue === "string") values.set(o.id, o.currentValue);
      if (Array.isArray(o.options)) {
        // Options may be grouped (a group carries its own `options` array).
        const flat = o.options.flatMap((c) => {
          const g = c as { options?: unknown };
          return Array.isArray(g.options) ? g.options : [c];
        });
        allowed.set(o.id, new Set(flat
          .map((c) => (c as { value?: unknown }).value)
          .filter((v): v is string => typeof v === "string")));
      }
      viaSetMode.delete(o.id);
    }
  }
  return sawAny ? { values, allowed, viaSetMode } : null;
}

// Re-apply order. Switching model rebuilds the effort options and can clamp mode
// back to default (the adapter's own reconciliation), so it goes first and the
// rest is applied on top of the settled list instead of against it.
const controlRank = (configId: string): number => (configId === "model" ? 0 : configId === "mode" ? 1 : 2);

type PromptRequestMethod = "session/request_permission" | "elicitation/create";
type PendingPrompt = {
  sid: string;
  seq: number;
  frame: Buffer;
  method: PromptRequestMethod;
};

// One running agent + its ledger + the set of connections attached to it.
// Routes agent↔client frames: notifications broadcast to all conns; responses
// go point-to-point via id rewriting; agent→client requests (permission) go to
// the conns viewing that session, first-reply-wins.
class Channel {
  agent: AgentLike;
  ledger: Ledger;
  conns = new Map<string, Conn>();
  private idmux = new IdMux();
  private subs = new Subscriptions();
  private permGate = new OnceGate();
  // While a session/load is in flight, the agent replays that session's history
  // as session/update notifications. Those would otherwise broadcast to every
  // device and duplicate the history on devices already showing it. Gate them to
  // the loading connection only (which suppresses replay client-side) until the
  // load response returns. sessionId -> loading connId; gateway req id -> sessionId.
  private loadGate = new Map<string, string>();
  private loadReq = new Map<number, string>();
  // sessionId -> in-flight prompt task. Populated when a session/prompt is
  // forwarded, refreshed by each agent frame for that session, and cleared when
  // the prompt's response returns (or by TTL / agent exit as a fallback).
  private tasks = new Map<string, { state: TaskState; lastSeen: number }>();
  // The reaper's durable evidence that a turn is genuinely still running:
  // gateway req id -> the session whose session/prompt is unanswered, plus the
  // per-session count. `tasks` cannot carry this — running() TTL-prunes it, and a
  // turn that is merely quiet (one `xcodebuild test` emits no ACP frames for
  // minutes) then looks finished to the reaper. These move only on the prompt's
  // own response, a session/cancel, the session closing, or the agent exiting.
  // Keyed by gateway id rather than by connection on purpose: idmux.forgetConn
  // drops a departed client's entries, so the response for a client that left
  // mid-turn arrives with no origin — this map still resolves it and releases the
  // session, which is the one case a conn-keyed record would pin forever.
  private promptReq = new Map<number, string>();
  private promptsInFlight = new Map<string, number>();
  // sessionId -> the cwd it runs in. Captured from session/new (paired on its
  // response, since the id isn't known until then), session/load, and any prompt
  // that carries a cwd. Surfaced in running() so cross-device tasks show the
  // correct folder and jump precisely. Cleared with tasks on agent exit.
  private sessionCwd = new Map<string, string>();
  // sessionId -> the text of its first prompt, used as the running-task label so
  // concurrent tasks in the same folder don't all collapse to a short id.
  private sessionTitle = new Map<string, string>();
  // agent request id -> the still-outstanding blocking prompt (its session, raw
  // frame, and which method it was: session/request_permission or
  // elicitation/create). A prompt blocks the agent until someone answers, but a
  // client that drops (or reloads) reconnects at cursor=end and never sees the
  // original frame again. Re-delivered after that session's session/load so the
  // prompt survives reconnects; dropped once answered or when the agent exits.
  private pendingPerms = new Map<number | string, PendingPrompt>();
  // The `initialize` handshake is per-PROCESS, but one agent process is shared
  // across every client connection. codex-acp answers `initialize` exactly once
  // and returns -32603 "Already initialized" on any later one, so a reconnect /
  // reload / second tab would leave that client's init rejected (agentReady never
  // flips, the composer's send button stays greyed). The gateway therefore owns
  // the handshake: forward the FIRST client initialize, cache its result, and
  // answer every later initialize from that cache without touching the agent.
  // `initForwarded` guards the window between forwarding the first one and its
  // response landing; clients that ask during it park in `initWaiters`. All reset
  // on agent exit so the respawned (fresh, uninitialized) process re-handshakes.
  private initResult: Record<string, unknown> | null = null;
  private initForwarded = false;
  private initWaiters: Array<{ connId: string; clientId: string | number }> = [];
  // Whether this agent is Codex — gates the on-resume rollout repair (issue #61),
  // which only applies to Codex's session store.
  private readonly isCodex: boolean;
  // Only claude/codex spawn a per-session backing CLI that an idle session keeps
  // alive, so only they are worth reaping; opencode handles sessions in-process.
  // (Forced on for tests, whose fake agent has no recognizable binary name.)
  private readonly reapable: boolean;
  // Sessions with a live backing subprocess in the adapter, newest-active LAST
  // (Map iteration order = LRU; touchSession re-inserts on activity). Bounded to
  // MAX_LIVE_SESSIONS and reaped after SESSION_IDLE_TTL_MS idle. cwd is kept so a
  // reaped session can be transparently re-loaded if a client touches it again.
  private liveSessions = new Map<string, { lastActivity: number; cwd?: string }>();
  // Sessions we reaped (sent session/close). The next client frame targeting one
  // triggers a transparent session/load before forwarding, so clients never see
  // the adapter's "Session not found". Bounded; cwd lets us rebuild the load.
  private reaped = new Map<string, { cwd?: string }>();
  // Client frames parked behind an in-flight transparent re-load (sid → frames +
  // originating conn), flushed in order once the load response returns.
  private reviveQueue = new Map<string, Array<{ connId: string; line: Buffer }>>();
  // sessionId -> the controls the session was last known to be running (config
  // option id -> value; `mode` covers session/set_mode too). Put back after a load
  // that shows the session came back at its defaults — see the section above. NOT
  // cleared when the agent exits: surviving the restart is the point. An LRU cache
  // in front of the session_controls table, so an eviction here costs a read, not
  // the values.
  private sessionControls = new Map<string, Map<string, string>>();
  // This agent's own default controls, applied to sessions the gateway creates.
  private controlDefaults: Map<string, string>;
  // gateway req id -> the control a client is setting, so its response can be
  // attributed to a session and option (session/set_mode answers with `{}`).
  private controlReq = new Map<number, { sid: string; configId: string; value: string }>();
  // gateway req id -> waiter for a control the GATEWAY re-applied. Those responses
  // route to CONTROL_SENTINEL and are dropped, so this is how the re-apply learns
  // they landed.
  private controlAck = new Map<number, (f: Frame) => void>();
  // Sessions whose controls are being re-applied right now. Client frames for them
  // park like a reaped session's do, so nothing reaches the session between the
  // load and the values it is supposed to run with.
  private controlGate = new Set<string>();

  constructor(
    public name: string,
    profile: AgentProfile,
    ledgerDir: string,
    makeAgent: (profile: AgentProfile, onLine: (f: Buffer) => void, onExit: () => void) => AgentLike =
      (p, onLine, onExit) => new Agent(p, onLine, onExit),
    // Notified with the agent's real `loadSession` capability the first time it
    // answers an `initialize`, so the gateway can report what the agent actually
    // supports instead of guessing from the binary name.
    private onInitCaps?: (loadSession: boolean) => void,
    // Shared persistent store for the durable permission inbox. The Gateway owns
    // one (per ledger dir) and hands the same instance to every channel.
    private store?: Db,
    // Force idle-session reaping on regardless of binary name (tests).
    reapAlways = false,
  ) {
    this.controlDefaults = new Map(Object.entries(profile.defaults ?? {}));
    const provider = historyProviderFor(profile.cmd);
    this.isCodex = provider === "codex";
    this.reapable = reapAlways || provider === "claude" || provider === "codex";
    this.ledger = new Ledger(path.join(ledgerDir, `ledger.${name}.jsonl`));
    this.agent = makeAgent(
      profile,
      (frame) => this.fromAgent(frame),
      () => this.onAgentExit(),
    );
  }

  // The agent process died. Every in-flight client request it was handling will
  // never get a response, so settle each one with a JSON-RPC error: the frontend's
  // pending promise rejects (clearing busy/working state) instead of hanging
  // forever (issue #83). Then drop the now-stale per-session state — the respawned
  // agent loses every in-memory session, so its tasks, cwds, titles, and any
  // outstanding permission prompts are gone too. Finally broadcast a
  // _gateway/agent_restart notification so the web client can transparently
  // recover (re-initialize, re-session/load) on the fresh process instead of
  // sitting in a half-broken state until the user manually refreshes.
  private onAgentExit(): void {
    for (const o of this.idmux.drain()) {
      const frame = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: o.clientId,
        error: { code: -32000, message: "agent exited before responding" },
      }));
      // Append so the error gets a ledger seq and rides the resume stream like any
      // other agent→client frame. Keyed null, exactly as a genuine response is (a
      // response carries no session), so it is indistinguishable from the real reply
      // the dead agent never sent.
      const { seq } = this.ledger.append(frame, null);
      this.sendTo(o.connId, seq, frame);
    }
    this.tasks.clear();
    this.promptReq.clear();
    this.promptsInFlight.clear();
    this.sessionCwd.clear();
    this.sessionTitle.clear();
    // The agent process is gone, so the requests it was blocking on can never be
    // answered — mark its still-pending inbox prompts expired (the in-memory
    // pendingPerms is cleared below; the durable inbox keeps them as history).
    this.store?.expireInboxForAgent(this.name, new Date().toISOString());
    this.pendingPerms.clear();
    // A session/load in flight when the agent died will never get the response
    // that normally clears these — left stale, loadGate would wrongly funnel a
    // later broadcast to one connection. The respawned agent has no live loads.
    this.loadGate.clear();
    this.loadReq.clear();
    // The respawned process has no sessions, so every backing CLI we were tracking
    // is gone too — drop the live/reaped/revive bookkeeping. A reconnecting client
    // re-establishes what it needs via session/load.
    this.liveSessions.clear();
    this.reaped.clear();
    this.reviveQueue.clear();
    // In-flight control bookkeeping refers to requests this process will never
    // answer. `sessionControls` deliberately stays: the respawned agent rebuilds
    // its sessions at their defaults, which is exactly when it is needed. A gated
    // session's parked frames went with reviveQueue above, so release the gate too
    // or later frames for it would park with nothing to flush them.
    this.controlReq.clear();
    this.controlAck.clear();
    this.controlGate.clear();
    // The respawned process is fresh and uninitialized: drop the cached handshake
    // so the next client `initialize` is forwarded to re-handshake it. Any client
    // parked waiting on the (now-dead) first initialize had its in-flight request
    // settled by the idmux drain above, so it will reconnect and ask again.
    this.initResult = null;
    this.initForwarded = false;
    this.initWaiters = [];
    // Append + broadcast _gateway/agent_restart so every attached client (and
    // every client that reconnects with a Last-Event-ID before the next respawn
    // wipes the ledger) sees it. The notification has no client id, so the
    // store's `handleNotification` routes it to a small recovery routine that
    // re-initializes and re-session/loads the active conversation.
    const restartFrame = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      method: "_gateway/agent_restart",
    }));
    const { seq: restartSeq } = this.ledger.append(restartFrame, null);
    this.broadcast(restartSeq, restartFrame);
  }

  // Snapshot of sessions whose prompt is still running, pruning entries whose TTL
  // safety net has elapsed. `now` is injectable so tests can drive expiry.
  running(now: number = Date.now()): RunningTask[] {
    const out: RunningTask[] = [];
    for (const [sessionId, t] of this.tasks) {
      if (t.state === "awaiting-input" || now - t.lastSeen < TASK_TTL_MS) {
        out.push({ sessionId, state: t.state, cwd: this.sessionCwd.get(sessionId), title: this.sessionTitle.get(sessionId) });
      } else {
        this.tasks.delete(sessionId);
      }
    }
    return out;
  }

  // Relabel a running task after a rename. `sessionTitle` is captured once, from
  // the conversation's first prompt, and never revisited — so /running keeps
  // announcing the old name to every device that has no other record of the
  // conversation. Scoped to sessions this channel already tracks: a rename must
  // not park labels in the maps of agents that have never seen the session. An
  // empty title (a cleared rename with nothing derivable behind it) drops the
  // label rather than keeping a stale one; the next prompt re-seeds it.
  renameSession(sid: string, title: string): void {
    if (!this.sessionCwd.has(sid) && !this.sessionTitle.has(sid) && !this.tasks.has(sid)) return;
    if (title) this.sessionTitle.set(sid, title.length > 100 ? title.slice(0, 100) : title);
    else this.sessionTitle.delete(sid);
  }

  // Mark a session live and most-recently-active: refresh its idle window and, if
  // it's newly tracked, enforce the per-agent LRU cap first. No-op for agents we
  // don't reap. Called on every frame (either direction) that carries a session id.
  private touchSession(sid: string, cwd?: string, now: number = Date.now()): void {
    if (!this.reapable || !sid) return;
    this.reaped.delete(sid);
    const cur = this.liveSessions.get(sid);
    if (cur) {
      cur.lastActivity = now;
      if (cwd) cur.cwd = cwd;
      this.liveSessions.delete(sid); // re-insert so it becomes most-recently-active
      this.liveSessions.set(sid, cur);
      return;
    }
    // Newly tracked: evict down to the cap, oldest-idle first. A session with an
    // in-flight task is never evicted — if every live session is busy we tolerate
    // a temporary overflow rather than tear down running work.
    while (this.liveSessions.size >= MAX_LIVE_SESSIONS) {
      const victim = this.firstEvictable();
      if (victim === undefined) break;
      this.closeSession(victim, "lru");
    }
    this.liveSessions.set(sid, { lastActivity: now, cwd });
  }

  // Whether this session is blocked on a human: it has an unanswered permission /
  // elicitation outstanding. Unlike `tasks`, pendingPerms is never pruned by a TTL
  // — it is emptied only by a real answer, a session/cancel, the turn's own
  // response, or the agent exiting — so it is the durable fact both the task
  // heartbeat and the reaper trust when deciding "a person still owes this turn a
  // reply". O(n) is fine: at most a couple of prompts are ever outstanding.
  private hasPendingPromptFor(sid: string): boolean {
    for (const p of this.pendingPerms.values()) if (p.sid === sid) return true;
    return false;
  }

  private hasPromptInFlight(sid: string): boolean {
    return (this.promptsInFlight.get(sid) ?? 0) > 0;
  }

  // Release one in-flight prompt for `sid`. Clamped at zero: a double release must
  // not leave a negative count that reads as "in flight" and vetoes reaping forever.
  private releasePrompt(sid: string): void {
    const left = (this.promptsInFlight.get(sid) ?? 0) - 1;
    if (left > 0) this.promptsInFlight.set(sid, left); else this.promptsInFlight.delete(sid);
  }

  // Forget every in-flight prompt for `sid` — the turn is over by other means
  // (cancelled by the user, or the session itself is being torn down), so its
  // response, if one ever comes, no longer has anything to release.
  private forgetPromptsFor(sid: string): void {
    this.promptsInFlight.delete(sid);
    for (const [gid, s] of this.promptReq) if (s === sid) this.promptReq.delete(gid);
  }

  // The least-recently-active live session that is neither running a turn nor
  // waiting on the user, or undefined if all are busy (either one is never reaped).
  private firstEvictable(): string | undefined {
    // Neither extra check is redundant with tasks.has(): a task is TTL-prunable,
    // while an unanswered prompt and an in-flight turn are not, so these are what
    // keep a busy session out of the LRU victim pool once its task has expired.
    for (const sid of this.liveSessions.keys()) {
      if (!this.tasks.has(sid) && !this.hasPendingPromptFor(sid) && !this.hasPromptInFlight(sid)) return sid;
    }
    return undefined;
  }

  // Reap sessions idle past the TTL. Driven by the gateway's periodic sweep (now
  // injectable for tests). A session with an in-flight task is skipped — its frames
  // keep it fresh anyway, and this guards the rare silently-running turn.
  reapIdle(now: number = Date.now()): void {
    if (!this.reapable) return;
    for (const [sid, e] of [...this.liveSessions]) {
      if (this.tasks.has(sid)) continue;
      // A session blocked on an unanswered prompt is idle only because it is
      // waiting for the user, and reaping it means session/close → the adapter's
      // teardownSession → query.interrupt() → the turn dies with a synthetic
      // "[Request interrupted by user for tool use]". The tasks check above cannot
      // carry this on its own: the task is TTL-pruned out from under it while the
      // human thinks, which is precisely how live turns were being killed.
      if (this.hasPendingPromptFor(sid)) continue;
      // A turn whose session/prompt has not been answered yet is running, however
      // quiet it is. The tasks check above expires (running() prunes it at
      // TASK_TTL_MS), so on its own it only postpones the same kill: a build that
      // emits no frames for long enough would still be torn down mid-flight.
      if (this.hasPromptInFlight(sid)) continue;
      if (now - e.lastActivity >= SESSION_IDLE_TTL_MS) this.closeSession(sid, "idle");
    }
  }

  // Tear down a session's backing subprocess via ACP session/close (claude/codex:
  // closeSession → teardownSession → abort the query → kill the CLI). The response
  // routes to CLOSE_SENTINEL (no real conn) and is dropped. The session is recorded
  // in `reaped` so a later client frame transparently re-loads it.
  private closeSession(sid: string, reason: "idle" | "lru"): void {
    const e = this.liveSessions.get(sid);
    this.liveSessions.delete(sid);
    this.rememberReaped(sid, e?.cwd ?? this.sessionCwd.get(sid));
    this.tasks.delete(sid);
    this.forgetPromptsFor(sid);
    this.sessionTitle.delete(sid);
    this.sessionCwd.delete(sid);
    const gid = this.idmux.outbound(CLOSE_SENTINEL, `close:${sid}`, "session/close", sid);
    this.agent.send(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: gid, method: "session/close", params: { sessionId: sid } })));
    console.log(`channel ${this.name}: reaped session ${sid.slice(0, 8)}… (${reason}; ${this.liveSessions.size} live)`);
  }

  private rememberReaped(sid: string, cwd?: string): void {
    this.reaped.delete(sid);
    this.reaped.set(sid, { cwd });
    // Bound the memory of reaped sessions (LRU) — it only enables transparent reload.
    while (this.reaped.size > 64) {
      const k = this.reaped.keys().next().value as string | undefined;
      if (k === undefined) break;
      this.reaped.delete(k);
    }
  }

  addConn(conn: Conn): void {
    this.conns.set(conn.id, conn);
  }

  replaySince(afterSeq: number, session?: string): LedgerEntry[] {
    return this.ledger.since(afterSeq).filter((entry) => {
      // A session-scoped resume drops other conversations' frames — the bulk of
      // a stale cursor's replay, and bytes the requesting client would discard
      // anyway — but keeps channel-scoped frames (sid null: _gateway/agent_restart,
      // the synthetic agent-death error): those address every client, not one
      // session. Ledger.since's own sid filter is NOT this: it excludes sid-less
      // entries, which would eat the restart notification.
      if (session !== undefined && entry.sid !== null && entry.sid !== session) {
        return false;
      }
      const frame = parse(entry.frame);
      if (!frame || !isRequest(frame)) return true;
      if (
        frame.method !== "session/request_permission" &&
        frame.method !== "elicitation/create"
      ) return true;

      const key = frame.id as string | number;
      const pending = this.pendingPerms.get(key);
      return pending !== undefined &&
        pending.seq === entry.seq &&
        pending.sid === sessionIdOf(frame) &&
        pending.method === frame.method;
    });
  }

  removeConn(id: string): void {
    this.conns.delete(id);
    this.idmux.forgetConn(id);
    this.subs.remove(id);
    for (const [sid, connId] of this.loadGate) if (connId === id) this.loadGate.delete(sid);
  }

  private sendTo(connId: string, seq: number, buf: Buffer): void {
    const c = this.conns.get(connId);
    if (c && c.sink.alive) c.sink.send(seq, buf);
  }
  // sendTo for a frame that was deliberately not appended and so has no seq to
  // carry — the client applies it without moving its resume cursor. See
  // SseSink.sendUnsequenced for why a fabricated or borrowed seq corrupts that
  // cursor instead. Deliberately has no broadcast counterpart.
  private sendUnsequencedTo(connId: string, buf: Buffer): void {
    const c = this.conns.get(connId);
    if (c && c.sink.alive) c.sink.sendUnsequenced(buf);
  }
  private broadcast(seq: number, buf: Buffer, connIds?: string[]): void {
    const ids = connIds ?? [...this.conns.keys()];
    for (const id of ids) this.sendTo(id, seq, buf);
  }

  private resolvePendingPrompt(key: number | string, response: Buffer): boolean {
    const pending = this.pendingPerms.get(key);
    if (!pending || !this.permGate.claim(key)) return false;

    const resolved = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      method: "_gateway/prompt_resolved",
      params: {
        sessionId: pending.sid,
        requestId: key,
        requestMethod: pending.method,
      },
    }));

    let resolutionSeq: number;
    try {
      resolutionSeq = this.ledger.append(resolved, pending.sid).seq;
    } catch (error) {
      this.permGate.forget(key);
      throw error;
    }

    this.pendingPerms.delete(key);
    const parsed = parse(response);
    this.store?.resolveInboxItem(
      this.name,
      String(key),
      "answered",
      new Date().toISOString(),
      JSON.stringify(parsed?.result ?? parsed?.error ?? null),
    );
    this.agent.send(response);
    this.broadcast(resolutionSeq, resolved, this.subs.viewers(pending.sid));
    return true;
  }

  // Answer a client `initialize` from the cached handshake result, rewritten to
  // that client's own request id. Like every JSON-RPC response it is point-to-
  // point and must NOT be appended to the ledger (that would replay it to an
  // unrelated client on reconnect), so it rides the current head seq.
  private replyInit(connId: string, clientId: string | number, result: Record<string, unknown>): void {
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: clientId, result }));
    this.sendTo(connId, this.ledger.headSeq(), frame);
  }

  // agent stdout -> client(s)
  private fromAgent(line: Buffer): void {
    const f = parse(line);
    if (!f) return;

    if (isResponse(f)) {
      // A JSON-RPC response is point-to-point: it answers one client's request and is
      // delivered only to that origin connection (with the gateway id rewritten back to
      // the client's). It must NOT enter the broadcast ledger — persisting it would let
      // ledger.since() replay it to an unrelated client on reconnect (leaking another
      // client's result) and would carry the gateway id, not the requester's. So responses
      // are never appended; they ride the current head seq, leaving the resume cursor on
      // the last genuinely replayable frame.
      const seq = this.ledger.headSeq();
      // A prompt's response ends its turn. This runs BEFORE the origin lookup and
      // is keyed on the gateway id rather than on `origin`, because
      // idmux.forgetConn drops the entry when a client leaves mid-turn — so
      // `origin` is null in exactly the case that used to be left to the TTL, and
      // the TTL expiring is what handed live turns to the reaper.
      const endedSid = this.promptReq.get(Number(f.id));
      if (endedSid !== undefined) {
        this.promptReq.delete(Number(f.id));
        this.releasePrompt(endedSid);
        this.tasks.delete(endedSid);
        // Drop any prompt the ended turn was still blocked on. Usually there is
        // none — answering it is what let the turn finish — but a turn that ends
        // another way (interrupted, or a Codex reply forking a fresh session)
        // strands one, and an outstanding prompt vetoes both idle reaping and LRU
        // eviction. A few strays would silently disable session reclamation for
        // this agent, which is the subprocess leak reaping exists to prevent.
        // Same shape as the session/cancel path in fromClient, inbox included, so
        // /inbox can't keep a badge that answerPermission would refuse to honour.
        if (this.hasPendingPromptFor(endedSid)) {
          for (const [id, p] of this.pendingPerms) if (p.sid === endedSid) this.pendingPerms.delete(id);
          this.store?.cancelInboxForSession(this.name, endedSid, new Date().toISOString());
        }
      }
      // A control the gateway re-applied: hand it to the waiter that is holding
      // this session's parked frames. Keyed by gateway id for the same reason as
      // the prompt above, and resolved before the origin lookup because its origin
      // is a sentinel with nothing to route to.
      const ack = this.controlAck.get(Number(f.id));
      if (ack) {
        this.controlAck.delete(Number(f.id));
        this.idmux.inbound(Number(f.id)); // consume the entry we registered
        ack(f);
        return;
      }
      // A control the client set and the adapter accepted: remember it so a later
      // load can put it back.
      const ctl = this.controlReq.get(Number(f.id));
      if (ctl) {
        this.controlReq.delete(Number(f.id));
        if (f.error === undefined) this.rememberControls(ctl, f.result);
      }
      const origin = this.idmux.inbound(Number(f.id));
      if (!origin) return;
      // The agent's `initialize` response carries its true capabilities — surface
      // `loadSession` so the gateway stops relying on a name-based guess (codex-acp,
      // once unable to resume, now reports loadSession:true).
      if (origin.method === "initialize") {
        const caps = (f.result as { agentCapabilities?: { loadSession?: unknown } } | undefined)?.agentCapabilities;
        if (caps && typeof caps.loadSession === "boolean") this.onInitCaps?.(caps.loadSession);
        // Cache the handshake result and release any clients that arrived while it
        // was in flight, each answered with its own request id. On an error response
        // (no result) re-arm so the next client initialize forwards a fresh attempt,
        // and pass the error through to the waiters rather than leaving them hung.
        if (f.result && typeof f.result === "object") {
          this.initResult = f.result as Record<string, unknown>;
          for (const w of this.initWaiters) this.replyInit(w.connId, w.clientId, this.initResult);
        } else {
          this.initForwarded = false;
          for (const w of this.initWaiters) {
            const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: w.clientId, error: f.error ?? { code: -32603, message: "initialize failed" } }));
            this.sendTo(w.connId, seq, frame);
          }
        }
        this.initWaiters = [];
      }
      let created: string | undefined;
      if (origin.method === "session/new") {
        const sid = (f.result as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof sid === "string") {
          this.subs.subscribe(origin.connId, sid);
          // The new session's id is known only now — pair it to the cwd the
          // session/new request carried so running() can report the folder.
          if (origin.cwd) this.sessionCwd.set(sid, origin.cwd);
          // A new session has a fresh backing CLI — start tracking it for reaping.
          this.touchSession(sid, origin.cwd);
          created = sid;
        }
      }
      // session/load finished → stop gating that session's replay, resume broadcast
      const loaded = this.loadReq.get(Number(f.id));
      if (loaded !== undefined) { this.loadGate.delete(loaded); this.loadReq.delete(Number(f.id)); }
      this.sendTo(origin.connId, seq, Buffer.from(JSON.stringify({ ...f, id: origin.clientId })));
      // Record the session's starting controls and apply this agent's defaults over
      // them. After the response, so the client renders the session it asked for and
      // then hears the re-applied values through the usual config_option_update; the
      // gate the re-apply takes parks the client's first prompt behind it.
      if (created !== undefined) this.applyNewSessionControls(created, f.result);
      // A (re)load resubscribes this client to the session — re-deliver any permission
      // still outstanding for it, so a prompt that arrived before a drop (or before a
      // fresh page load) is shown again. Safe to repeat: permGate is first-reply-wins
      // and the client dedupes by request id. Re-send with the permission's ORIGINAL
      // seq (its ledger position), not this response's, so a resuming client's cursor
      // stays consistent.
      if (loaded !== undefined) {
        for (const p of this.pendingPerms.values()) {
          if (p.sid === loaded) this.sendTo(origin.connId, p.seq, p.frame);
        }
        // This load may have rebuilt the session from disk, which resets every
        // control to its default — the result is the only place that says what it
        // came back as. Put the client's choices back first: a prompt parked behind
        // a revive is about to run, and it must not run in a mode the user turned
        // off. The flush is deferred to the re-apply, which always performs it.
        // A re-apply already running for this session owns the queue (and will
        // flush it) — a second one racing it would fight over the same values.
        // A session with nothing recorded (created before the gateway tracked
        // controls, or by a different gateway) adopts this result as its values
        // instead — there is nothing to put back, and the load itself is the first
        // time we learn what it runs.
        if (!this.controlGate.has(loaded)) this.seedControls(loaded, f.result);
        const diff = this.controlGate.has(loaded) ? [] : this.controlDiff(loaded, f.result);
        if (diff.length) void this.reapplyControls(loaded, diff);
        else if (!this.controlGate.has(loaded)) this.flushRevive(loaded);
      }
      return;
    }
    // Requests and notifications are the replayable broadcast frames — but only the
    // ones that actually earn a ledger position, so the append is decided per kind
    // below instead of running ahead of the routing decision. It used to run first,
    // which meant the transcript an agent streams back during session/load was
    // persisted in full on EVERY load: measured on a production ledger, one
    // conversation held 41,520 entries / 160.1 MB with its first frame (a 1.18 MB
    // inline image) stored 105 times. That is what made cursor-based resume replays
    // enormous. Where a frame IS appended, its session goes along so the ledger's
    // per-session index is built, and the assigned seq is reused for every send of it.
    if (isRequest(f)) {
      // Requests append unconditionally, load-gated session or not: pendingPerms
      // records {sid, seq, frame} at this position and the post-load re-delivery
      // above re-sends that exact frame with that exact seq, so a permission the
      // user hasn't answered survives a reconnect or a reload. Dropping one would
      // strand a turn blocked on the user with nothing left to answer.
      const { seq } = this.ledger.append(line, sessionIdOf(f));
      // agent→client request (e.g. session/request_permission): route to viewers.
      // Reset the first-reply-wins gate for this request id so a *new* request
      // round starts fresh — within the round the first reply wins, but the same
      // id can be reused by a later request (the agent may reuse ids).
      if (f.id !== undefined && f.id !== null) this.permGate.forget(f.id as string | number);
      const sid = sessionIdOf(f);
      if (sid) this.touchSession(sid); // agent activity keeps the session alive
      // A permission request means an in-flight turn is blocked on the user — flip
      // the EXISTING task to awaiting-input so the badge can flag "needs you" (and
      // so the TTL leaves it alone while the human takes their time). Guard on
      // has(): a permission with no tracked prompt (a stray or duplicate that
      // arrives after the turn already ended) must not conjure a phantom task —
      // awaiting-input is TTL-immune, so a conjured one would linger forever.
      // Mirrors the same guard on the heartbeat path below.
      if (sid && this.tasks.has(sid)) this.tasks.set(sid, { state: "awaiting-input", lastSeen: Date.now() });
      // Remember the outstanding prompt so it can be re-delivered to a client that
      // reconnects (or reloads) and reloads this session — see fromAgent's
      // session/load branch above.
      if (sid && f.id !== undefined && f.id !== null &&
          (f.method === "session/request_permission" || f.method === "elicitation/create")) {
        const promptMethod = f.method as PromptRequestMethod;
        this.pendingPerms.set(f.id as string | number, { sid, seq, frame: line, method: promptMethod });
        // Mirror into the durable inbox so the prompt survives a reload and is
        // visible/answerable across agents via /inbox (pendingPerms stays the
        // in-run, low-latency re-delivery source; the inbox is the audit trail).
        if (f.method === "session/request_permission") {
          const params = f.params as { toolCall?: { title?: string }; options?: unknown } | undefined;
          const options = Array.isArray(params?.options) ? params.options : [];
          this.store?.addInboxItem({
            type: "permission", agentName: this.name, sessionId: sid, reqId: String(f.id), seq,
            title: params?.toolCall?.title || "Run a tool",
            bodyJson: JSON.stringify(options), createdAt: new Date().toISOString(),
          });
        } else {
          // A form elicitation (the agent asking the user question(s), e.g. Claude's
          // AskUserQuestion). No one-tap options to record — the inbox entry points
          // the user at the conversation, where the client renders the form.
          const params = f.params as { message?: string } | undefined;
          this.store?.addInboxItem({
            type: "elicitation", agentName: this.name, sessionId: sid, reqId: String(f.id), seq,
            title: params?.message || "The agent has a question",
            bodyJson: null, createdAt: new Date().toISOString(),
          });
        }
      }
      const targets = sid ? this.subs.viewers(sid) : undefined;
      this.broadcast(seq, line, targets);
      return;
    }
    // notification → broadcast to all (clients filter by their active session).
    // Exception: while a session is being loaded, its replay goes only to the
    // loading connection so other devices don't duplicate history they already show.
    const nsid = sessionIdOf(f);
    // Heartbeat an in-flight task: each agent frame for the session proves it is
    // still working (and resumes "active" after an awaiting-input pause). Only
    // refresh existing tasks — a session/load replay must not look like a new run.
    // The state is re-derived from pendingPerms rather than pinned to "active",
    // because a session/request_permission is immediately followed by a
    // usage_update notification for the same session: a flat "active" here undid
    // the awaiting-input set above one frame later, and awaiting-input is the only
    // thing keeping the TTL (and so the reaper) off a turn blocked on the user.
    if (nsid && this.tasks.has(nsid)) {
      this.tasks.set(nsid, { state: this.hasPendingPromptFor(nsid) ? "awaiting-input" : "active", lastSeen: Date.now() });
    }
    if (nsid) this.touchSession(nsid); // any agent frame for a session keeps it alive
    // A load-gated notification is the agent replaying history the loader asked for.
    // It is duplication by definition — which is why it has never been broadcast —
    // so it isn't appended either: persisting it stored one more full copy of the
    // conversation per load, and nothing could ever usefully replay that copy (a
    // client resuming past it already holds the original frames). Having no ledger
    // position, it goes out id-less, leaving the loader's resume cursor on the last
    // genuinely replayable frame — see SseSink.sendUnsequenced for why borrowing or
    // inventing a seq here would corrupt that cursor instead.
    //
    // A revive's gate points at REVIVE_SENTINEL, which is not a real conn, so such a
    // replay is now neither delivered nor appended — finishing what
    // reviveThenForward's comment already intended (it was being written to the
    // ledger and handed to nobody).
    //
    // Accepted edge: the gate can be cleared mid-replay (the loader disconnects, or
    // the agent exits), and the tail of that replay then takes the append+broadcast
    // path below — rare, benign, and exactly the semantics an ungated frame gets today.
    if (nsid && this.loadGate.has(nsid)) { this.sendUnsequencedTo(this.loadGate.get(nsid)!, line); return; }
    const { seq } = this.ledger.append(line, nsid);
    this.broadcast(seq, line);
  }

  // client -> agent
  fromClient(conn: Conn, line: Buffer): void {
    const f = parse(line);
    if (!f) { this.agent.send(line); return; }

    const method = typeof f.method === "string" ? f.method : "";

    if (isRequest(f)) {
      // `initialize` is owned by the gateway (see initResult): answer from cache
      // when the shared process is already initialized, park the request while the
      // first one is in flight, else forward this first one to do the handshake.
      if (method === "initialize") {
        const clientId = f.id as string | number;
        if (this.initResult) { this.replyInit(conn.id, clientId, this.initResult); return; }
        if (this.initForwarded) { this.initWaiters.push({ connId: conn.id, clientId }); return; }
        this.initForwarded = true;
        const gatewayId = this.idmux.outbound(conn.id, clientId, method, undefined, undefined);
        this.agent.send(Buffer.from(JSON.stringify({ ...f, id: gatewayId })));
        return;
      }
      const sid = sessionIdOf(f);
      // The session's controls are being put back after a load. Park behind that
      // for the same reason the revive parks: whatever this frame is, it should
      // meet the session the user configured, not the defaults it was rebuilt at.
      if (sid && this.controlGate.has(sid) && method !== "session/load") {
        this.parkFrame(conn, sid, line);
        return;
      }
      // A client touched a session we reaped to reclaim its CLI: transparently
      // re-load it in the adapter before forwarding, so the client never sees the
      // adapter's "Session not found". A session/load already re-establishes it
      // itself, so it falls through to the normal path.
      if (sid && this.reapable && this.reaped.has(sid) && method !== "session/load") {
        this.reviveThenForward(conn, sid, cwdOf(f), line);
        return;
      }
      this.forwardClientRequest(conn, f, line);
      return;
    }
    if (isResponse(f)) {
      const key = f.id as string | number;
      if (this.pendingPerms.has(key)) {
        this.resolvePendingPrompt(key, line);
      } else if (this.permGate.claim(key)) {
        this.agent.send(line);
      }
      return;
    }
    // A client cancel ends the turn from the user's side. The agent may never
    // send a terminating response (it can't, if the originating client already
    // dropped and its idmux entry was forgotten — or if a Codex reply forked a
    // fresh session and abandoned this one), and an awaiting-input task is
    // TTL-immune, so without this it would linger in /running forever. Clear the
    // task now and drop any outstanding permission — nothing can answer it once
    // the turn is cancelled.
    if (method === "session/cancel") {
      const csid = sessionIdOf(f);
      if (csid) {
        this.tasks.delete(csid);
        this.forgetPromptsFor(csid);
        for (const [id, p] of this.pendingPerms) if (p.sid === csid) this.pendingPerms.delete(id);
        this.store?.cancelInboxForSession(this.name, csid, new Date().toISOString());
      }
    }
    this.agent.send(line); // client notification
  }

  // Forward a client request to the agent: subscribe the conn to its session,
  // refresh the reap window, capture cwd/title, mark a new prompt's task active,
  // and rewrite the id so the response routes back. Split out of fromClient so a
  // transparent re-load can replay parked frames through the exact same path.
  private forwardClientRequest(conn: Conn, f: Frame, _line: Buffer): void {
    const method = typeof f.method === "string" ? f.method : "";
    const sid = sessionIdOf(f);
    const cwd = cwdOf(f);
    if (sid) this.subs.subscribe(conn.id, sid); // session/load, session/prompt
    if (sid) this.touchSession(sid, cwd ?? undefined); // client activity keeps it alive
    // Capture the folder for sessions whose id is already known (session/load,
    // and any prompt that carries a cwd). session/new has no id yet — its cwd
    // is paired on the response instead, so it rides along in the idmux Origin.
    if (sid && cwd) this.sessionCwd.set(sid, cwd);
    // Mirror this client's prompt to the OTHER devices viewing the same session,
    // as a synthesized user_message_chunk. Notifications (the agent's reply)
    // broadcast to everyone, but the prompt text itself never leaves the sending
    // client — so without this, other viewers render the reply with no user bubble
    // and merge it into the previous turn's assistant bubble.
    if (method === "session/prompt" && sid) {
      this.mirrorPrompt(conn.id, sid, f.params);
      // A new turn begins — mark the session active so it shows as running.
      this.tasks.set(sid, { state: "active", lastSeen: Date.now() });
      // Label the task by its first prompt (first one wins, so the label stays
      // stable across the turns of a conversation).
      if (!this.sessionTitle.has(sid)) {
        const t = promptText(f.params);
        if (t) this.sessionTitle.set(sid, t.length > 100 ? t.slice(0, 100) : t);
      }
      // A prompt on its way to the agent is the one unambiguous "this conversation
      // is live NOW" signal the gateway owns, and the conversation list needs it:
      // the transcript on disk gets rewritten without gaining a turn, and a session
      // driven purely through the gateway may not be reflected there at all. Kept
      // apart from last_active_at, which a client bumps just by opening a session.
      // Guarded: this write sits in front of the forward below, so a failing store
      // would swallow the prompt itself — a recency hint must never cost a turn.
      try {
        this.store?.touchSessionMessage({
          agentName: this.name,
          cwd: cwd ?? this.sessionCwd.get(sid) ?? "",
          sessionId: sid,
          title: this.sessionTitle.get(sid) ?? "",
          at: new Date().toISOString(),
        });
      } catch { /* recency is best-effort */ }
    }
    const gatewayId = this.idmux.outbound(conn.id, f.id as string | number, method || null, sid || undefined, cwd || undefined);
    // Record the turn against its gateway id (the id the agent will answer with),
    // so the reaper has a fact about it that no TTL can retract. Counted rather
    // than flagged: a second prompt for the same session must not be released by
    // the first response.
    if (method === "session/prompt" && sid) {
      this.promptReq.set(gatewayId, sid);
      this.promptsInFlight.set(sid, (this.promptsInFlight.get(sid) ?? 0) + 1);
    }
    // Remember what this client is setting, to be confirmed (and canonicalized)
    // by the response — the value the adapter settled on is what a rebuilt session
    // has to be brought back to.
    const ctl = controlOf(method, f.params);
    if (ctl && sid) this.controlReq.set(gatewayId, { sid, ...ctl });
    const out = Buffer.from(JSON.stringify({ ...f, id: gatewayId }));
    // Gate this session's replay to the loader until the load response returns.
    if (method === "session/load" && sid) {
      this.loadGate.set(sid, conn.id); this.loadReq.set(gatewayId, sid);
      // A Codex session killed mid tool-call leaves the rollout ending on an open
      // call with no output, which makes `resume` hang on "thinking" (#61).
      // codex-acp reads the rollout from disk on load, so trim that incomplete tail
      // first, then forward. Other agents (and any read/repair error) fall straight
      // through — repair never blocks a load.
      if (this.isCodex) { void this.loadCodexWithRepair(sid, out); return; }
    }
    this.agent.send(out);
  }

  // Re-establish a reaped session in the adapter, then forward the client frame
  // that touched it. The original frame is parked in reviveQueue until the load
  // response returns (fromAgent's load branch flushes it). The load-replay is gated
  // to REVIVE_SENTINEL (no conn) and dropped — the touching client still has its
  // history rendered, so re-broadcasting it would duplicate. Concurrent frames for
  // the same session queue behind the single in-flight load.
  private reviveThenForward(conn: Conn, sid: string, cwd: string | null, line: Buffer): void {
    const loadCwd = cwd ?? this.reaped.get(sid)?.cwd ?? "";
    const q = this.parkFrame(conn, sid, line);
    if (q.length > 1) return; // a re-load is already in flight for this session
    this.touchSession(sid, loadCwd || undefined); // re-tracks it (and clears `reaped`)
    const gid = this.idmux.outbound(REVIVE_SENTINEL, `revive:${sid}`, "session/load", sid, loadCwd || undefined);
    this.loadGate.set(sid, REVIVE_SENTINEL);
    this.loadReq.set(gid, sid);
    const out = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: gid, method: "session/load", params: { sessionId: sid, cwd: loadCwd, mcpServers: [] } }));
    if (this.isCodex) { void this.loadCodexWithRepair(sid, out); return; }
    this.agent.send(out);
  }

  // Hold a client frame until this session is ready for it (an in-flight re-load,
  // or a control re-apply). Returns the queue so a caller can tell whether it is
  // the one that has to start the work.
  private parkFrame(conn: Conn, sid: string, line: Buffer): Array<{ connId: string; line: Buffer }> {
    const q = this.reviveQueue.get(sid) ?? [];
    q.push({ connId: conn.id, line });
    this.reviveQueue.set(sid, q);
    this.subs.subscribe(conn.id, sid);
    return q;
  }

  // Let this session's parked frames through, in arrival order, now that the
  // adapter will accept them (the session is re-established and its controls are
  // back). Conns that dropped meanwhile are skipped.
  private flushRevive(sid: string): void {
    const queued = this.reviveQueue.get(sid);
    if (!queued) return;
    this.reviveQueue.delete(sid);
    for (const item of queued) {
      const c = this.conns.get(item.connId);
      const qf = c && parse(item.line);
      if (c && qf) this.forwardClientRequest(c, qf, item.line);
    }
  }

  // Record a control a client just set, from the adapter's own answer where it has
  // one: the response carries the full option list, so an alias it resolved
  // ("opus" → a model id) is stored as the id, and a value it clamped is stored as
  // clamped. Re-applying what the client asked for instead would mean fighting the
  // adapter's reconciliation on every single load.
  private rememberControls(ctl: { sid: string; configId: string; value: string }, result: unknown): void {
    const snapshot = controlSnapshot(result);
    const tracked = this.sessionControls.get(ctl.sid) ?? new Map<string, string>();
    tracked.set(ctl.configId, snapshot?.values.get(ctl.configId) ?? ctl.value);
    // Setting `model` can clamp `mode` back to default in the same response, so
    // refresh everything else already tracked from that same snapshot.
    if (snapshot) {
      for (const id of tracked.keys()) {
        const v = snapshot.values.get(id);
        if (v !== undefined) tracked.set(id, v);
      }
    }
    this.trackControls(ctl.sid, tracked);
  }

  // Cache a session's controls and persist them. Bounded (LRU, like rememberReaped)
  // so a long-lived gateway doesn't keep one entry per session ever configured;
  // the table is the real store, so an eviction only costs the next read.
  private trackControls(sid: string, tracked: Map<string, string>): void {
    this.sessionControls.delete(sid);
    this.sessionControls.set(sid, tracked);
    while (this.sessionControls.size > 64) {
      const k = this.sessionControls.keys().next().value as string | undefined;
      if (k === undefined) break;
      this.sessionControls.delete(k);
    }
    // Best-effort: losing a row costs one resume at the agent's defaults, which is
    // strictly better than failing the response that carried the values.
    try { this.store?.setSessionControls(this.name, sid, tracked); } catch { /* ignore */ }
  }

  // The controls this session is known to be running, from the cache or the table.
  // Absent (rather than empty) when nothing was ever recorded for it — the caller
  // distinguishes "nothing to put back" from "nothing recorded yet, seed it".
  private trackedControls(sid: string): Map<string, string> | undefined {
    const cached = this.sessionControls.get(sid);
    if (cached) return cached;
    let stored: Map<string, string> | undefined;
    try { stored = this.store?.sessionControls(this.name, sid); } catch { return undefined; }
    if (!stored?.size) return undefined;
    this.trackControls(sid, stored);
    return stored;
  }

  // First control snapshot we see for a session with no record: adopt it as what
  // the session runs. This is what makes a conversation nobody ever switched by
  // hand resume onto its own values instead of the CLI's current global config.
  // A session that already has a record is left alone — on a load, the result IS
  // the defaults we are about to correct.
  private seedControls(sid: string, result: unknown): void {
    if (this.trackedControls(sid)) return;
    const snapshot = controlSnapshot(result);
    if (!snapshot?.values.size) return;
    this.trackControls(sid, new Map(snapshot.values));
  }

  // A session the gateway just created: record what it came up as, then put this
  // agent's configured defaults on top and push whatever that changes. Reuses the
  // load path's diff/re-apply wholesale, so a default the session doesn't offer is
  // dropped exactly like a remembered value the rebuild no longer supports — and
  // only what survived that filter joins the record, so an unusable default never
  // becomes part of what we think this session runs.
  private applyNewSessionControls(sid: string, result: unknown): void {
    this.seedControls(sid, result);
    const tracked = this.trackedControls(sid);
    if (!tracked || !this.controlDefaults.size) return;
    const wanted = new Map(tracked);
    for (const [configId, value] of this.controlDefaults) wanted.set(configId, value);
    const diff = this.controlDiff(sid, result, wanted);
    if (!diff.length) return;
    const next = new Map(tracked);
    for (const c of diff) next.set(c.configId, c.value);
    this.trackControls(sid, next);
    void this.reapplyControls(sid, diff);
  }

  // What this load result would silently change about the session's controls, in
  // the order the values have to go back. Values the result no longer offers are
  // dropped rather than pushed: a session rebuilt by a newer adapter (or with a
  // different model) can legitimately have stopped supporting them, and a rejected
  // re-apply would just log noise on every load.
  private controlDiff(
    sid: string,
    result: unknown,
    // The values to bring the session to. Defaults to what it is known to run; a
    // new session passes its agent's configured defaults merged over that.
    tracked = this.trackedControls(sid),
  ): Array<{ configId: string; value: string; viaSetMode: boolean }> {
    if (!tracked?.size) return [];
    const snapshot = controlSnapshot(result);
    if (!snapshot) return [];
    const out: Array<{ configId: string; value: string; viaSetMode: boolean }> = [];
    for (const [configId, value] of tracked) {
      if (snapshot.values.get(configId) === value) continue; // already what we want
      if (!snapshot.values.has(configId)) continue; // the option itself is gone
      const allowed = snapshot.allowed.get(configId);
      if (allowed && !allowed.has(value)) continue; // the value is no longer offered
      out.push({ configId, value, viaSetMode: snapshot.viaSetMode.has(configId) });
    }
    return out.sort((a, b) => controlRank(a.configId) - controlRank(b.configId));
  }

  // Put the session's controls back, one at a time (each depends on the list the
  // previous one left behind), then tell the clients. Always releases the session's
  // parked frames, however this goes: the values are worth a round trip each, but
  // not the user's prompt.
  private async reapplyControls(sid: string, diff: Array<{ configId: string; value: string; viaSetMode: boolean }>): Promise<void> {
    this.controlGate.add(sid);
    let applied: unknown;
    try {
      for (const c of diff) {
        const res = await this.sendControl(sid, c);
        // No answer, or a refusal: stop here rather than push the rest at an
        // adapter that has already disagreed with us once.
        if (!res || res.error !== undefined) break;
        applied = res.result ?? applied;
      }
      if (applied !== undefined) this.broadcastConfigOptions(sid, applied);
    } finally {
      this.controlGate.delete(sid);
      this.flushRevive(sid);
    }
  }

  // Issue one control change as the gateway (not as any client) and wait for the
  // adapter's answer. Resolves null if it never comes — see controlAckTimeoutMs.
  private sendControl(sid: string, c: { configId: string; value: string; viaSetMode: boolean }): Promise<Frame | null> {
    const method = c.viaSetMode ? "session/set_mode" : "session/set_config_option";
    const params = c.viaSetMode
      ? { sessionId: sid, modeId: c.value }
      : { sessionId: sid, configId: c.configId, value: c.value };
    const gid = this.idmux.outbound(CONTROL_SENTINEL, `control:${sid}:${c.configId}`, method, sid);
    return new Promise<Frame | null>((resolve) => {
      const timer = setTimeout(() => { this.controlAck.delete(gid); resolve(null); }, controlAckTimeoutMs());
      this.controlAck.set(gid, (f) => { clearTimeout(timer); resolve(f); });
      this.agent.send(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: gid, method, params })));
    });
  }

  // Tell every client what the re-applied controls now are. Necessary because the
  // adapter answers session/set_config_option with the full option list but emits
  // no notification for it, and this response went to CONTROL_SENTINEL — so
  // without synthesizing the notification the clients would keep rendering the
  // defaults the load reported (or, worse, the values they never lost).
  private broadcastConfigOptions(sid: string, result: unknown): void {
    const configOptions = (result as { configOptions?: unknown } | null)?.configOptions;
    if (!Array.isArray(configOptions)) return;
    const frame = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "config_option_update", configOptions } },
    }));
    const { seq } = this.ledger.append(frame, sid);
    this.broadcast(seq, frame);
  }

  // Answer an outstanding permission from the server side (the /inbox endpoint),
  // routing the chosen option straight to the live agent. This lets a client
  // answer a prompt for ANY agent without holding that agent's SSE connection —
  // the gateway already holds the live agent and the pending request. Returns
  // false if the prompt is no longer live (already answered, cancelled, or its
  // agent died); first-reply-wins via permGate, exactly like a client reply.
  answerPermission(reqId: string, optionId: string): boolean {
    // pendingPerms is keyed by the agent's real (possibly numeric) id; match by
    // string so a stringified reqId from HTTP finds the right entry.
    let key: number | string | undefined;
    for (const [k, v] of this.pendingPerms) {
      if (String(k) !== reqId) continue;
      // An elicitation expects an {action, content} reply, not an optionId — a
      // permission-shaped answer would read as "cancel" and abort the tool call.
      // It must be answered from a client rendering the form, not this route.
      if (v.method !== "session/request_permission") return false;
      key = k;
      break;
    }
    if (key === undefined) return false;
    const result = { outcome: { outcome: "selected", optionId } };
    return this.resolvePendingPrompt(
      key,
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: key, result })),
    );
  }

  // Trim an interrupted Codex rollout's dangling tail, then forward the
  // already-rewritten session/load frame. Awaiting the repair before the send is
  // the whole point: codex-acp reads the rollout from disk when it handles the
  // load, so the trim must land first. Failure is swallowed inside
  // repairInterruptedCodexSession — the load is always forwarded.
  private async loadCodexWithRepair(sid: string, out: Buffer): Promise<void> {
    await repairInterruptedCodexSession(sid);
    this.agent.send(out);
  }

  // Record a sending client's prompt as a synthetic user_message_chunk, then
  // broadcast it to the other live viewers of the session. Persisting it in the
  // ledger lets reconnecting/background clients replay the user bubble before
  // the agent's response instead of rendering an orphaned assistant turn.
  // Not sent back to the origin while it stays connected; that client already
  // rendered the bubble optimistically.
  private mirrorPrompt(originId: string, sid: string, params: unknown): void {
    const text = promptText(params);
    if (!text) return;
    const frame = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } },
    }));
    const { seq } = this.ledger.append(frame, sid);
    const others = this.subs.viewers(sid).filter((id) => id !== originId);
    if (others.length) this.broadcast(seq, frame, others);
  }
}

// ---------------------------------------------------------------- gateway ----
// Sent to a reconnecting client whose cursor is older than the ledger still retains:
// it has missed frames we no longer hold and must rebuild state (via session/load).
// Inert until the ledger is bounded (Phase 4); harmless before then.
const RELOAD_FRAME = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "_gateway/reload" }));

export class Gateway {
  private channels = new Map<string, Channel>();
  // agentName -> the loadSession capability the agent reported at initialize.
  // Undefined until the agent has answered one; callers fall back to the
  // name-based guess until then.
  private observedSessionLoad = new Map<string, boolean>();
  // The durable inbox store. Production injects `getStore` (the module-level
  // prefs `db()`) so the inbox and prefs share ONE SQLite connection. The getter
  // is passed instead of a Db instance to preserve laziness: importing the module
  // (tests with ACPG_NO_LISTEN=1) must not open /data/state.sqlite. With no
  // injector — a test gateway — the store opens lazily from this gateway's own
  // ledger dir, keeping it isolated on a temp path.
  private _store: Db | null = null;
  constructor(
    private agents: Record<string, AgentProfile>,
    private ledgerDir: string,
    private makeAgent?: (p: AgentProfile, onLine: (f: Buffer) => void, onExit: () => void) => AgentLike,
    private getStore?: () => Db,
    // Force idle-session reaping on for every channel (tests, whose fake agent has
    // no recognizable binary name); production resolves it per agent type instead.
    private reapAlways = false,
  ) {}

  private store(): Db {
    if (this.getStore) return this.getStore();
    if (!this._store) this._store = new Db(path.join(this.ledgerDir, "state.sqlite"));
    return this._store;
  }

  channel(name: string): Channel {
    let ch = this.channels.get(name);
    if (!ch) {
      const profile = this.agents[name];
      if (!profile) throw new Error(`unknown agent "${name}"`);
      ch = new Channel(name, profile, this.ledgerDir,
        this.makeAgent ?? ((p, onLine, onExit) => new Agent(p, onLine, onExit)),
        (loadSession) => this.observedSessionLoad.set(name, loadSession),
        this.store(), this.reapAlways);
      this.channels.set(name, ch);
    }
    return ch;
  }

  // Bounce a running agent's subprocess so it re-reads credentials — used after
  // an interactive re-login writes fresh tokens to ~/.claude. No-op if that
  // agent has no live channel yet (it'll spawn fresh with the new creds anyway).
  restartAgent(name: string): boolean {
    const ch = this.channels.get(name);
    if (!ch) return false;
    ch.agent.restart();
    return true;
  }

  // The durable permission/notification inbox, newest first. Filter by status
  // (e.g. "pending") and/or agent. Polled by the UI like /running so a device
  // sees prompts raised anywhere — including on other agents/devices.
  inbox(opts: { status?: InboxStatus; agentName?: string; limit?: number } = {}): InboxItem[] {
    return this.store().inbox(opts);
  }

  // Answer a pending permission for any agent from the server side. Returns false
  // if that agent has no live channel (e.g. died/never started this run) or the
  // prompt is no longer answerable.
  answerInboxPermission(agentName: string, reqId: string, optionId: string): boolean {
    return this.channels.get(agentName)?.answerPermission(reqId, optionId) ?? false;
  }

  // Called once when the real server boots: a gateway restart killed every agent
  // subprocess, so any prompt left pending from the previous run can never be
  // answered. Recording them as expired keeps the inbox honest.
  expireStalePending(): void {
    this.store().expireAllPending(new Date().toISOString());
  }

  // What the agent actually reported for session/load at initialize, or undefined
  // if it hasn't connected yet. Lets the HTTP surface advertise the truth.
  sessionLoad(name: string): boolean | undefined {
    return this.observedSessionLoad.get(name);
  }

  // Push a rename into every channel's running-task label. Fanned out across all
  // of them rather than aimed at one: two agents can share a provider (and so a
  // conversation), and each channel ignores an id it doesn't track.
  renameSession(sessionId: string, title: string): void {
    for (const ch of this.channels.values()) ch.renameSession(sessionId, title);
  }

  // Sessions with a prompt still running, across every agent. The web UI polls
  // this so a device can see (and jump to) tasks running anywhere — including
  // ones started on another device, which its own SSE connection never observed.
  running(now: number = Date.now()): Array<{ agentName: string } & RunningTask> {
    const out: Array<{ agentName: string } & RunningTask> = [];
    for (const [name, ch] of this.channels)
      for (const t of ch.running(now)) out.push({ agentName: name, ...t });
    return out;
  }

  // Sweep every channel for idle sessions to reap. Driven by a periodic timer in
  // the real entrypoint; `now` is injectable so tests can force the TTL to elapse.
  reapIdleSessions(now: number = Date.now()): void {
    for (const ch of this.channels.values()) ch.reapIdle(now);
  }

  // attach a new connection (no supersede), replaying the agent ledger from the
  // client's cursor. `cursor` is "the last seq the client has already seen", so we
  // replay since(cursor); cursor=end (Number.MAX_SAFE_INTEGER) clamps to headSeq, i.e.
  // live with no replay. If the client resumes from below what the ledger still
  // retains, it has missed frames we no longer hold — tell it to full-reload (the
  // client falls back to session/load) before going live. (Inert until Phase 4 bounds
  // the ledger; floorSeq stays 1 while unbounded.)
  //
  // `opts.session` scopes the replay to one conversation (plus channel-scoped
  // sid-less frames) — a resuming client that only renders one session asks for
  // exactly that instead of the whole channel's backlog. `opts.greet` runs after
  // the conn exists but before any reload/replay byte, so the transport can hand
  // the client its conn id first: the client's connect timeout measures "is the
  // gateway alive", and a large replay on a slow link must not eat that budget.
  attach(
    sink: ClientSink,
    agentName: string,
    cursor: number,
    opts?: { session?: string; greet?: (conn: Conn) => void },
  ): Conn {
    const ch = this.channel(agentName);
    const conn: Conn = { id: crypto.randomUUID(), sink };
    opts?.greet?.(conn);
    const afterSeq = Math.min(cursor, ch.ledger.headSeq());
    if (afterSeq < ch.ledger.floorSeq() - 1) {
      sink.send(ch.ledger.headSeq(), RELOAD_FRAME);
      ch.addConn(conn);
      return conn;
    }
    for (const e of ch.replaySince(afterSeq, opts?.session)) sink.send(e.seq, e.frame);
    ch.addConn(conn);
    return conn;
  }

  detach(agentName: string, connId: string): void {
    this.channels.get(agentName)?.removeConn(connId);
  }

  // Look up an already-attached connection without creating a channel. Used by the
  // SSE/POST transport: the POST carries the conn id the SSE stream was issued, and
  // upstream frames route to that exact Conn (so idmux/subs/permGate behave as on WS).
  connById(agentName: string, connId: string): Conn | undefined {
    return this.channels.get(agentName)?.conns.get(connId);
  }

  fromClient(agentName: string, conn: Conn, buf: Buffer): void {
    this.channels.get(agentName)?.fromClient(conn, buf);
  }

  killAll(): void {
    for (const c of this.channels.values()) c.agent.kill();
  }
}

// --------------------------------------------------------------- console ----
// A self-contained raw frame poker served at "/raw" (the chat UI at "/" is the
// main interface; see public/console.html). It connects straight to the local
// agent: the page carries an ephemeral console token (rotated every process
// start, NOT the long-lived ACPG_AUTH_TOKEN) and auto-connects on load, so the
// operator never types the shared credentials into the page. The /acp path still
// requires the real account credentials for remote clients. Anyone who can load
// the page can drive the agent —
// disable the whole console with ACPG_CONSOLE=off.
function renderConsole(
  ssePath: string,
  rpcPath: string,
  consoleToken: string,
  defaultAgent: string,
): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>acp-gateway console</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#c9d1d9; --muted:#8b949e; --accent:#2f81f7; --green:#3fb950; --red:#f85149; --yellow:#d29922; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:10px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  #dot { width:10px; height:10px; border-radius:50%; background:var(--muted); flex:0 0 auto; }
  #dot.on { background:var(--green); } #dot.off { background:var(--red); }
  main { display:grid; grid-template-columns:340px 1fr; height:calc(100vh - 45px); }
  #side { padding:14px 16px; border-right:1px solid var(--border); overflow:auto; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input, select, textarea, button { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:7px 9px; width:100%; }
  textarea { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; resize:vertical; }
  button { cursor:pointer; background:#21262d; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .row { display:flex; gap:8px; } .row > * { flex:1; }
  #log { overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .frame { padding:6px 12px; border-bottom:1px solid var(--border); white-space:pre-wrap; word-break:break-word; }
  .frame .meta { color:var(--muted); font-size:11px; margin-bottom:2px; }
  .frame.tx { border-left:3px solid var(--accent); }
  .frame.rx { border-left:3px solid var(--green); }
  .frame.sys { border-left:3px solid var(--yellow); color:var(--muted); }
  .frame.err { border-left:3px solid var(--red); color:var(--red); }
  .send { display:flex; flex-direction:column; gap:8px; margin-top:16px; }
  .presets { display:flex; flex-wrap:wrap; gap:6px; }
  .presets button { width:auto; flex:0 0 auto; font-size:12px; padding:4px 8px; }
  .counter { font-family:ui-monospace,monospace; color:var(--fg); }
  small { color:var(--muted); }
</style>
</head>
<body>
<header>
  <span id="dot"></span>
  <h1>acp-gateway console</h1>
  <small id="status">disconnected</small>
  <small style="margin-left:auto">received <span id="rxcount" class="counter">0</span> frames &middot; last seq <span id="lastseq" class="counter">0</span></small>
</header>
<main>
  <section id="side">
    <label>Agent (local)</label>
    <select id="agent"></select>
    <small>connects straight to the local agent &mdash; no token needed</small>
    <label>Last-Event-ID (resume cursor &mdash; 0 = full replay, blank = live)</label>
    <div class="row">
      <input id="cursor" type="number" value="0" min="0">
      <button id="usecount" title="set the resume cursor to the last seq seen">use last seq</button>
    </div>
    <div class="row" style="margin-top:14px">
      <button id="connect" class="primary">Connect</button>
      <button id="disconnect">Disconnect</button>
    </div>
    <div class="send">
      <label style="margin:0">Send JSON-RPC frame</label>
      <div class="presets">
        <button data-m="initialize">initialize</button>
        <button data-m="session/new">session/new</button>
        <button data-m="authenticate">authenticate</button>
        <button id="clearlog">clear log</button>
      </div>
      <textarea id="msg" rows="6" spellcheck="false"></textarea>
      <button id="send" class="primary">Send (Ctrl/Cmd+Enter)</button>
      <small>jsonrpc + an auto id are filled in for requests that omit them.</small>
    </div>
  </section>
  <section id="log"></section>
</main>
<script>
(function(){
  var CFG = __CFG__;
  var $ = function(id){ return document.getElementById(id); };
  var es = null, conn = "", nextId = 1, rx = 0, lastSeq = 0;

  function pad(n){ return ("0" + n).slice(-2); }
  function ts(){ var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }
  function setStatus(text, cls){ $("status").textContent = text; $("dot").className = cls || ""; }

  function logFrame(kind, text, label){
    var pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    var el = document.createElement("div");
    el.className = "frame " + kind;
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = ts() + "  " + (label || kind);
    var body = document.createElement("div");
    body.textContent = pretty;
    el.appendChild(meta); el.appendChild(body);
    var log = $("log");
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function loadAgents(){
    return fetch(location.protocol + "//" + location.host + "/healthz")
      .then(function(r){ return r.json(); })
      .then(function(j){
        var sel = $("agent");
        sel.innerHTML = "";
        (j.agents || []).forEach(function(name){
          var o = document.createElement("option");
          o.value = name; o.textContent = name;
          if (name === CFG.defaultAgent) o.selected = true;
          sel.appendChild(o);
        });
      })
      .catch(function(){});
  }

  // Shared query for both the SSE downstream and the POST upstream: the ephemeral
  // console token + the selected agent. extra carries the per-direction params
  // (lastEventId for SSE, conn for POST).
  function qs(extra){
    return "token=" + encodeURIComponent(CFG.token)
         + "&agent=" + encodeURIComponent($("agent").value)
         + extra;
  }
  function sseUrl(){
    var c = $("cursor").value;
    var last = c === "" ? "end" : c; // blank = live; 0 = full replay; N = resume after N
    return location.protocol + "//" + location.host + CFG.ssePath + "?" + qs("&lastEventId=" + encodeURIComponent(last));
  }

  function connect(){
    disconnect();
    rx = 0; lastSeq = 0; $("rxcount").textContent = "0"; $("lastseq").textContent = "0";
    var url = sseUrl();
    logFrame("sys", url.replace(/token=[^&]*/, "token=***"), "connecting");
    setStatus("connecting...", "");
    try { es = new EventSource(url); } catch (e) { logFrame("err", String(e), "error"); return; }
    // The gateway issues the conn id in a ready event; upstream POSTs address it.
    es.addEventListener("ready", function(ev){
      try { conn = JSON.parse(ev.data).conn; } catch (e) { conn = ""; }
      setStatus("connected", "on"); logFrame("sys", "open conn=" + conn, "connected");
    });
    es.onmessage = function(ev){
      rx++; $("rxcount").textContent = String(rx);
      if (ev.lastEventId) { lastSeq = ev.lastEventId; $("lastseq").textContent = lastSeq; }
      logFrame("rx", ev.data, "agent -> client #" + rx + (ev.lastEventId ? " seq " + ev.lastEventId : ""));
    };
    // EventSource auto-reconnects with Last-Event-ID after a drop — fine for a poker.
    es.onerror = function(){ setStatus("reconnecting…", "off"); logFrame("err", "stream error (auto-retrying; check token / path / agent)", "error"); };
  }

  function disconnect(){ if (es) { try { es.close(); } catch (e) {} es = null; conn = ""; } }

  function send(){
    if (!es || !conn) { logFrame("err", "not connected", "error"); return; }
    var raw = $("msg").value.trim();
    if (!raw) return;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { logFrame("err", "invalid JSON: " + e.message, "error"); return; }
    if (obj && obj.jsonrpc === undefined) obj.jsonrpc = "2.0";
    if (obj && obj.method && obj.id === undefined && !("result" in obj) && !("error" in obj)) obj.id = nextId++;
    var text = JSON.stringify(obj);
    var url = location.protocol + "//" + location.host + CFG.rpcPath + "?" + qs("&conn=" + encodeURIComponent(conn));
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: text })
      .then(function(r){ if (r.status !== 202) logFrame("err", "POST returned " + r.status, "error"); })
      .catch(function(e){ logFrame("err", "POST failed: " + e, "error"); });
    logFrame("tx", text, "client -> agent");
  }

  $("connect").onclick = connect;
  $("disconnect").onclick = disconnect;
  $("send").onclick = send;
  $("usecount").onclick = function(){ $("cursor").value = String(lastSeq); };
  $("clearlog").onclick = function(){ $("log").innerHTML = ""; };
  // Switching agent reconnects from a fresh cursor (the seq stream is per-agent).
  $("agent").onchange = function(){ $("cursor").value = "0"; connect(); };
  Array.prototype.forEach.call(document.querySelectorAll(".presets button[data-m]"), function(b){
    b.onclick = function(){ $("msg").value = JSON.stringify({ jsonrpc: "2.0", method: b.getAttribute("data-m"), params: {} }, null, 2); };
  });
  $("msg").addEventListener("keydown", function(e){
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
  });

  // Auto-connect to the local agent on load — no token entry required.
  loadAgents().then(connect);
})();
</script>
</body>
</html>`.replace("__CFG__", function () {
    return JSON.stringify({ ssePath, rpcPath, token: consoleToken, defaultAgent });
  });
}

const consoleEnabled = (process.env.ACPG_CONSOLE ?? "on").toLowerCase() !== "off";
// General-shell PTY terminal (like ttyd) — see terminal.ts. On by default, and
// only ever reachable when the console is. Set ACPG_TERMINAL=off to withhold
// it: unlike the scoped /login/* PTY, this hands anyone holding the gateway
// credential a real shell on the host.
const terminalEnabled = consoleEnabled && (process.env.ACPG_TERMINAL ?? "on").toLowerCase() !== "off";
// Ephemeral token the console auto-authenticates with; rotated each start so the
// long-lived ACPG_AUTH_TOKEN is never embedded in served HTML.
const consoleToken = crypto.randomBytes(18).toString("base64url");
const CONSOLE_HTML = consoleEnabled
  ? renderConsole(cfg.ssePath, cfg.rpcPath, consoleToken, cfg.defaultAgent)
  : "";

// The chat UI is a React SPA (web/, built to web/dist) and is served at "/", with
// its hashed assets at "/assets/". The raw frame poker is at "/raw". CFG (ws path,
// ephemeral token, agent list + cwd) is injected into web/dist/index.html at serve
// time; the agent cwds let the UI pass a cwd to session/new.
const agentDetails = Object.entries(cfg.agents).map(([name, p]) => ({
  name,
  cwd: p.cwd,
  kind: historyProviderFor(p.cmd), // which CLI backs this agent — drives the resume command syntax
  history: supportsAgentHistory(p.cmd),
  discover: supportsHistoryDiscovery(p.cmd), // can /history/discovered list this agent's other folders?
  sessionLoad: supportsAgentSessionLoad(p.cmd), // initial guess; refined once the agent reports at initialize
  skin: agentSkinFor(p.cmd),
}));
// The injected config and /healthz prefer what the agent actually reported over
// the name-based guess, so an agent that can resume (e.g. codex-acp) is advertised
// as resumable as soon as it has connected once.
function agentDetailsNow() {
  return agentDetails.map((d) => ({ ...d, sessionLoad: gateway.sessionLoad(d.name) ?? d.sessionLoad }));
}
function loadChatHtml(): string {
  const file = path.join(ROOT, "web", "dist", "index.html");
  if (!fs.existsSync(file)) return "";
  const cfgJson = JSON.stringify({
    ssePath: cfg.ssePath,
    rpcPath: cfg.rpcPath,
    token: consoleToken,
    defaultAgent: cfg.defaultAgent,
    agents: agentDetailsNow(),
    fsRoot: FS_ROOT,
    terminalEnabled,
  }).replace(/</g, "\\u003c");
  return fs.readFileSync(file, "utf8").replace("__ACPG_CFG__", () => cfgJson);
}
// Read per request (not cached at startup) so a web/dist hot-swap takes effect
// without a gateway restart — index.html is tiny and references content-hashed
// assets, so its filename changes on every web build.

// ---------------------------------------------------------------- server ----
// Share the single prefs `db()` connection with the inbox (pass the lazy getter,
// not db() itself, so importing this module never opens the SQLite file).
const gateway = new Gateway(cfg.agents, cfg.ledgerDir, undefined, db);

// After an interactive re-login completes, bounce the corresponding agent so its
// next process re-reads the freshly written credentials instead of waiting for
// the crash-loop backoff to do it.
for (const [name, prof] of Object.entries(cfg.agents)) {
  // Register the backing CLI so the login PTY runs the right command for a
  // renamed agent (the kind, not the name, decides claude vs codex login).
  registerLoginAgent(name, historyProviderFor(prof.cmd));
  getSession(name).onSuccess = () => {
    if (gateway.restartAgent(name))
      console.log(`login: restarted agent "${name}" to pick up new credentials`);
  };
}

// Serve the SSE downstream (GET ssePath) and POST upstream (POST rpcPath) transport.
// Returns true if it handled the request (caller should stop), false if the path is
// neither. Exported so the e2e test server can mount the same code path as production.
export function handleSseRpc(
  gateway: Gateway,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: {
    ssePath: string;
    rpcPath: string;
    sseKeepaliveMs: number;
    maxPayload: number;
    defaultAgent: string;
    authOk: (authorization: string | undefined, user: string | null, token: string | null) => boolean;
  },
): boolean {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname !== opts.ssePath && pathname !== opts.rpcPath) return false;

  const u = new URL(req.url ?? "/", "http://x");
  if (!opts.authOk(req.headers.authorization, u.searchParams.get("user"), u.searchParams.get("token"))) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="acp-gateway", charset="UTF-8"' });
    res.end();
    return true;
  }
  const agentName = u.searchParams.get("agent") ?? opts.defaultAgent;

  if (pathname === opts.ssePath) {
    // Resume cursor: the Last-Event-ID header (set automatically by a reconnecting
    // client) or ?lastEventId=, else "end" (live, no replay).
    const hdr = req.headers["last-event-id"];
    const lastId = (Array.isArray(hdr) ? hdr[0] : hdr) ?? u.searchParams.get("lastEventId") ?? "end";
    const cursor = lastId === "end" ? Number.MAX_SAFE_INTEGER : parseInt(lastId, 10) || 0;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // tell nginx & friends not to buffer the stream
    });
    const sink = new SseSink(res);
    // Optional replay scope: ?session=<sid> resumes only that conversation
    // (channel-scoped frames included). Absent → the whole channel, as before.
    const session = u.searchParams.get("session") || undefined;
    let conn: Conn;
    try {
      conn = gateway.attach(sink, agentName, cursor, {
        session,
        // Hand the client its connection id so it can address upstream POSTs to
        // rpcPath — BEFORE the replay, so a client on a slow link learns the
        // connect succeeded without waiting for the backlog to drain.
        greet: (c) => res.write(`event: ready\ndata:${JSON.stringify({ conn: c.id })}\n\n`),
      });
    } catch (e) {
      console.warn(`rejecting SSE connection: ${String(e)}`);
      res.end();
      return true;
    }
    console.log(
      `client: SSE connected agent="${agentName}" conn=${conn.id} cursor=${cursor}` +
        (session ? ` session=${session}` : ""),
    );
    const ka = setInterval(() => sink.keepalive(), opts.sseKeepaliveMs);
    ka.unref?.();
    res.on("close", () => {
      clearInterval(ka);
      console.log(`client: SSE disconnected agent="${agentName}" conn=${conn.id}`);
      gateway.detach(agentName, conn.id);
    });
    return true;
  }

  // POST rpcPath?agent=&conn= — one JSON-RPC frame per request, routed to the Conn its
  // SSE stream was issued. Returns 202; any response flows back on the SSE stream.
  if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
  const conn = gateway.connById(agentName, u.searchParams.get("conn") ?? "");
  if (!conn) { res.writeHead(409, { "content-type": "text/plain; charset=utf-8" }); res.end("unknown conn\n"); return true; }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > opts.maxPayload) tooBig = true; // cap the upstream POST body (ACPG_MAX_PAYLOAD)
    else chunks.push(c);
  });
  req.on("end", () => {
    if (tooBig) { res.writeHead(413); res.end(); return; }
    try {
      gateway.fromClient(agentName, conn, Buffer.concat(chunks));
    } catch (error) {
      console.error(`failed to route client frame: ${String(error)}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
      return;
    }
    res.writeHead(202);
    res.end();
  });
  req.on("error", () => { res.writeHead(400); res.end(); });
  return true;
}

function handleInboxAnswerRequest(
  gateway: Gateway,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname !== "/inbox/answer") return false;
  if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  const agent = q.get("agent") ?? "";
  const reqId = q.get("reqId") ?? "";
  const optionId = q.get("optionId") ?? "";
  if (!agent || !reqId || !optionId) { res.writeHead(400); res.end(); return true; }
  try {
    const ok = gateway.answerInboxPermission(agent, reqId, optionId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
  } catch (error) {
    console.error(`failed to answer inbox prompt: ${String(error)}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
  return true;
}

export function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = (req.url ?? "/").split("?")[0];

  // SSE downstream + POST upstream transport. Authenticates like the WS upgrade
  // (query user/token, Basic header, or the ephemeral console token), so it is handled
  // before — and independently of — the Basic-only gate below.
  if (handleSseRpc(gateway, req, res, {
    ssePath: cfg.ssePath,
    rpcPath: cfg.rpcPath,
    sseKeepaliveMs: cfg.sseKeepaliveMs,
    maxPayload: cfg.maxPayload,
    defaultAgent: cfg.defaultAgent,
    authOk: (authorization, user, token) =>
      wsAuthOk({ authorization, user, token, expectedUser: cfg.authUser, expectedPass: cfg.authToken, consoleEnabled, consoleToken }),
  })) return;

  // Gate the HTTP surface behind Basic auth (ACPG_AUTH_USER + ACPG_AUTH_TOKEN).
  // "/" embeds the ephemeral console token that grants SSE+POST
  // access, and /fs + /history* expose the host filesystem and past
  // conversations — so reaching the port must not be enough to use any of them.
  // Only /healthz stays open, for external liveness/readiness probes (it reveals
  // just agent names and the gateway version). The /acp/sse + /acp/rpc paths keep
  // their own token check and never pass through this handler.
  if (pathname !== "/healthz" && !basicAuthOk(req.headers.authorization, cfg.authUser, cfg.authToken)) {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="acp-gateway", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("authentication required\n");
    return;
  }
  if (pathname === "/healthz") {
    // Unauthenticated probe: expose only low-sensitivity data (status + version +
    // agent names). The richer agentDetails (cwd, history/resume flags) is
    // reachable only through the Basic-auth'd surface — it's injected into the
    // chat SPA config — so an open liveness probe never leaks host/project paths.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: GATEWAY_VERSION, agents: Object.keys(cfg.agents) }));
    return;
  }
  // Structured bootstrap metadata for native clients. It mirrors the config
  // injected into the Web Console, but never embeds a credential or command.
  if (consoleEnabled && pathname === "/client-config") {
    const config = buildClientConfig({
      gatewayVersion: GATEWAY_VERSION,
      ssePath: cfg.ssePath,
      rpcPath: cfg.rpcPath,
      defaultAgent: cfg.defaultAgent,
      fsRoot: FS_ROOT,
      agents: agentDetailsNow(),
      terminalEnabled,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(config));
    return;
  }
  // Scoped, PTY-backed `claude auth login` terminal so credentials can be
  // re-authenticated from a remote/mobile browser when they expire. Sits behind
  // the same Basic-auth gate as the rest of the console surface.
  if (consoleEnabled && pathname.startsWith("/login/")) {
    if (handleLogin(req, res, pathname, cfg.maxPayload)) return;
  }
  // General shell — real host shell access, so it gets its own flag
  // (ACPG_TERMINAL=off withholds it) on top of the Basic-auth gate above.
  // See terminal.ts.
  if (terminalEnabled && pathname.startsWith("/terminal/")) {
    if (handleTerminal(req, res, pathname, cfg.maxPayload)) return;
  }
  // Browse host directories under ACPG_FS_ROOT (for the folder picker).
  if (consoleEnabled && pathname === "/fs") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const target = resolveWithinRoot(q.get("path") ?? "") ?? FS_ROOT;
    listDirs(target)
      .then((dirs) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ root: FS_ROOT, path: target, parent: target === FS_ROOT ? null : path.dirname(target), dirs }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Enumerate files under a cwd for the composer's "@ file" picker. Scoped to
  // ACPG_FS_ROOT (resolveWithinRoot rejects any escape); ?q= filters by a
  // case-insensitive substring of the cwd-relative path.
  if (consoleEnabled && pathname === "/files") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const cwd = resolveWithinRoot(q.get("cwd") ?? "") ?? FS_ROOT;
    listFiles(cwd, q.get("q") ?? "")
      .then((files) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ root: FS_ROOT, cwd, files }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Generic (non-image) file attachments: raw POST body, ?name= carries the
  // original filename. See uploads.ts for the full route.
  if (consoleEnabled && pathname === "/uploads") {
    handleUpload(req, res, { uploadsDir: UPLOADS_DIR, maxBytes: cfg.uploadMaxBytes })
      // Same shape as the sibling handlers above, but headersSent-guarded:
      // handleUpload answers 200/413/... itself, so a late rejection would hit
      // an already-answered res and throw ERR_HTTP_HEADERS_SENT out of the very
      // catch meant to contain it.
      .catch((e) => {
        console.error(`upload route failed: ${String(e)}`);
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
      });
    return;
  }
  // ---- workspace file preview ----
  // Read-only views of the project the agent is working in, so its output can be
  // inspected from the browser instead of only read about in the transcript:
  //   /workspace/changes  git status + line counts for the folder's checkout
  //   /workspace/diff     one file's unified diff (untracked files included)
  //   /workspace/file     one file's content as text / image metadata / binary
  //   /workspace/outputs  whole folders the conversation wrote into, for the
  //                       shell-written files neither git nor a tool call knows
  //   /workspace/render   one .html with its assets inlined, so the sandboxed
  //                       preview (and a downloaded copy) actually shows them
  //   /workspace/raw      one file's bytes (the <img> source, and downloads)
  //   /workspace/commits  the checkout's recent history, to review what landed
  //   /workspace/review   the review draft for one diff — the one route here
  //                       that writes, and only ever into .acp-review/
  // changes and diff take an optional ?rev= (one commit) or ?base= (a branch
  // against where it diverged), which is what makes reviewing history the same
  // screen as reviewing the working tree.
  // What each may read is allowedPreviewPath's decision: the conversation's cwd,
  // its repo, and ACPG_PREVIEW_ROOTS — or anything at all, when a deployment
  // sets ACPG_PREVIEW_FILTER_ENABLED=0. They stay read-only apart from the
  // review draft: nothing here stages, reverts, or touches a checkout's files.
  if (consoleEnabled && pathname === "/workspace/changes") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const cwd = resolveWithinRoot(q.get("cwd") ?? "");
    if (!cwd) { res.writeHead(400); res.end(JSON.stringify({ error: "cwd outside root", code: "outside-root" })); return; }
    const spec = revSpecFrom(q);
    if (spec === false) { res.writeHead(400); res.end(JSON.stringify({ error: "bad revision", code: "bad-revision" })); return; }
    (spec ? workspaceRevChanges(cwd, spec) : workspaceChanges(cwd))
      .then((r) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  if (consoleEnabled && pathname === "/workspace/diff") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const spec = revSpecFrom(q);
    if (spec === false) { res.writeHead(400); res.end(JSON.stringify({ error: "bad revision", code: "bad-revision" })); return; }
    resolveWorkspaceTarget(q)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(JSON.stringify({ error: "path outside root", code: "outside-root" })); return; }
        return workspaceFileDiff(target.cwd, target.abs, spec).then((r) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(r));
        });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // The checkout's recent history, so a review can be of what was landed rather
  // than only of what is still uncommitted. Picking an entry here re-asks
  // /workspace/changes and /workspace/diff with ?rev=, which is why there is no
  // separate "commit detail" route.
  if (consoleEnabled && pathname === "/workspace/commits") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const cwd = resolveWithinRoot(q.get("cwd") ?? "");
    if (!cwd) { res.writeHead(400); res.end(JSON.stringify({ error: "cwd outside root", code: "outside-root" })); return; }
    const limit = Number(q.get("limit")) || MAX_COMMITS;
    workspaceCommits(cwd, limit)
      .then((r) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  if (consoleEnabled && pathname === "/workspace/file") {
    resolveWorkspaceTarget(new URL(req.url ?? "/", "http://x").searchParams)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(JSON.stringify({ error: "path outside root", code: "outside-root" })); return; }
        return workspacePreview(target.abs, target.display).then((r) => {
          if (!r) { res.writeHead(404); res.end(JSON.stringify({ error: "not a readable file", code: "not-found" })); return; }
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(r));
        });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // One directory's entries, for browsing the project rather than only the
  // files this conversation happened to name. Same guard as every other
  // /workspace route deliberately: a tree gated more loosely than the viewer
  // would list rows the viewer then refuses to open.
  if (consoleEnabled && pathname === "/workspace/tree") {
    resolveWorkspaceTarget(new URL(req.url ?? "/", "http://x").searchParams, true)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(JSON.stringify({ error: "path outside root", code: "outside-root" })); return; }
        return workspaceTree(target.cwd, target.abs, target.display).then((r) => {
          if (!r) { res.writeHead(404); res.end(JSON.stringify({ error: "not a readable directory", code: "not-found" })); return; }
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(r));
        });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Filenames matching ?q= anywhere under the tree's root.
  if (consoleEnabled && pathname === "/workspace/find") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    resolveWorkspaceTarget(q, true)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(JSON.stringify({ error: "path outside root", code: "outside-root" })); return; }
        return workspaceFind(target.cwd, target.abs, q.get("q") ?? "").then((r) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(r));
        });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Lines matching ?q= inside the files under the tree's root — the other half
  // of Project search, where /workspace/find only reads names.
  if (consoleEnabled && pathname === "/workspace/grep") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    resolveWorkspaceTarget(q, true)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(JSON.stringify({ error: "path outside root", code: "outside-root" })); return; }
        return workspaceGrep(target.cwd, target.abs, q.get("q") ?? "").then((r) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(r));
        });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // One .html file with its own assets inlined as data: URIs, for the panel's
  // sandboxed preview and for saving a copy that still works.
  //
  // The sandbox is what makes this necessary: the preview iframe has an opaque
  // origin, so the document cannot load the images sitting next to it on disk,
  // and neither can a copy downloaded to a laptop without its folder. Inlining
  // here rather than asking the agent to do it is not just cheaper — an agent
  // CANNOT do it, because base64 is text and 120KB of PNG exceeds what a single
  // tool call may write. Same access gate as every other route: an asset the
  // viewer would refuse to open is left as a broken reference, not inlined.
  if (consoleEnabled && pathname === "/workspace/render") {
    resolveWorkspaceTarget(new URL(req.url ?? "/", "http://x").searchParams)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(JSON.stringify({ error: "path outside root", code: "outside-root" })); return; }
        const resolve = (ref: string, baseDir: string) =>
          allowedPreviewPath(path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref), target.cwd);
        return renderHtmlFile(target.abs, resolve).then((r) => {
          if (!r) { res.writeHead(404); res.end(JSON.stringify({ error: "not a readable file", code: "not-found" })); return; }
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ path: target.display, abs: target.abs, ...r }));
        });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Folders this conversation wrote into that `git status` cannot describe — a
  // scratch directory under /tmp, or the conversation's own folder when it isn't
  // a checkout at all. `dir` repeats, once per candidate: the client derives them
  // from the thread's own tool calls (it is the only side that knows what the
  // conversation did), and allowedOutputFolder decides which of them get listed.
  // A refused candidate is simply absent from the response — it was refused for
  // being noise or for being git's job, and neither is news.
  if (consoleEnabled && pathname === "/workspace/outputs") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const cwd = resolveWithinRoot(q.get("cwd") ?? "");
    if (!cwd) { res.writeHead(400); res.end(JSON.stringify({ error: "cwd outside root", code: "outside-root" })); return; }
    const wanted = q.getAll("dir").filter(Boolean).slice(0, MAX_OUTPUT_FOLDERS);
    Promise.all(wanted.map(async (dir) => {
      const abs = await allowedOutputFolder(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), cwd);
      return abs ? workspaceOutputFolder(abs) : null;
    }))
      .then((folders) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ folders: folders.filter(Boolean) }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  if (consoleEnabled && pathname === "/workspace/raw") {
    resolveWorkspaceTarget(new URL(req.url ?? "/", "http://x").searchParams)
      .then((target) => {
        if (!target) { res.writeHead(400); res.end(); return; }
        serveWorkspaceRaw(res, target.abs);
      })
      .catch(() => { res.writeHead(500); res.end(); });
    return;
  }
  // The review draft for one diff. GET returns that scope's comments plus the
  // per-scope counts (what puts a badge on the Review tab before anything is
  // opened); POST replaces that scope's comments wholesale.
  //
  // The ONE write in the whole /workspace surface, so what it may touch is
  // narrowed on every axis available:
  //   - the same cwd → FS_ROOT check every read here makes, first
  //   - the path is derived entirely server-side from `repoRoot(cwd)`; the
  //     client names a folder and a revision, never a file
  //   - review.ts refuses a `.acp-review` that is a symlink, so a hostile
  //     checkout cannot redirect the write out of the repo
  //   - a folder that is not a checkout gets no persistence rather than a
  //     hidden directory planted in it
  // POST rather than PUT to match the rest of this server, which has no PUT.
  if (consoleEnabled && pathname === "/workspace/review") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const cwd = resolveWithinRoot(q.get("cwd") ?? "");
    if (!cwd) { res.writeHead(400); res.end(JSON.stringify({ error: "cwd outside root", code: "outside-root" })); return; }
    const spec = revSpecFrom(q);
    if (spec === false) { res.writeHead(400); res.end(JSON.stringify({ error: "bad revision", code: "bad-revision" })); return; }
    const scope = reviewScopeKey(spec);
    repoRoot(cwd)
      .then((root) => {
        // No checkout, no drafts. Review mode has nothing to show in a folder
        // git knows nothing about, so there is nothing to persist — and the
        // gateway does not plant a hidden directory in an arbitrary folder.
        if (!root) {
          if (req.method === "POST") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ saved: false, reason: "not-a-repo" })); return; }
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ scope, comments: [], counts: {}, persisted: false }));
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({
            scope,
            comments: readDraft(root, scope),
            counts: Object.fromEntries(
              Object.entries(readDrafts(root)).map(([k, d]) => [k, d.comments.length]),
            ),
            persisted: true,
          }));
          return;
        }
        readJsonBody(req, MAX_DRAFTS_BYTES)
          .then((parsed) => {
            const comments = parseComments((parsed as { comments?: unknown } | null)?.comments);
            if (!comments) { res.writeHead(400); res.end(JSON.stringify({ error: "bad comments", code: "bad-comments" })); return; }
            // A failed write is reported, not thrown: the comments are in the
            // client's hands either way, and a read-only checkout should cost
            // the persistence rather than the review.
            const saved = writeDraft(root, scope, comments);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ saved, ...(saved ? {} : { reason: "write-failed" }) }));
          })
          .catch((e: Error) => {
            const tooBig = e.message === "too-large";
            res.writeHead(tooBig ? 413 : 400);
            res.end(JSON.stringify({ error: tooBig ? "draft too large" : "bad request" }));
          });
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Pinned ("favorite") folders, persisted server-side so they survive a client
  // switching device or source IP (browser localStorage is per-origin and can't).
  // GET returns the list (seeded once from the agents' cwds); POST ?path= toggles.
  if (consoleEnabled && pathname === "/folders/pinned") {
    try {
      if (req.method === "POST") {
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        const raw = q.get("path") ?? "";
        // Unpinning an existing entry is always allowed; pinning a new path must
        // resolve within FS_ROOT — the same guard the folder picker enforces.
        if (db().isPinned(raw)) {
          db().unpin(raw);
        } else {
          const safe = resolveWithinRoot(raw);
          if (!safe) { res.writeHead(400); res.end(); return; }
          db().pin(safe);
        }
      } else if (req.method !== "GET") {
        res.writeHead(405); res.end(); return;
      }
      const pinned = req.method === "GET"
        ? db().seedPinnedFolders(Object.values(cfg.agents).map((a) => a.cwd))
        : db().pinnedFolders();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pinned }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  // Cross-device UI state that used to live in browser localStorage (text size,
  // screen-lock config, recent sessions/folders). Persisted server-side so the
  // single gateway account sees the same prefs from any device — like SSHing into
  // one machine. GET /prefs hydrates all of it in one round-trip on page load; the
  // /prefs/* mutators each return the updated slice. The live locked/unlocked state
  // is NOT here — it stays per-device in the browser store.
  if (consoleEnabled && pathname === "/prefs") {
    try {
      const lockRaw = db().getMeta("screen_lock");
      let lock: unknown = null;
      if (lockRaw) { try { lock = JSON.parse(lockRaw); } catch { lock = null; } }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        textSize: db().getMeta("text_size"),
        lock,
        recentSessions: db().recentSessions(),
        recentFolders: db().recentFolders(),
      }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (consoleEnabled && pathname === "/prefs/text-size") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    try {
      const value = new URL(req.url ?? "/", "http://x").searchParams.get("value") ?? "";
      db().setMeta("text_size", value);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ textSize: value }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  // Screen-lock config blob (PBKDF2-hashed PIN, salt, iterations). The
  // gateway treats it as opaque JSON — all hashing/verification happens in-browser.
  // POST ?config=<json> sets it; DELETE clears it (turns the lock off).
  if (consoleEnabled && pathname === "/prefs/lock") {
    try {
      if (req.method === "DELETE") {
        db().deleteMeta("screen_lock");
      } else if (req.method === "POST") {
        const raw = new URL(req.url ?? "/", "http://x").searchParams.get("config") ?? "";
        // Reject anything that isn't a JSON object, so a malformed write can't wedge
        // the GET /prefs parse for every device.
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        if (!parsed || typeof parsed !== "object") { res.writeHead(400); res.end(); return; }
        db().setMeta("screen_lock", JSON.stringify(parsed));
      } else {
        res.writeHead(405); res.end(); return;
      }
      const lockRaw = db().getMeta("screen_lock");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ lock: lockRaw ? JSON.parse(lockRaw) : null }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (consoleEnabled && pathname === "/prefs/recent-session") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    try {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const agentName = q.get("agent") ?? "";
      const cwd = q.get("cwd") ?? "";
      const sessionId = q.get("session") ?? "";
      const title = q.get("title") ?? "";
      const lastActiveAt = q.get("at") ?? new Date().toISOString();
      // seed=1: the client DERIVED this title (no custom name in hand) and it may
      // only name a row that doesn't exist yet — see Db.touchRecentSession. Absent
      // on a rename, which is the one write that's allowed to replace a title.
      const seedTitle = q.get("seed") === "1";
      if (!agentName || !cwd || !sessionId) { res.writeHead(400); res.end(); return; }
      const recentSessions = db().touchRecentSession({ agentName, cwd, sessionId, title, lastActiveAt }, seedTitle);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ recentSessions }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (consoleEnabled && pathname === "/prefs/recent-folder") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    try {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      // A recent folder is somewhere the user actually browsed to, so it must
      // resolve within FS_ROOT — same guard the folder picker and pinning enforce.
      const safe = resolveWithinRoot(q.get("path") ?? "");
      if (!safe) { res.writeHead(400); res.end(); return; }
      const lastUsedAt = q.get("at") ?? new Date().toISOString();
      const recentFolders = db().touchRecentFolder(safe, lastUsedAt);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ recentFolders }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  // List past conversations for a cwd (fast: by mtime, cheap titles). The cwd is
  // taken from ?cwd= (validated within FS_ROOT), else the agent's default cwd.
  if (consoleEnabled && pathname === "/history") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const prof = cfg.agents[q.get("agent") ?? cfg.defaultAgent];
    const cwd = resolveWithinRoot(q.get("cwd") ?? "") ?? (prof ? prof.cwd : null);
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "30", 10) || 30, 1), 200);
    if (!cwd) { res.writeHead(400); res.end(); return; }
    listAgentHistory(prof?.cmd ?? "", cwd, limit)
      .then((sessions) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Discover sessions that exist in an agent's own store even when the gateway
  // has never opened their cwd — Claude Code's ~/.claude/projects (whose encoded
  // dir name is lossy, so the real cwd is recovered from each transcript) and
  // Codex's CODEX_HOME rollouts (whose head line records the cwd outright).
  // Either way the recovered cwd then gets the same FS_ROOT guard as normal
  // history browsing. Providers outside DISCOVERABLE_PROVIDERS answer empty.
  if (consoleEnabled && pathname === "/history/discovered") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const prof = cfg.agents[q.get("agent") ?? cfg.defaultAgent];
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "30", 10) || 30, 1), 200);
    if (!supportsHistoryDiscovery(prof?.cmd ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    (historyProviderFor(prof?.cmd ?? "") === "codex" ? discoverCodexHistory({ limit }) : discoverClaudeHistory({ limit }))
      .then((sessions) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Content search across past conversations, spanning every folder and every
  // searchable agent. Unlike /history and /history/discovered this returns
  // message TEXT, so the FS_ROOT guard inside searchCandidates is a real leak
  // boundary rather than a listing nicety — see I2 in the design doc.
  if (consoleEnabled && pathname === "/history/search") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const params = searchQueryParams(q, Date.now());
    if (!params) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "query must be at least 2 characters" }));
      return;
    }
    // An explicitly-supplied cwd that fails the root check is a client error, not
    // a silently-widened search.
    const rawCwd = q.get("cwd");
    const cwd = rawCwd ? resolveWithinRoot(rawCwd) : null;
    if (rawCwd && !cwd) { res.writeHead(400); res.end(); return; }
    const agents = Object.entries(cfg.agents).map(([name, a]) => ({ name, cmd: a.cmd }));
    searchTranscripts(agents, params, { cwd })
      .then((r) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // This account's quota windows — Claude by default, Codex's ChatGPT-backend
  // counterpart on `?kind=codex`. Independent of any session — the ACP
  // rate-limit path only reports after a turn, and usually without a percentage.
  // Only the normalized windows go out; the OAuth token stays in the gateway.
  if (consoleEnabled && pathname === "/usage/limits") {
    const kind = new URL(req.url ?? "/", "http://x").searchParams.get("kind");
    const limitsFor = kind === "codex" ? codexUsageLimits({ codexHome: codexHome() }) : usageLimits({ claudeDir: CLAUDE_DIR });
    limitsFor
      .then((limits) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(limits));
      })
      // A quota lookup failing must never surface as a 500 the poller retries
      // hard; it is the same "we don't know" the credential paths report.
      .catch(() => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ status: "unavailable", reason: "network" }));
      });
    return;
  }
  // Sessions whose prompt is currently running, across all agents. Polled by the
  // UI to surface concurrent tasks and let the user jump to them.
  if (consoleEnabled && pathname === "/running") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tasks: gateway.running() }));
    return;
  }
  // Durable notification inbox, across all agents. Polled by the UI to surface
  // pending permission prompts (and later other kinds) that survive a reload and
  // are visible even for agents this client has no live SSE connection to.
  if (consoleEnabled && pathname === "/inbox") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const status = (q.get("status") ?? "") as InboxStatus;
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "100", 10) || 100, 1), 1000);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: gateway.inbox({ status: status || undefined, limit }) }));
    return;
  }
  // Answer a pending permission server-side: the gateway routes the chosen option
  // to the live agent, so any device can answer a prompt for any agent without
  // holding that agent's SSE connection.
  if (consoleEnabled && handleInboxAnswerRequest(gateway, req, res)) return;
  // Rename a conversation (persist a custom title to the per-cwd sidecar).
  if (consoleEnabled && pathname === "/history/rename") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const prof = cfg.agents[q.get("agent") ?? cfg.defaultAgent];
    const cwd = resolveWithinRoot(q.get("cwd") ?? "") ?? (prof ? prof.cwd : null);
    const session = q.get("session");
    if (!cwd || !session) { res.writeHead(400); res.end(); return; }
    writeTitle(cwd, session, q.get("title") ?? "")
      // The sidecar is only half the story: every device also reads titles from
      // the recents table, whose rows are snapshots taken when the conversation
      // was last touched. The renaming client updates its own row by POSTing
      // /prefs/recent-session, but a conversation can hold several rows (a second
      // agent sharing the provider, a raw-vs-realpath'd spelling of the folder),
      // and any row missed here rehydrates the OLD name on the next /prefs load.
      //
      // A CLEARED rename needs the same treatment, or the rows keep serving a
      // custom title the user just deleted — so re-derive what the listing now
      // calls this conversation and store that instead. Only the cleared path pays
      // for the listing, and a rename is a rare, explicit action.
      .then(async (title) => {
        const effective = title || (await listAgentHistory(prof?.cmd ?? "", cwd, RENAME_DERIVE_LIMIT))
          .find((s) => s.sessionId === session)?.title;
        if (effective) db().renameRecentSession(session, effective);
        // The running-task label is a third copy of the title, held in memory per
        // channel, and /running is what the sidebar's Running section renders from
        // while a conversation is working — leaving it stale is why a renamed
        // conversation reverts to its old name for the length of a turn.
        gateway.renameSession(session, effective ?? "");
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // Permanently delete a conversation: the agent's own transcript AND every
  // gateway-side record of it. Skipping the latter isn't cosmetic — the recents
  // row rehydrates from /prefs on the next load (resurrecting a conversation that
  // now 404s), the transcript cache keeps feeding the recency ranking, and a
  // pending prompt lingers in the inbox as a badge nothing can answer.
  if (consoleEnabled && pathname === "/history/session") {
    if (req.method !== "DELETE") { res.writeHead(405); res.end(); return; }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    // Addressed by session id alone — no agent, no cwd; see deleteHistorySession.
    // Same id sanitizing as /history/messages (underscores for opencode).
    const sid = (q.get("session") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!sid) { res.writeHead(400); res.end(); return; }
    // A running turn is still appending to the transcript. Unlinking it now would
    // leave the agent writing to an unlinked inode and silently break session/load.
    // Matched on the id across every agent: two agents can share a provider, so the
    // one running this conversation isn't necessarily the one you came in under.
    if (gateway.running().some((t) => t.sessionId === sid)) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "conversation is running" }));
      return;
    }
    deleteHistorySession(Object.values(cfg.agents).map((a) => a.cmd), sid, { withinRoot: (c) => resolveWithinRoot(c) !== null })
      .then((deleted) => {
        // Runs even when the transcript was already gone, so a conversation left
        // half-present (transcript deleted outside the gateway) can still be tidied.
        // All three span every agent — a conversation recorded under two agents
        // sharing a provider must not keep half its rows and resurrect.
        db().deleteRecentSession(sid);
        db().deleteTranscriptMeta(sid);
        db().deleteSessionControls(sid);
        db().cancelInboxForSessionId(sid, new Date().toISOString());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, deleted }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  // View one conversation's messages without resuming the agent (no claude spawn).
  if (consoleEnabled && pathname === "/history/messages") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const prof = cfg.agents[q.get("agent") ?? cfg.defaultAgent];
    const cwd = resolveWithinRoot(q.get("cwd") ?? "") ?? (prof ? prof.cwd : null);
    // Allow underscores: opencode session ids look like `ses_…` (claude/codex use
    // UUIDs). Still no slashes or dots, so this can't escape the session store.
    const sid = (q.get("session") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    const { limit, from, to } = historyPageParams(q);
    if (!cwd || !sid) { res.writeHead(400); res.end(); return; }
    const agentName = q.get("agent") ?? cfg.defaultAgent;
    readAgentHistoryMessages(prof?.cmd ?? "", cwd, sid, limit, { from, to })
      .then((r) => {
        if (!r) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        // What this conversation last ran on. Rides along because this is the only
        // request an unresumed conversation makes: the agent holds no session for it
        // yet, so nothing else can say what its model and thinking level were.
        // transcriptStore() rather than db(): an unopenable store degrades to no
        // controls, which is what a conversation from before this was tracked
        // reports anyway — never a 500 on the page of messages.
        const controls = Object.fromEntries(transcriptStore()?.sessionControls(agentName, sid) ?? []);
        res.end(JSON.stringify({ ...r, controls }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
    return;
  }
  if (consoleEnabled && pathname === "/raw") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CONSOLE_HTML);
    return;
  }
  if (consoleEnabled && (pathname === "/" || pathname === "/console")) {
    // no-store, because this is the one document that must never be stale: it
    // names the content-hashed asset bundle, which is served `immutable`. With
    // no cache directive at all a browser is free to reuse it heuristically
    // (iOS Safari does), and a cached index.html pins the old hash — whose
    // asset then legitimately never revalidates. That combination survives a
    // reload and makes a deploy look like it silently didn't happen.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(loadChatHtml() || CONSOLE_HTML); // per-request; fall back to raw poker if file missing
    return;
  }
  // Static assets for the console (e.g. the bundled markdown renderer at
  // /vendor/md.js). Served from public/ with a path-traversal guard.
  if (consoleEnabled && pathname.startsWith("/vendor/")) {
    const safe = pathname.replace(/\.\.+/g, "").replace(/^\/+/, "");
    const base = path.join(ROOT, "public");
    const file = path.join(base, safe);
    if (file.startsWith(base + path.sep) && fs.existsSync(file)) {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "max-age=3600",
      });
      res.end(fs.readFileSync(file));
      return;
    }
  }
  // Static assets for the SPA (Vite emits hashed files under web/dist/assets).
  if (consoleEnabled && pathname.startsWith("/assets/")) {
    const safe = pathname.replace(/\.\.+/g, "").replace(/^\/+/, "");
    const base = path.join(ROOT, "web", "dist");
    const file = path.join(base, safe);
    if (file.startsWith(base + path.sep) && fs.existsSync(file)) {
      const ext = path.extname(file);
      const ct = ext === ".css" ? "text/css; charset=utf-8"
        : ext === ".js" ? "application/javascript; charset=utf-8"
        : ext === ".woff2" ? "font/woff2"
        : "application/octet-stream";
      res.writeHead(200, { "content-type": ct, "cache-control": "max-age=31536000, immutable" });
      res.end(fs.readFileSync(file));
      return;
    }
  }
  res.writeHead(404);
  res.end();
}

// Auto-start the listener as the real entrypoint. Tests import this module for
// makeTestServer() (which spins up its own ephemeral-port server) and set
// ACPG_NO_LISTEN=1 so importing the module does not bind the real port — nor
// resolve TLS, which could otherwise mint a self-signed cert on import.
if (process.env.ACPG_NO_LISTEN !== "1") {
  // A restart killed every agent subprocess, so any permission left pending in
  // the inbox from the previous run is no longer answerable — record it expired.
  gateway.expireStalePending();
  const tls = resolveTls(tlsOptions); // null when ACPG_TLS=off
  const server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, handleRequest)
    : http.createServer(handleRequest);
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error("server error:", err);
    process.exit(1);
  });

  const [host, portStr] = cfg.listen.split(":");
  server.listen(parseInt(portStr || "8080", 10), host || "0.0.0.0", () => {
    const scheme = tls ? "https" : "http";
    const interfaces = os.networkInterfaces();
    console.log(
      `acp-gateway: listening on ${scheme}://${cfg.listen} (SSE ${cfg.ssePath} + POST ${cfg.rpcPath}) | agents=[${Object.keys(
        cfg.agents,
      ).join(", ")}] default="${cfg.defaultAgent}"`,
    );
    console.log("reachable URLs:");
    if (consoleEnabled) {
      for (const url of accessUrls({ listen: cfg.listen, path: "/", scheme, interfaces })) {
        console.log(`  console: ${url}`);
      }
    }
    for (const url of accessUrls({ listen: cfg.listen, path: cfg.ssePath, scheme, interfaces })) {
      console.log(`  mobile ACP (SSE): ${url}`);
    }
    if (!tls) {
      console.log("tls: OFF (plain HTTP) — front with a TLS proxy, or unset ACPG_TLS=off to auto-generate a cert");
    } else if (tls.generated) {
      console.log(`tls: generated self-signed cert ${tls.certFile} (reused on restart; clients must trust it or set rejectUnauthorized:false)`);
    } else {
      console.log(`tls: using cert ${tls.certFile}`);
    }
    if (consoleEnabled) {
      console.log(
        `console: ${scheme}://${cfg.listen}/ (chat UI) | ${scheme}://${cfg.listen}/raw (frame poker) — Basic auth: ACPG_AUTH_USER + ACPG_AUTH_TOKEN`,
      );
    }
  });

  // Periodically reap idle sessions so an idle session's backing CLI (claude/codex
  // spawn one per session) doesn't outlive its TTL. Cadence is a fraction of the
  // TTL, capped at 30s; unref'd so it never holds the process open on its own.
  const sweepMs = Math.min(30_000, SESSION_IDLE_TTL_MS);
  const reaper = setInterval(() => gateway.reapIdleSessions(), sweepMs);
  reaper.unref?.();

  const shutdown = () => {
    console.log("shutting down");
    clearInterval(reaper);
    gateway.killAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ----------------------------------------------------------- test helper ----
// Exported only for use in e2e tests. Spins up a Gateway + HTTP server (SSE+POST)
// on an ephemeral port, backed by a fake agent (no real process spawned).
export interface FakeAgentHandle {
  sent: string[];
  emit(frame: Buffer): void;
  // Simulate the agent process dying (crash / respawn). Drives the Channel's
  // onExit path so tests can assert in-flight requests get settled.
  exit(): void;
}

export async function makeTestServer(opts?: {
  // This agent's configured control defaults (agents.json `defaults`).
  defaults?: Record<string, string>;
  // Reuse an existing ledger dir — i.e. an existing state.sqlite, so a test can
  // restart the gateway and assert on what survived.
  ledgerDir?: string;
}): Promise<{
  port: number;
  ledgerDir: string;
  agent: () => FakeAgentHandle;
  running: (now?: number) => Array<{ agentName: string; sessionId: string; state: TaskState; cwd?: string; title?: string }>;
  renameSession: (sessionId: string, title: string) => void;
  sessionLoad: (name: string) => boolean | undefined;
  inbox: (opts?: { status?: InboxStatus; agentName?: string; limit?: number }) => InboxItem[];
  answerInbox: (agentName: string, reqId: string, optionId: string) => boolean;
  failNextLedgerAppend: () => void;
  // Force an idle-session sweep at the given wall-clock (tests pass a future `now`
  // to make the TTL elapse without waiting).
  reap: (now?: number) => void;
  close: () => Promise<void>;
}> {
  const agents = { claude: { cmd: "x", args: [], cwd: process.cwd(), defaults: opts?.defaults } };
  // A fresh ledger dir per server so tests are isolated — otherwise every test would
  // share (and accumulate seqs in) one ./data/ledger.claude.jsonl, breaking any test
  // that asserts on replay content. Passed in only to restart onto the same state.
  const ledgerDir = opts?.ledgerDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "acpb-test-"));
  let fake: FakeAgentHandle & { send(f: Buffer): void; kill(): void; restart(): void };
  const b = new Gateway(
    agents as Record<string, AgentProfile>,
    ledgerDir,
    (_p, cb, onExit) => {
      fake = {
        sent: [],
        emit: cb,
        exit: onExit,
        send(f: Buffer) { this.sent.push(f.toString("utf8").trim()); },
        kill() {},
        restart() {},
      };
      return fake;
    },
    undefined,
    true, // reapAlways: the fake agent's cmd ("x") isn't claude/codex, so force it on
  );
  // Pre-create the channel so the fake agent is initialised before the first
  // client connects (the agent factory runs lazily on first channel() call).
  const testChannel = b.channel("claude");
  // Serve the SSE/POST transport through the same production code path so the e2e
  // tests exercise the real handler (auth uses the test "u"/"t" credentials).
  const srv = http.createServer((req, res) => {
    if (handleSseRpc(b, req, res, {
      ssePath: "/acp/sse",
      rpcPath: "/acp/rpc",
      sseKeepaliveMs: 1000,
      maxPayload: 16 * 1024 * 1024,
      defaultAgent: "claude",
      authOk: (authorization, user, token) =>
        wsAuthOk({ authorization, user, token, expectedUser: "u", expectedPass: "t" }),
    })) return;
    if (handleInboxAnswerRequest(b, req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as import("node:net").AddressInfo;
  return {
    port,
    ledgerDir,
    agent: () => fake,
    running: (now?: number) => b.running(now),
    renameSession: (sessionId: string, title: string) => b.renameSession(sessionId, title),
    sessionLoad: (name: string) => b.sessionLoad(name),
    inbox: (opts) => b.inbox(opts),
    answerInbox: (agentName, reqId, optionId) => b.answerInboxPermission(agentName, reqId, optionId),
    failNextLedgerAppend: () => {
      const ledger = testChannel.ledger;
      const append = ledger.append.bind(ledger);
      ledger.append = ((frame: Buffer, sid: string | null) => {
        ledger.append = append;
        throw new Error("injected ledger append failure");
      }) as Ledger["append"];
    },
    reap: (now?: number) => b.reapIdleSessions(now),
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
