// -------------------------------------------------------------- terminal ----
// A PTY-backed general shell (like ttyd), reusing the same node-pty +
// SSE/POST plumbing as login.ts's scoped agent-login terminal. Unlike
// login.ts, this runs the user's actual shell with no command allowlist — it
// is real host shell access to anyone holding the gateway credential, so the
// caller (gateway.ts) keeps it behind its own ACPG_TERMINAL switch (on by
// default, `off` to withhold) in addition to the Basic-auth gate.
//
// One global session for the whole gateway (not per-agent, not multi-tab) —
// a shell isn't scoped to an agent's identity the way a login flow is. Unlike
// the login terminal, this session survives a dropped browser connection on
// purpose (that's the point of a terminal you can reconnect to); an idle
// timer tears it down only after every subscriber has been gone for a while,
// so a permanently abandoned tab doesn't leak a shell forever.
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sseChunk, readBody } from "./login.ts";

const MAX_SCROLLBACK = 64 * 1024;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
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

class TerminalSession {
  private proc: IPty | null = null;
  private scrollback: string[] = [];
  private scrollbackSize = 0;
  private subs = new Set<ServerResponse>();
  private lastExit: number | null = null;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  running(): boolean {
    return this.proc !== null;
  }

  status(): { running: boolean; lastExit: number | null } {
    return { running: this.running(), lastExit: this.lastExit };
  }

  start(cwd: string): void {
    this.clearIdleTimer();
    try { this.proc?.write(""); } catch { this.proc = null; }
    if (this.proc) return; // one session at a time
    this.scrollback = [];
    this.scrollbackSize = 0;
    this.lastExit = null;
    const shell = process.env.SHELL || "/bin/bash";
    console.log(`terminal: pty.spawn ${shell} cwd=${cwd}`);
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
      const banner = `\r\n\x1b[36m[shell exited code=${exitCode}]\x1b[0m\r\n`;
      this.buffer(banner);
      for (const r of this.subs) {
        sseChunk(r, banner);
        try {
          r.end();
        } catch {
          /* already closed */
        }
      }
      this.subs.clear();
      this.proc = null;
      this.lastExit = exitCode;
      console.log(`terminal: exited code=${exitCode}`);
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
    if (!this.proc) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      this.subs.delete(res);
    }
  }

  detach(res: ServerResponse): void {
    this.subs.delete(res);
    // No browser attached, but the shell is still running: start (or restart)
    // the idle clock instead of killing it immediately, so a reconnect a few
    // seconds later (a reload, a flaky mobile network) picks the same shell
    // back up.
    if (this.subs.size === 0 && this.proc) this.scheduleIdleTimer();
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      console.log("terminal: idle TTL elapsed with no subscribers, killing shell");
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

  stop(): void {
    this.clearIdleTimer();
    try { this.proc?.kill(); } catch { /* already dead */ }
    this.proc = null;
  }
}

const session = new TerminalSession();

// Routes the /terminal/* surface. Returns true if it handled the request. The
// caller must have already gated on ACPG_TERMINAL and passed the request
// through Basic auth.
export function handleTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  maxPayload: number,
): boolean {
  if (pathname === "/terminal/start") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return true;
    }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    session.start(resolveCwd(q.get("cwd") ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(session.status()));
    return true;
  }

  if (pathname === "/terminal/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(session.status()));
    return true;
  }

  if (pathname === "/terminal/stop") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return true;
    }
    session.stop();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(session.status()));
    return true;
  }

  if (pathname === "/terminal/resize") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return true;
    }
    readBody(req, maxPayload).then((body) => {
      if (body === null) {
        res.writeHead(413);
        res.end();
        return;
      }
      try {
        const { cols, rows } = JSON.parse(body) as { cols?: number; rows?: number };
        session.resize(Number(cols), Number(rows));
        res.writeHead(202);
        res.end();
      } catch {
        res.writeHead(400);
        res.end();
      }
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
    res.write(`event: ready\ndata:{}\n\n`);
    session.attach(res);
    const ka = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* closed */
      }
    }, 15000);
    ka.unref?.();
    res.on("close", () => {
      clearInterval(ka);
      session.detach(res);
    });
    return true;
  }

  if (pathname === "/terminal/input") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return true;
    }
    readBody(req, maxPayload).then((body) => {
      if (body === null) {
        res.writeHead(413);
        res.end();
        return;
      }
      session.write(body);
      res.writeHead(202);
      res.end();
    });
    return true;
  }

  return false;
}
