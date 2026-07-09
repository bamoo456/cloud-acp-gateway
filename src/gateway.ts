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
import { Ledger } from "./ledger.ts";
import { basicAuthOk, wsAuthOk } from "./auth.ts";
import { resolveTls } from "./tls.ts";
import { accessUrls } from "./access.ts";
import { Db, type InboxItem, type InboxStatus } from "./db.ts";
import Database from "better-sqlite3";
import { handleLogin, getSession, registerLoginAgent } from "./login.ts";

const ROOT = path.join(__dirname, "..");

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
type AgentProfile = { cmd: string; args: string[]; cwd: string };

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
// Initial guess used only until the agent reports its real capability at
// initialize (see Gateway.sessionLoad). Older codex-acp couldn't resume over ACP;
// current builds report loadSession:true, and the handshake then overrides this.
export function supportsAgentSessionLoad(cmd: string): boolean {
  return !path.basename(cmd).includes("codex-acp");
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
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(projectsRoot, d.name, sessionId + ".jsonl");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Locate the project dir for a cwd: the computed name when it exists, else the
// dir whose newest transcript records this cwd (realpath-compared, since all
// transcripts in one project dir share the same cwd). Covers listing sessions
// for a cwd whose encoded name the CLI truncated.
export async function findClaudeProjectDir(cwd: string, projectsRoot = claudeProjectsRoot()): Promise<string | null> {
  const primary = path.join(projectsRoot, encodeProjectPath(cwd));
  if (fs.existsSync(primary)) return primary;
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

// Custom conversation titles (from rename) — a per-cwd sidecar next to the
// session files. claude-code owns the .jsonl files, so titles live separately.
const titlesFile = (cwd: string) => path.join(projectDirFor(cwd), ".acpb-titles.json");
async function readTitles(cwd: string): Promise<Record<string, string>> {
  try {
    const o = JSON.parse(await fs.promises.readFile(titlesFile(cwd), "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch { return {}; }
}
async function writeTitle(cwd: string, sessionId: string, title: string): Promise<void> {
  const t = await readTitles(cwd);
  const trimmed = title.trim().slice(0, 120);
  if (trimmed) t[sessionId] = trimmed; else delete t[sessionId]; // empty title reverts to the derived one
  await fs.promises.mkdir(projectDirFor(cwd), { recursive: true });
  await fs.promises.writeFile(titlesFile(cwd), JSON.stringify(t));
}

// ACPG_FS_ROOT bounds which host directories the console may browse and pick as
// a cwd. Everything must resolve within it (realpath + prefix guard).
const FS_ROOT = (() => {
  const r = process.env.ACPG_FS_ROOT || os.homedir();
  try { return fs.realpathSync(r); } catch { return path.resolve(r); }
})();
function resolveWithinRootBase(p: string, root: string): string | null {
  if (!p) return null;
  let safeRoot: string;
  try { safeRoot = fs.realpathSync(root); } catch { safeRoot = path.resolve(root); }
  let abs: string;
  try { abs = fs.realpathSync(path.resolve(p)); } catch { abs = path.resolve(p); }
  return abs === safeRoot || abs.startsWith(safeRoot + path.sep) ? abs : null;
}
export function resolveWithinRoot(p: string): string | null {
  return resolveWithinRootBase(p, FS_ROOT);
}
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
type ViewBlock = {
  type: "text" | "thought" | "tool" | "tool_result" | "image";
  text?: string; name?: string;
  toolCallId?: string; status?: "completed" | "failed"; output?: string;
  // image blocks: raw base64 in `data` (+ `mimeType`) or a link in `uri`
  mimeType?: string; data?: string; uri?: string;
};
type HistorySessionItem = { sessionId: string; title: string | null; updatedAt: string };
type DiscoveredHistorySessionItem = HistorySessionItem & { cwd: string; source: "claude-cli" };
type HistoryMessagesResult = { messages: Array<{ role: "user" | "assistant"; blocks: ViewBlock[] }>; total: number; truncated: boolean };

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
    else if (b.type === "tool_use") out.push({ type: "tool", name: typeof b.name === "string" ? b.name : "tool", toolCallId: typeof b.id === "string" ? b.id : undefined });
    else if (b.type === "tool_result") out.push({ type: "tool_result", toolCallId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined, status: b.is_error ? "failed" : "completed", output: toolResultText(b.content) });
  }
  return out;
}

// Stream a session file just far enough to grab a title (first user text).
async function firstUserText(file: string): Promise<string | null> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let e: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
      try { e = JSON.parse(t); } catch { continue; }
      if (e.type !== "user" || e.isSidechain) continue;
      const blocks = normalizeContent(e.message?.content);
      const txt = blocks.find((b) => b.type === "text")?.text;
      if (txt && txt.trim()) {
        rl.close();
        return txt.trim().replace(/\s+/g, " ").slice(0, 80);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function claudeTranscriptSummary(file: string): Promise<{ cwd: string | null; title: string | null }> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let cwd: string | null = null;
  let title: string | null = null;
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let e: { type?: string; isSidechain?: boolean; cwd?: unknown; message?: { content?: unknown } };
      try { e = JSON.parse(t); } catch { continue; }
      if (!cwd && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
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
  return { cwd, title };
}

export async function discoverClaudeHistory(opts?: { projectsRoot?: string; fsRoot?: string; limit?: number }): Promise<DiscoveredHistorySessionItem[]> {
  const projectsRoot = opts?.projectsRoot ?? path.join(CLAUDE_DIR, "projects");
  const fsRoot = opts?.fsRoot ?? FS_ROOT;
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 200);
  let projects: fs.Dirent[];
  try { projects = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); } catch { return []; }

  const files: Array<{ sessionId: string; file: string; mtime: number }> = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries: fs.Dirent[];
    const dir = path.join(projectsRoot, project.name);
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("agent-")) continue;
      const file = path.join(dir, entry.name);
      try {
        const st = await fs.promises.stat(file);
        files.push({ sessionId: entry.name.replace(/\.jsonl$/, ""), file, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const out: DiscoveredHistorySessionItem[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (out.length >= limit) break;
    const summary = await claudeTranscriptSummary(f.file);
    if (!summary.cwd) continue;
    const cwd = resolveWithinRootBase(summary.cwd, fsRoot);
    if (!cwd) continue;
    const key = cwd + "\n" + f.sessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sessionId: f.sessionId,
      title: summary.title,
      updatedAt: new Date(f.mtime).toISOString(),
      cwd,
      source: "claude-cli",
    });
  }
  return out;
}

async function listClaudeHistory(cwd: string, limit: number, projectsRoot?: string): Promise<HistorySessionItem[]> {
  const dir = (await findClaudeProjectDir(cwd, projectsRoot)) ?? path.join(projectsRoot ?? claudeProjectsRoot(), encodeProjectPath(cwd));
  let files: string[];
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const sess = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  const stats = await Promise.all(
    sess.map(async (f) => {
      const fp = path.join(dir, f);
      try { const st = await fs.promises.stat(fp); return { f, fp, mtime: st.mtimeMs }; } catch { return null; }
    }),
  );
  const top = stats
    .filter((s): s is { f: string; fp: string; mtime: number } => !!s)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const custom = await readTitles(cwd); // custom (renamed) titles override the derived one
  return Promise.all(
    top.map(async (s) => {
      const sessionId = s.f.replace(/\.jsonl$/, "");
      return {
        sessionId,
        title: custom[sessionId] ?? (await firstUserText(s.fp)),
        updatedAt: new Date(s.mtime).toISOString(),
      };
    }),
  );
}

// Claude Code injects these as user-role text when a turn is interrupted — one
// per pending tool call, so a single cancel of a parallel-tool turn writes a
// whole run of them. They are bookkeeping, not something the user typed (the CLI
// hides them), so drop them from the rendered thread.
const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

export async function readClaudeHistoryMessages(file: string, sessionId: string, limit: number): Promise<HistoryMessagesResult> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const msgs: Array<{ role: "user" | "assistant"; blocks: ViewBlock[] }> = [];
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
  const total = msgs.length;
  const truncated = limit > 0 && total > limit;
  return { messages: truncated ? msgs.slice(-limit) : msgs, total, truncated };
}

type CodexIndexEntry = { id: string; thread_name?: string; updated_at?: string };
type CodexSessionFile = { id: string; cwd: string; file: string; updatedAt: string };

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

function codexMetaFromLine(line: Record<string, unknown> | null): { id: string; cwd: string; timestamp?: string } | null {
  const payload = line?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.cwd === "string"
    ? { id: p.id, cwd: p.cwd, timestamp: typeof p.timestamp === "string" ? p.timestamp : undefined }
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
  return { id: meta.id, cwd: meta.cwd, file, updatedAt: mtime || meta.timestamp || "" };
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
    if (!existing || dateValue(s.updatedAt) >= dateValue(existing.updatedAt)) byId.set(s.id, s);
  }
  return [...byId.values()];
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
    .filter((s) => sameCwd(s.cwd, cwd))
    .map((s) => ({ ...s, index: index.get(s.id) }))
    .sort((a, b) => dateValue(b.index?.updated_at || b.updatedAt) - dateValue(a.index?.updated_at || a.updatedAt))
    .slice(0, limit);
  return Promise.all(matching.map(async (s) => ({
    sessionId: s.id,
    title: custom[s.id] ?? s.index?.thread_name ?? (await firstCodexUserText(s.file)),
    updatedAt: s.index?.updated_at ?? s.updatedAt,
  })));
}

