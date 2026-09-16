/**
 * Bifrost Java go-to-definition — one long-lived `bifrost --lsp` subprocess per
 * repository, speaking LSP over stdio with Content-Length framing.
 *
 * Deliberately narrow: definition only, with a hard 2 s budget per request. A
 * miss (or a timeout, which is how an unresolvable symbol reads — slow and
 * empty) is an empty array, and the caller falls through to the agent Trace.
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
// initialize answers fast against an unindexed repo, but the index is then
// built inside the first query — up to ~17 s measured. A definition past this
// budget is a miss, not an answer.
export const BIFROST_DEFINITION_TIMEOUT_MS = 2000;
// One --lsp process holds ~0.5–1 GB resident on repos this size, so cap the
// live set and evict the idlest. A request that arrives after an eviction just
// pays a fresh spawn + warm.
const MAX_SERVERS = 4;
const IDLE_EVICT_MS = 5 * 60 * 1000;

export interface BifrostLocation {
  uri: string;
  line: number; // 0-based
  character: number; // 0-based
  endLine?: number; // 0-based
  endCharacter?: number; // 0-based
}

// The only question the first cut asks: does this resolve often enough to keep.
const stats = { requests: 0, hits: 0, misses: 0, timeouts: 0 };
export function bifrostStats(): { requests: number; hits: number; misses: number; timeouts: number } {
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
function nativeBinaryPath(): string | null {
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

  kill(): void {
    const proc = this.proc;
    this.proc = null;
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
        this.pending.delete(id);
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
  init: Promise<void>;
}

const servers = new Map<string, ServerEntry>();

function evictIdle(now = Date.now()): void {
  for (const [key, s] of servers) {
    if (now - s.lastUsed > IDLE_EVICT_MS) {
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
  const bin = nativeBinaryPath();
  if (!bin) throw Object.assign(new Error(`bifrost ${BIFROST_VERSION} native binary not installed`), { code: "unavailable" });
  const cacheDir = bifrostCacheDir(ledgerDir, key);
  fs.mkdirSync(cacheDir, { recursive: true });
  const entry: ServerEntry = {
    key,
    root,
    conn: null as unknown as LspConn,
    lastUsed: Date.now(),
    init: Promise.resolve(),
  };
  entry.conn = new LspConn(bin, root, cacheDir, () => { if (servers.get(key) === entry) servers.delete(key); });
  entry.conn.start();
  const conn = entry.conn;
  entry.init = (async () => {
    await conn.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    }, 10_000);
    conn.notify("initialized", {});
  })();
  // A failed initialize must not poison the map — the next request retries.
  entry.init.catch(() => { if (servers.get(key) === entry) { servers.delete(key); conn.kill(); } });
  servers.set(key, entry);
  evictIdle();
  return entry;
}

// Spawn (or reuse) the analyzer for cwd's repository without querying: call
// when a review opens so the cold index builds while the diff is read, not on
// the first click. Never throws — warming is best effort.
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

// Definition for a 0-based LSP position in an absolute file path. Empty array
// is the miss — slow-and-empty included — and the caller falls through.
export async function bifrostDefinition(
  cwd: string,
  abs: string,
  line: number,
  character: number,
  ledgerDir: string,
  timeoutMs = BIFROST_DEFINITION_TIMEOUT_MS,
): Promise<BifrostLocation[]> {
  stats.requests++;
  let realAbs = abs;
  try { realAbs = fs.realpathSync(abs); } catch { /* missing — let the analyzer answer */ }
  const entry = await ensureServer(cwd, ledgerDir);
  await entry.init;
  entry.lastUsed = Date.now();
  let result: unknown;
  try {
    result = await entry.conn.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(realAbs).href },
      position: { line, character },
    }, timeoutMs);
  } catch (e) {
    if ((e as { code?: string }).code === "timeout") stats.timeouts++;
    else stats.misses++;
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
  stats.requests = 0;
  stats.hits = 0;
  stats.misses = 0;
  stats.timeouts = 0;
}

export function bifrostLedgerDir(): string {
  return process.env.ACPG_LEDGER_DIR ?? "/data";
}
