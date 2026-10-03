/**
 * Bifrost Java go-to-definition — one long-lived `bifrost --lsp` subprocess per
 * repository, speaking LSP over stdio with Content-Length framing.
 *
 * Deliberately narrow: definition only, with a hard 2 s budget per request. A
 * miss (or a timeout, which is how an unresolvable symbol reads — slow and
 * empty) is an empty array, and the caller falls through to the agent Trace.
 * `initialize` is not readiness — Bifrost builds its index inside the first
 * real query — so each process is warmed with a no-match `workspace/symbol`,
 * and a request that arrives before that settles answers "indexing" instead.
 * A lookup past its click's budget is left to finish rather than killed, and a
 * click behind it answers "indexing" too: Bifrost serves one request at a time.
 * References/callers/callees stay with the agent; see the Phase 3 research note
 * at docs/superpowers/specs/2026-09-12-rust-java-lsp-phase3-research.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { gitCommonDir, repoRoot } from "./workspace.ts";

// Pinned in package.json (exact, no caret). engines.node >= 18, so the
// Node 20 twin runs it unchanged.
const BIFROST_VERSION = "0.11.4";
// A click's budget. Spent waiting on the warm-up, or on an earlier lookup the
// analyzer is still serving, it answers "indexing"; spent on the click's own
// definition, it is a miss.
export const BIFROST_DEFINITION_TIMEOUT_MS = 2000;
// A lookup past its click's budget is left to finish, not killed: an
// unresolvable symbol (a Lombok accessor, a library call) takes ~13 s the first
// time and ~13 ms after, because Bifrost caches the miss, while a respawn costs
// 1.5–2.2 s of cache reload on a 9k-file repo and 62–71 s on a 92k-file
// monorepo. Past this ceiling the analyzer is jammed, not slow.
const ANALYZER_CEILING_MS = 60_000;
// The warm-up query pays the cold index build — 7.5–8.5 s on a 9k-file Maven
// repo, 254 s on a 92k-file monorepo — so it gets a budget of its own.
const WARM_TIMEOUT_MS = 30 * 60 * 1000;
const WARM_QUERY = "zzz_acpg_warm_nomatch";
// One --lsp process holds 0.5–1 GB resident on a 9k-file repo and 4.3–4.9 GB
// on a 92k-file monorepo, so cap the live set and evict the idlest. Eviction
// waits half an hour because the next request then gets "indexing" while a
// respawn re-reads its cache — over a minute on the monorepo — and a reviewer
// reading one long diff makes no requests.
const MAX_SERVERS = 4;
const IDLE_EVICT_MS = 30 * 60 * 1000;

export interface BifrostLocation {
  uri: string;
  line: number; // 0-based
  character: number; // 0-based
  endLine?: number; // 0-based
  endCharacter?: number; // 0-based
}

// The only question the first cut asks: does this resolve often enough to keep.
const stats = { requests: 0, hits: 0, misses: 0, timeouts: 0, indexing: 0 };
export function bifrostStats(): { requests: number; hits: number; misses: number; timeouts: number; indexing: number } {
  return { ...stats };
}

// ACPG_LSP_JAVA=off|bifrost. Anything else is off — fail closed.
export function isBifrostEnabled(): boolean {
  return (process.env.ACPG_LSP_JAVA ?? "off").trim().toLowerCase() === "bifrost";
}

function gnuOrMusl(): "gnu" | "musl" {
  try {
    const report = (process as unknown as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }).report?.getReport?.();
    return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
  } catch {
    return "gnu";
  }
}

// The @brokkai/bifrost wrapper (bin/bifrost.js) spawns the native binary with
// inherited stdio, which is unusable as an LSP child — resolve the platform
// binary the same way it does and spawn that directly with pipes.
// `binaryForTest` is a fake LSP (or null = unavailable) for tests only.
let binaryForTest: string | null | undefined;

export function setBifrostBinaryForTest(pathOrNull: string | null): void {
  binaryForTest = pathOrNull;
}

function nativeBinaryPath(): string | null {
  if (binaryForTest !== undefined) return binaryForTest;
  const plat = process.platform;
  const arch = process.arch;
  const key = plat === "linux" ? `${plat}-${arch}-${gnuOrMusl()}` : `${plat}-${arch}`;
  const packages: Record<string, string> = {
    "darwin-arm64": "@brokkai/bifrost-darwin-universal",
    "darwin-x64": "@brokkai/bifrost-darwin-universal",
    "linux-arm64-gnu": "@brokkai/bifrost-linux-arm64-gnu",
    "linux-x64-gnu": "@brokkai/bifrost-linux-x64-gnu",
    "android-arm64": "@brokkai/bifrost-android-arm64",
    "win32-arm64": "@brokkai/bifrost-win32-arm64",
    "win32-x64": "@brokkai/bifrost-win32-x64",
  };
  const pkg = packages[key];
  if (!pkg) return null;
  try {
    const require = createRequire(path.join(__dirname, "bifrost.ts"));
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const bin = path.join(path.dirname(pkgJson), "bin", plat === "win32" ? "bifrost.exe" : "bifrost");
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export function bifrostBinaryPath(): string | null {
  return nativeBinaryPath();
}

// Where Bifrost keeps its SQLite index. Inside the gateway's own data dir,
// never in the checkout — left at its default it lands in `.bifrost/cache`
// under the repo. One subdir per repository key.
export function bifrostCacheDir(ledgerDir: string, key: string): string {
  const digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(ledgerDir, "bifrost-cache", digest);
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

class LspConn {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = Buffer.alloc(0);
  private dead = false;
  readonly onDeath: () => void;

  constructor(
    private bin: string,
    private root: string,
    private cacheDir: string,
    onDeath: () => void,
  ) {
    this.onDeath = onDeath;
  }

  start(): void {
    const env = {
      ...process.env,
      // Trust boundary, not tuning: company source is being analysed, so the
      // analyzer must not reach the network for semantic packs.
      BIFROST_SEMANTIC_PACK_DOWNLOAD: "off",
      BIFROST_CACHE_ROOT: this.cacheDir,
      BIFROST_CACHE_DIR: this.cacheDir,
      BIFROST_SEMANTIC_PACK_CACHE_ROOT: this.cacheDir,
    };
    const proc = spawn(this.bin, ["--lsp", "--root", this.root], {
      cwd: this.root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.proc = proc;
    proc.stdout?.on("data", (c: Buffer) => this.onData(c));
    proc.stderr?.on("data", () => { /* progress chatter; ignore */ });
    const die = () => this.die();
    proc.on("error", die);
    proc.on("exit", die);
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bifrost exited"));
    }
    this.pending.clear();
    this.onDeath();
  }

  // Tear the map entry down immediately, then SIGTERM the group. Waiting for
  // "exit" would leave a dying conn in `servers` for the next click to reuse.
  kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.die();
    if (!proc || proc.pid === undefined) return;
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* gone */ } }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headEnd = this.buf.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = this.buf.subarray(0, headEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(head);
      if (!m) { this.buf = this.buf.subarray(headEnd + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < headEnd + 4 + len) return;
      const body = this.buf.subarray(headEnd + 4, headEnd + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(headEnd + 4 + len);
      this.onMessage(body);
    }
  }

  private onMessage(body: string): void {
    let msg: { id?: unknown; result?: unknown; error?: unknown };
    try { msg = JSON.parse(body) as typeof msg; } catch { return; }
    if (typeof msg.id !== "number") return; // notification or server request — ignore
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) p.reject(new Error("bifrost: " + JSON.stringify(msg.error).slice(0, 200)));
    else p.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.dead || !this.proc?.stdin?.writable) return Promise.reject(new Error("bifrost not running"));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Past its ceiling the analyzer is jammed, not slow. Cancel, then kill:
        // Bifrost 0.11.4 ignores $/cancelRequest and serves one request at a
        // time, so nothing queued behind a jammed request would ever answer.
        this.notify("$/cancelRequest", { id });
        this.kill();
        reject(Object.assign(new Error("bifrost timeout"), { code: "timeout" }));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(frame, (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) { this.pending.delete(id); clearTimeout(p.timer); p.reject(err); }
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.dead || !this.proc?.stdin?.writable) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8");
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }
}