async function findCodexSessionFile(cwd: string, sessionId: string): Promise<CodexSessionFile | null> {
  const sessions = await listCodexSessionFiles();
  return sessions.find((s) => s.id === sessionId && sameCwd(s.cwd, cwd)) ?? null;
}

async function readCodexHistoryMessages(file: string, limit: number): Promise<HistoryMessagesResult> {
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const msgs: Array<{ role: "user" | "assistant"; blocks: ViewBlock[] }> = [];
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
  const total = msgs.length;
  const truncated = limit > 0 && total > limit;
  return { messages: truncated ? msgs.slice(-limit) : msgs, total, truncated };
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

async function readOpenCodeHistoryMessages(sessionId: string, limit: number): Promise<HistoryMessagesResult> {
  const msgs = withOpenCodeDb((db) => {
    const out: Array<{ role: "user" | "assistant"; blocks: ViewBlock[] }> = [];
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
  }, [] as Array<{ role: "user" | "assistant"; blocks: ViewBlock[] }>);
  const total = msgs.length;
  const truncated = limit > 0 && total > limit;
  return { messages: truncated ? msgs.slice(-limit) : msgs, total, truncated };
}

export async function listAgentHistory(cmd: string, cwd: string, limit: number, opts?: { projectsRoot?: string }): Promise<HistorySessionItem[]> {
  const provider = historyProviderFor(cmd);
  if (provider === "claude") return listClaudeHistory(cwd, limit, opts?.projectsRoot);
  if (provider === "codex") return listCodexHistory(cwd, limit);
  if (provider === "opencode") return listOpenCodeHistory(cwd, limit);
  return [];
}

export async function readAgentHistoryMessages(cmd: string, cwd: string, sessionId: string, limit: number, opts?: { projectsRoot?: string }): Promise<HistoryMessagesResult | null> {
  const provider = historyProviderFor(cmd);
  if (provider === "claude") {
    // Resolve via the computed path first, then by session id anywhere under
    // the projects root — see findClaudeSessionFile for why the computed name
    // alone 404s transcripts that exist (CLI long-path truncation, stale cwd).
    const base = opts?.projectsRoot ?? claudeProjectsRoot();
    const file = await findClaudeSessionFile(cwd, sessionId, base);
    if (!file || !file.startsWith(base + path.sep)) return null;
    return readClaudeHistoryMessages(file, sessionId, limit);
  }
  if (provider === "codex") {
    const found = await findCodexSessionFile(cwd, sessionId);
    if (!found) return null;
    return readCodexHistoryMessages(found.file, limit);
  }
  if (provider === "opencode") {
    // Scope to the requesting cwd: the id is globally unique, but confirm the
    // session's project directory matches so one cwd can't read another's thread.
    const sessions = listOpenCodeSessions();
    const found = sessions.find((s) => s.id === sessionId && typeof s.directory === "string" && sameCwd(s.directory, cwd));
    if (!found) return null;
    return readOpenCodeHistoryMessages(sessionId, limit);
  }
  return null;
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
// Completion is detected from the prompt's response (precise, immediate). The TTL
// is only a safety net for the cases where that response never arrives — the
// client disconnected mid-turn (its idmux entry is forgotten) or the agent died
// between heartbeats. It is deliberately generous so normal completion is never
// driven by it. "awaiting-input" never expires by TTL: a human can take any
// amount of time to answer, so it clears only when the user cancels the turn,
// the agent resumes (a fresh frame), the turn ends (response), or the agent exits.
const TASK_TTL_MS = 45_000;

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
const SESSION_IDLE_TTL_MS = Math.max(10_000, Number(process.env.ACPG_SESSION_IDLE_TTL_MS) || 180_000);
// Gateway-originated requests (the reaping session/close and the transparent
// session/load) carry a fake origin conn id so their agent response/replay routes
// to no real connection and is harmlessly dropped. Two distinct ids so logs can
// tell which path a stray frame came from.
const CLOSE_SENTINEL = "__gw_close__";
const REVIVE_SENTINEL = "__gw_revive__";

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
  // sessionId -> the cwd it runs in. Captured from session/new (paired on its
  // response, since the id isn't known until then), session/load, and any prompt
  // that carries a cwd. Surfaced in running() so cross-device tasks show the
  // correct folder and jump precisely. Cleared with tasks on agent exit.
  private sessionCwd = new Map<string, string>();
  // sessionId -> the text of its first prompt, used as the running-task label so
  // concurrent tasks in the same folder don't all collapse to a short id.
  private sessionTitle = new Map<string, string>();
  // agent request id -> the still-outstanding permission request (its session +
  // raw frame). A permission blocks the agent until someone answers, but a client
  // that drops (or reloads) reconnects at cursor=end and never sees the original
  // frame again. Re-delivered after that session's session/load so the prompt
  // survives reconnects; dropped once answered or when the agent exits.
  private pendingPerms = new Map<number | string, { sid: string; seq: number; frame: Buffer }>();
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

  // The least-recently-active live session with no in-flight task, or undefined if
  // all are busy (a running / awaiting-input turn is never reaped).
  private firstEvictable(): string | undefined {
    for (const sid of this.liveSessions.keys()) if (!this.tasks.has(sid)) return sid;
    return undefined;
  }

  // Reap sessions idle past the TTL. Driven by the gateway's periodic sweep (now
  // injectable for tests). A session with an in-flight task is skipped — its frames
  // keep it fresh anyway, and this guards the rare silently-running turn.
  reapIdle(now: number = Date.now()): void {
    if (!this.reapable) return;
    for (const [sid, e] of [...this.liveSessions]) {
      if (this.tasks.has(sid)) continue;
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
  private broadcast(seq: number, buf: Buffer, connIds?: string[]): void {
    const ids = connIds ?? [...this.conns.keys()];
    for (const id of ids) this.sendTo(id, seq, buf);
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
      const origin = this.idmux.inbound(Number(f.id));
      if (!origin) return;
      // A prompt's response ends its turn → the task is done. (If the origin was
      // forgotten — client gone mid-turn — the TTL clears it instead.)
      if (origin.method === "session/prompt" && origin.sessionId) this.tasks.delete(origin.sessionId);
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
      if (origin.method === "session/new") {
        const sid = (f.result as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof sid === "string") {
          this.subs.subscribe(origin.connId, sid);
          // The new session's id is known only now — pair it to the cwd the
          // session/new request carried so running() can report the folder.
          if (origin.cwd) this.sessionCwd.set(sid, origin.cwd);
          // A new session has a fresh backing CLI — start tracking it for reaping.
          this.touchSession(sid, origin.cwd);
        }
      }
      // session/load finished → stop gating that session's replay, resume broadcast
      const loaded = this.loadReq.get(Number(f.id));
      if (loaded !== undefined) { this.loadGate.delete(loaded); this.loadReq.delete(Number(f.id)); }
      this.sendTo(origin.connId, seq, Buffer.from(JSON.stringify({ ...f, id: origin.clientId })));
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
        // A transparent re-load (we reaped the session, then a client touched it)
        // just finished re-establishing it in the adapter — flush the client frames
        // that were parked behind it, in arrival order, now that prompts won't hit
        // "Session not found". Conns that dropped meanwhile are skipped.
        const queued = this.reviveQueue.get(loaded);
        if (queued) {
          this.reviveQueue.delete(loaded);
          for (const item of queued) {
            const c = this.conns.get(item.connId);
            const qf = c && parse(item.line);
            if (c && qf) this.forwardClientRequest(c, qf, item.line);
          }
        }
      }
      return;
    }
    // Requests and notifications are replayable broadcast frames: append with the
    // frame's session so the ledger's per-session index is built, and reuse the
    // assigned seq for every send of this frame below.
    const { seq } = this.ledger.append(line, sessionIdOf(f));
    if (isRequest(f)) {
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
      if (sid && f.id !== undefined && f.id !== null && f.method === "session/request_permission") {
        this.pendingPerms.set(f.id as string | number, { sid, seq, frame: line });
        // Mirror into the durable inbox so the prompt survives a reload and is
        // visible/answerable across agents via /inbox (pendingPerms stays the
        // in-run, low-latency re-delivery source; the inbox is the audit trail).
        const params = f.params as { toolCall?: { title?: string }; options?: unknown } | undefined;
        const options = Array.isArray(params?.options) ? params.options : [];
        this.store?.addInboxItem({
          type: "permission", agentName: this.name, sessionId: sid, reqId: String(f.id), seq,
          title: params?.toolCall?.title || "Run a tool",
          bodyJson: JSON.stringify(options), createdAt: new Date().toISOString(),
        });
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
    if (nsid && this.tasks.has(nsid)) this.tasks.set(nsid, { state: "active", lastSeen: Date.now() });
    if (nsid) this.touchSession(nsid); // any agent frame for a session keeps it alive
    if (nsid && this.loadGate.has(nsid)) { this.sendTo(this.loadGate.get(nsid)!, seq, line); return; }
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
      // reply to an agent→client request (permission). First reply wins, and the
      // prompt is now answered → stop re-delivering it on future reconnects.
      if (this.permGate.claim(f.id as string | number)) {
        this.pendingPerms.delete(f.id as string | number);
        this.store?.resolveInboxItem(this.name, String(f.id), "answered", new Date().toISOString(), JSON.stringify(f.result ?? f.error ?? null));
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
    }
    const gatewayId = this.idmux.outbound(conn.id, f.id as string | number, method || null, sid || undefined, cwd || undefined);
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
    const q = this.reviveQueue.get(sid) ?? [];
    q.push({ connId: conn.id, line });
    this.reviveQueue.set(sid, q);
    this.subs.subscribe(conn.id, sid);
    if (q.length > 1) return; // a re-load is already in flight for this session
    this.touchSession(sid, loadCwd || undefined); // re-tracks it (and clears `reaped`)
    const gid = this.idmux.outbound(REVIVE_SENTINEL, `revive:${sid}`, "session/load", sid, loadCwd || undefined);
    this.loadGate.set(sid, REVIVE_SENTINEL);
    this.loadReq.set(gid, sid);
    const out = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: gid, method: "session/load", params: { sessionId: sid, cwd: loadCwd, mcpServers: [] } }));
    if (this.isCodex) { void this.loadCodexWithRepair(sid, out); return; }
    this.agent.send(out);
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
    for (const k of this.pendingPerms.keys()) if (String(k) === reqId) { key = k; break; }
    if (key === undefined || !this.permGate.claim(key)) return false;
    this.pendingPerms.delete(key);
    const result = { outcome: { outcome: "selected", optionId } };
    this.store?.resolveInboxItem(this.name, reqId, "answered", new Date().toISOString(), JSON.stringify(result));
    this.agent.send(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: key, result })));
    return true;
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
  attach(sink: ClientSink, agentName: string, cursor: number): Conn {
    const ch = this.channel(agentName);
    const conn: Conn = { id: crypto.randomUUID(), sink };
    const afterSeq = Math.min(cursor, ch.ledger.headSeq());
    if (afterSeq < ch.ledger.floorSeq() - 1) {
      sink.send(ch.ledger.headSeq(), RELOAD_FRAME);
      ch.addConn(conn);
      return conn;
    }
    for (const e of ch.ledger.since(afterSeq)) sink.send(e.seq, e.frame);
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
    let conn: Conn;
    try {
      conn = gateway.attach(sink, agentName, cursor);
    } catch (e) {
      console.warn(`rejecting SSE connection: ${String(e)}`);
      res.end();
      return true;
    }
    // Hand the client its connection id so it can address upstream POSTs to rpcPath.
    res.write(`event: ready\ndata:${JSON.stringify({ conn: conn.id })}\n\n`);
    console.log(`client: SSE connected agent="${agentName}" conn=${conn.id} cursor=${cursor}`);
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
    gateway.fromClient(agentName, conn, Buffer.concat(chunks));
    res.writeHead(202);
    res.end();
  });
  req.on("error", () => { res.writeHead(400); res.end(); });
  return true;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
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
  // just agent names). The /acp/sse + /acp/rpc paths keep their own token check
  // and never pass through this handler.
  if (pathname !== "/healthz" && !basicAuthOk(req.headers.authorization, cfg.authUser, cfg.authToken)) {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="acp-gateway", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("authentication required\n");
    return;
  }
  if (pathname === "/healthz") {
    // Unauthenticated probe: expose only low-sensitivity data (status + agent
    // names). The richer agentDetails (cwd, history/resume flags) is reachable
    // only through the Basic-auth'd surface — it's injected into the chat SPA
    // config — so an open liveness probe never leaks host/project paths.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", agents: Object.keys(cfg.agents) }));
    return;
  }
  // Scoped, PTY-backed `claude auth login` terminal so credentials can be
  // re-authenticated from a remote/mobile browser when they expire. Sits behind
  // the same Basic-auth gate as the rest of the console surface.
  if (consoleEnabled && pathname.startsWith("/login/")) {
    if (handleLogin(req, res, pathname, cfg.maxPayload)) return;
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
      if (!agentName || !cwd || !sessionId) { res.writeHead(400); res.end(); return; }
      const recentSessions = db().touchRecentSession({ agentName, cwd, sessionId, title, lastActiveAt });
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
  // Discover Claude Code sessions that exist under ~/.claude/projects even when
  // the gateway has never opened their cwd. The encoded project dir name is
  // lossy, so this recovers the real cwd from each transcript and then applies
  // the same FS_ROOT guard as normal history browsing.
  if (consoleEnabled && pathname === "/history/discovered") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const prof = cfg.agents[q.get("agent") ?? cfg.defaultAgent];
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "30", 10) || 30, 1), 200);
    if (historyProviderFor(prof?.cmd ?? "") !== "claude") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    discoverClaudeHistory({ limit })
      .then((sessions) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions }));
      })
      .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); });
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
  if (consoleEnabled && pathname === "/inbox/answer") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const agent = q.get("agent") ?? "";
    const reqId = q.get("reqId") ?? "";
    const optionId = q.get("optionId") ?? "";
    if (!agent || !reqId || !optionId) { res.writeHead(400); res.end(); return; }
    const ok = gateway.answerInboxPermission(agent, reqId, optionId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return;
  }
  // Rename a conversation (persist a custom title to the per-cwd sidecar).
  if (consoleEnabled && pathname === "/history/rename") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const prof = cfg.agents[q.get("agent") ?? cfg.defaultAgent];
    const cwd = resolveWithinRoot(q.get("cwd") ?? "") ?? (prof ? prof.cwd : null);
    const session = q.get("session");
    if (!cwd || !session) { res.writeHead(400); res.end(); return; }
    writeTitle(cwd, session, q.get("title") ?? "")
      .then(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); })
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
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "120", 10) || 120, 1), 2000);
    if (!cwd || !sid) { res.writeHead(400); res.end(); return; }
    readAgentHistoryMessages(prof?.cmd ?? "", cwd, sid, limit)
      .then((r) => {
        if (!r) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

export async function makeTestServer(): Promise<{
  port: number;
  agent: () => FakeAgentHandle;
  running: (now?: number) => Array<{ agentName: string; sessionId: string; state: TaskState; cwd?: string; title?: string }>;
  sessionLoad: (name: string) => boolean | undefined;
  inbox: (opts?: { status?: InboxStatus; agentName?: string; limit?: number }) => InboxItem[];
  answerInbox: (agentName: string, reqId: string, optionId: string) => boolean;
  // Force an idle-session sweep at the given wall-clock (tests pass a future `now`
  // to make the TTL elapse without waiting).
  reap: (now?: number) => void;
  close: () => Promise<void>;
}> {
  const agents = { claude: { cmd: "x", args: [], cwd: process.cwd() } };
  // A fresh ledger dir per server so tests are isolated — otherwise every test would
  // share (and accumulate seqs in) one ./data/ledger.claude.jsonl, breaking any test
  // that asserts on replay content.
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-test-"));
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
  b.channel("claude");
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
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as import("node:net").AddressInfo;
  return {
    port,
    agent: () => fake,
    running: (now?: number) => b.running(now),
    sessionLoad: (name: string) => b.sessionLoad(name),
    inbox: (opts) => b.inbox(opts),
    answerInbox: (agentName, reqId, optionId) => b.answerInboxPermission(agentName, reqId, optionId),
    reap: (now?: number) => b.reapIdleSessions(now),
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
