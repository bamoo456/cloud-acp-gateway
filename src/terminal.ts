// -------------------------------------------------------------- terminal ----
// PTY-backed general shells (like ttyd), reusing the same node-pty + SSE/POST
// plumbing as login.ts's scoped agent-login terminal. Unlike login.ts, these
// run the user's actual shell with no command allowlist — real host shell
// access to anyone holding the gateway credential, so the caller (gateway.ts)
// keeps it behind its own ACPG_TERMINAL switch (on by default, `off` to
// withhold) in addition to the Basic-auth gate.
//
// Sessions are keyed by a client-chosen id — one per terminal tab — and are
// deliberately NOT tied to an agent or a conversation: a shell isn't scoped to
// either. A session outlives the browser connection on purpose (that is the
// point of a terminal you can reconnect to); an idle timer tears one down only
// after every subscriber has been gone a while, so abandoned tabs don't leak
// shells forever. When the shell itself exits (ctrl-D), the session is gone
// immediately — subscribers get an `exit` SSE event so the UI can drop the tab.
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sseChunk, readBody } from "./login.ts";

const MAX_SCROLLBACK = 64 * 1024;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
// A ceiling on concurrent shells, so a buggy or hostile client can't spawn
// host processes without bound by inventing ids.
const MAX_SESSIONS = 12;
// Ids come from the client (one per tab). Constrain the shape: they end up in
// log lines and Map keys, and nothing needs more than an opaque token.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// How long a session with no attached SSE stream stays alive before its PTY
// is killed. Bounded below so a misconfigured "0" or negative doesn't reap
// instantly out from under a client that's mid-reconnect.
const IDLE_TTL_MS = Math.max(60_000, Number(process.env.ACPG_TERMINAL_IDLE_TTL_MS) || 30 * 60_000);

// Set once by gateway.ts, which alone knows the FS_ROOT containment policy —
// mirrors how login.ts's registerLoginAgent lets the gateway inject the
// agent allowlist without this module importing that policy itself. Given a
// raw (possibly empty/invalid) ?cwd=, it must return a directory to spawn in.
let resolveCwd: (raw: string) => string = () => process.env.HOME || process.cwd();
export function setCwdResolver(fn: (raw: string) => string): void {
  resolveCwd = fn;
}

// Named SSE events ride alongside the base64 terminal chunks: those go out as
// unnamed `message` events (sseChunk), so a client's onmessage handler never
// sees these and never has to tell them apart.
function sseEvent(res: ServerResponse, name: string, data = "{}"): void {
  res.write(`event: ${name}\ndata:${data}\n\n`);
}

class TerminalSession {
  private proc: IPty | null = null;
  private scrollback: string[] = [];
  private scrollbackSize = 0;
  private subs = new Set<ServerResponse>();
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private id: string, private onGone: (id: string) => void) {}

  running(): boolean {
    return this.proc !== null;
  }

  start(cwd: string): void {
    this.clearIdleTimer();
    try { this.proc?.write(""); } catch { this.proc = null; }
    if (this.proc) return; // one shell per session
    const shell = process.env.SHELL || "/bin/bash";
    console.log(`terminal[${this.id}]: pty.spawn ${shell} cwd=${cwd}`);
    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: process.env as { [k: string]: string },
    });
    this.proc = proc;
    proc.onData((d) => {
      this.buffer(d);
      for (const r of this.subs) sseChunk(r, d);
    });
    proc.onExit(({ exitCode }) => {
      console.log(`terminal[${this.id}]: exited code=${exitCode}`);
      this.proc = null;
      // The shell is what the tab IS, so its exit ends the session outright
      // rather than leaving a dead pane behind. Tell every subscriber before
      // closing their stream: an ended stream alone is ambiguous (EventSource
      // treats a drop as something to retry), the event is not.
      for (const r of this.subs) {
        sseEvent(r, "exit", JSON.stringify({ exitCode }));
        try { r.end(); } catch { /* already closed */ }
      }
      this.subs.clear();
      this.destroy();
    });
  }

  private buffer(d: string): void {
    this.scrollback.push(d);
    this.scrollbackSize += d.length;
    while (this.scrollbackSize > MAX_SCROLLBACK && this.scrollback.length > 1) {
      this.scrollbackSize -= this.scrollback.shift()!.length;
    }
  }

  attach(res: ServerResponse): void {
    this.clearIdleTimer();
    this.subs.add(res);
    for (const chunk of this.scrollback) sseChunk(res, chunk); // replay
  }

  detach(res: ServerResponse): void {
    this.subs.delete(res);
    // No browser attached, but the shell is still running: start the idle clock
    // instead of killing it, so a reconnect a few seconds later (a reload, a
    // flaky mobile network) picks the same shell back up.
    if (this.subs.size === 0 && this.proc) this.scheduleIdleTimer();
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      console.log(`terminal[${this.id}]: idle TTL elapsed with no subscribers, killing shell`);
      this.stop();
    }, IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  write(text: string): void {
    this.proc?.write(text);
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    this.cols = Math.floor(cols);
    this.rows = Math.floor(rows);
    try { this.proc?.resize(this.cols, this.rows); } catch { /* pty already gone */ }
  }

  // Kill the shell. onExit does the rest (notify + destroy); if the process is
  // already gone, tear down here so the session can't linger in the map.
  stop(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already dead */ }
      return;
    }
    this.destroy();
  }

  private destroy(): void {
    this.clearIdleTimer();
    this.proc = null;
    this.scrollback = [];
    this.scrollbackSize = 0;
    this.onGone(this.id);
  }
}