interface ServerEntry {
  key: string;
  root: string;
  conn: LspConn;
  lastUsed: number;
  // Settles once the warm-up query has built (or re-read) the index; `ready`
  // mirrors it synchronously so a request can tell without awaiting.
  init: Promise<void>;
  ready: boolean;
  // A definition the analyzer is still serving after its click gave up on it.
  busy: Promise<void> | null;
}

const servers = new Map<string, ServerEntry>();
// In-flight spawn per repository key: two overlapping warm/definition calls
// used to each pass `servers.get` as a miss and start a second 0.5–1 GB process.
const starting = new Map<string, Promise<ServerEntry>>();

function evictIdle(now = Date.now()): void {
  for (const [key, s] of servers) {
    // Never one still warming: nothing bumps lastUsed while it builds, and a
    // kill throws the half-built index away. WARM_TIMEOUT_MS bounds that.
    if (s.ready && now - s.lastUsed > IDLE_EVICT_MS) {
      servers.delete(key);
      s.conn.kill();
    }
  }
  // Resident set is ~0.5–1 GB per process at this scale: cap the live set and
  // drop the idlest first. A later request just respawns.
  while (servers.size > MAX_SERVERS) {
    let oldest: string | null = null;
    for (const [key, s] of servers) {
      if (oldest === null || s.lastUsed < servers.get(oldest)!.lastUsed) oldest = key;
    }
    if (oldest === null) break;
    servers.get(oldest)!.conn.kill();
    servers.delete(oldest);
  }
}