const sessions = new Map<string, TerminalSession>();
const forget = (id: string) => { sessions.delete(id); };

// Reads a request body, capped, and JSON-parses it. null on either failure —
// callers answer 413/400 the same way for both.
function readJson(req: IncomingMessage, maxPayload: number): Promise<Record<string, unknown> | null> {
  return readBody(req, maxPayload).then((body) => {
    if (body === null) return null;
    try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
  });
}

// Routes the /terminal/* surface. Returns true if it handled the request. The
// caller must have already gated on ACPG_TERMINAL and passed the request
// through Basic auth.
export function handleTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  maxPayload: number,
): boolean {
  // The one route without an id: what shells exist right now. A reloaded page
  // adopts these instead of orphaning them and spawning duplicates.
  if (pathname === "/terminal/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      sessions: [...sessions.entries()].map(([id, s]) => ({ id, running: s.running() })),
    }));
    return true;
  }

  const known = ["/terminal/start", "/terminal/stream", "/terminal/input", "/terminal/resize", "/terminal/stop"];
  if (!known.includes(pathname)) return false;

  const q = new URL(req.url ?? "/", "http://x").searchParams;
  const id = q.get("id") ?? "";
  if (!ID_RE.test(id)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad or missing id" }));
    return true;
  }

  if (pathname === "/terminal/start") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `too many terminals (max ${MAX_SESSIONS})` }));
        return true;
      }
      session = new TerminalSession(id, forget);
      sessions.set(id, session);
    }
    session.start(resolveCwd(q.get("cwd") ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, running: session.running() }));
    return true;
  }

  const session = sessions.get(id);
  if (!session) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown terminal" }));
    return true;
  }

  if (pathname === "/terminal/stop") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
    session.stop();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, running: false }));
    return true;
  }

  if (pathname === "/terminal/resize") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
    readJson(req, maxPayload).then((body) => {
      if (!body) { res.writeHead(400); res.end(); return; }
      session.resize(Number(body.cols), Number(body.rows));
      res.writeHead(202);
      res.end();
    });
    return true;
  }

  if (pathname === "/terminal/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sseEvent(res, "ready");
    session.attach(res);
    const ka = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch { /* closed */ }
    }, 15000);
    ka.unref?.();
    res.on("close", () => {
      clearInterval(ka);
      session.detach(res);
    });
    return true;
  }

  if (pathname === "/terminal/input") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
    readBody(req, maxPayload).then((body) => {
      if (body === null) { res.writeHead(413); res.end(); return; }
      session.write(body);
      res.writeHead(202);
      res.end();
    });
    return true;
  }

  return false;
}