setInterval(evictIdle, 60_000).unref?.();

// Repository identity: worktrees of one checkout share a git common dir, so one
// review per worktree still shares one analyzer. Non-checkouts key on cwd.
export async function bifrostKeyFor(cwd: string): Promise<{ key: string; root: string }> {
  const common = await gitCommonDir(cwd);
  if (common) return { key: common, root: (await repoRoot(cwd)) ?? cwd };
  const root = await repoRoot(cwd);
  return { key: cwd, root: root ?? cwd };
}

async function ensureServer(cwd: string, ledgerDir: string): Promise<ServerEntry> {
  evictIdle();
  const { key, root } = await bifrostKeyFor(cwd);
  const hit = servers.get(key);
  if (hit) { hit.lastUsed = Date.now(); return hit; }
  const inflight = starting.get(key);
  if (inflight) return inflight;
  const started = startServer(key, root, ledgerDir).finally(() => {
    if (starting.get(key) === started) starting.delete(key);
  });
  starting.set(key, started);
  return started;
}

async function startServer(key: string, root: string, ledgerDir: string): Promise<ServerEntry> {
  const bin = nativeBinaryPath();
  if (!bin) throw Object.assign(new Error(`bifrost ${BIFROST_VERSION} native binary not installed`), { code: "unavailable" });
  const cacheDir = bifrostCacheDir(ledgerDir, key);
  fs.mkdirSync(cacheDir, { recursive: true });
  let entry: ServerEntry;
  const conn = new LspConn(bin, root, cacheDir, () => { if (servers.get(key) === entry) servers.delete(key); });
  entry = {
    key,
    root,
    conn,
    lastUsed: Date.now(),
    init: Promise.resolve(),
    ready: false,
    busy: null,
  };
  conn.start();
  entry.init = (async () => {
    await conn.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    }, 10_000);
    conn.notify("initialized", {});
    // initialize returns before indexing; the index is built inside the first
    // real query. A no-match symbol search builds it without a result to read.
    await conn.request("workspace/symbol", { query: WARM_QUERY }, WARM_TIMEOUT_MS);
    entry.ready = true;
  })();
  // A failed warm-up must not poison the map — the next request retries.
  entry.init.catch(() => { if (servers.get(key) === entry) { servers.delete(key); conn.kill(); } });
  servers.set(key, entry);
  evictIdle();
  return entry;
}

// Spawn (or reuse) and warm the analyzer for cwd's repository: call when a
// review opens so the cold index builds while the diff is read, not on the
// first click. Never throws — warming is best effort.
export function warmBifrost(cwd: string, ledgerDir: string): void {
  if (!isBifrostEnabled()) return;
  ensureServer(cwd, ledgerDir).then(
    (s) => { s.init.then(() => undefined, () => undefined); },
    () => undefined,
  );
}

function toLocations(result: unknown): BifrostLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: BifrostLocation[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    // Location | LocationLink — take the target side of either.
    const r = item as { uri?: unknown; range?: unknown; targetUri?: unknown; targetRange?: unknown };
    const uri = r.uri ?? r.targetUri;
    const range = (r.range ?? r.targetRange) as
      | { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
      | undefined;
    if (typeof uri !== "string" || !range?.start) continue;
    const line = range.start.line;
    const character = range.start.character;
    if (typeof line !== "number" || typeof character !== "number") continue;
    const loc: BifrostLocation = { uri, line, character };
    if (typeof range.end?.line === "number" && typeof range.end?.character === "number") {
      loc.endLine = range.end.line;
      loc.endCharacter = range.end.character;
    }
    out.push(loc);
  }
  return out;
}

const PAST_BUDGET = Symbol("past budget");

// p, or PAST_BUDGET once ms have passed. Unlike conn.request's own timeout,
// giving up here leaves the analyzer alone.
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof PAST_BUDGET> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof PAST_BUDGET>((r) => { timer = setTimeout(() => r(PAST_BUDGET), ms); })])
    .finally(() => clearTimeout(timer));
}

// Definition for a 0-based LSP position in an absolute file path. Empty array
// is the miss — a lookup past the budget included — and the caller falls
// through. "indexing" means the answer is still being built — the warm-up, or
// an earlier lookup the analyzer serves first — so the caller should neither
// Trace nor treat it as a miss.
export async function bifrostDefinition(
  cwd: string,
  abs: string,
  line: number,
  character: number,
  ledgerDir: string,
  timeoutMs = BIFROST_DEFINITION_TIMEOUT_MS,
  ceilingMs = ANALYZER_CEILING_MS,
): Promise<BifrostLocation[] | "indexing"> {
  stats.requests++;
  let realAbs = abs;
  try { realAbs = fs.realpathSync(abs); } catch { /* missing — let the analyzer answer */ }
  let result: unknown;
  try {
    const entry = await ensureServer(cwd, ledgerDir);
    if (!entry.ready) await within(entry.init, timeoutMs);
    // Sent behind a lookup the analyzer is still serving, this one would
    // queue past its budget and fall through to Trace for a symbol that
    // resolves.
    if (entry.ready && entry.busy) await within(entry.busy, timeoutMs);
    if (!entry.ready || entry.busy) { stats.indexing++; return "indexing"; }
    entry.lastUsed = Date.now();
    const req = entry.conn.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(realAbs).href },
      position: { line, character },
    }, ceilingMs);
    const busy: Promise<void> = req.then(() => undefined, (e: { code?: string }) => {
      // Past the ceiling conn.request killed it: warm a replacement now, so
      // the next click finds a process re-reading its cache.
      if (e?.code === "timeout") ensureServer(cwd, ledgerDir).catch(() => undefined);
    }).finally(() => { if (entry.busy === busy) entry.busy = null; });
    entry.busy = busy;
    result = await within(req, timeoutMs);
    if (result === PAST_BUDGET) { stats.timeouts++; return []; }
  } catch {
    stats.misses++;
    return [];
  }
  const locs = toLocations(result);
  if (locs.length) stats.hits++;
  else stats.misses++;
  return locs;
}

export function bifrostLocationPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

// Test seam: drop every live server (kills the processes).
export function resetBifrostForTest(): void {
  for (const [, s] of servers) s.conn.kill();
  servers.clear();
  starting.clear();
  binaryForTest = undefined;
  stats.requests = 0;
  stats.hits = 0;
  stats.misses = 0;
  stats.timeouts = 0;
  stats.indexing = 0;
}

export function bifrostLedgerDir(): string {
  return process.env.ACPG_LEDGER_DIR ?? "/data";
}
