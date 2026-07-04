// ----------------------------------------------------------------- login ----
// A scoped, PTY-backed terminal for re-running interactive agent login flows
// from a remote/mobile browser. The ACP agents (claude-agent-acp, codex-acp)
// reuse the host's credentials (~/.claude, ~/.codex); when those expire the
// agent just crash-loops and there is no in-band way to re-authenticate,
// because ACP is a structured protocol, not an interactive TTY. This hosts the
// one genuinely interactive flow — login emits a URL and waits for a pasted
// code — over a pseudo-terminal so it can be driven from a phone.
//
// POC scope: per-agent login sessions (keyed by agent name from ?agent=),
// commands resolved from agent kind (claude/codex) with env overrides, and it
// deliberately does NOT expose a general shell. Output streams over SSE;
// input comes back over POST, so it reuses the gateway's existing
// SSE+POST + Basic-auth surface and adds no new transport or auth.
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { IncomingMessage, ServerResponse } from "node:http";

// Login commands are keyed by agent KIND (the backing CLI), not the agent's
// configured name — an agent renamed in agents.json (e.g. a codex agent named
// "gpt") must still run the right login command.
const LOGIN_CMDS_BY_KIND: Record<string, { cmd: string; args: string[] }> = {
  claude: { cmd: "claude", args: ["auth", "login"] },
  codex: { cmd: "codex", args: ["login", "--device-auth"] },
};
const DEFAULT_LOGIN = { cmd: "claude", args: ["auth", "login"] };
// Enough scrollback that a phone reconnecting mid-flow still sees the login URL
// and the "Paste code here" prompt replayed.
const MAX_SCROLLBACK = 64 * 1024;

// Registered by the gateway, which alone knows the configured agents and each
// one's backing CLI (kind, derived from its cmd). `agentKinds` lets loginCmdFor
// map a name to a command without re-deriving the kind; `knownAgents` is the
// allowlist handleLogin checks so a client can't spawn a login for an arbitrary
// ?agent= name (every configured agent is registered, even if its kind is
// undefined).
const agentKinds = new Map<string, string>();
const knownAgents = new Set<string>();
export function registerLoginAgent(agentName: string, kind: string | null | undefined): void {
  knownAgents.add(agentName);
  if (kind) agentKinds.set(agentName, kind);
}

function loginCmdFor(agentName: string): { cmd: string; args: string[] } {
  // Per-name env override is the explicit escape hatch and wins over the kind map.
  const envCmd = process.env[`ACPG_${agentName.toUpperCase()}_LOGIN_CMD`];
  const envArgs = process.env[`ACPG_${agentName.toUpperCase()}_LOGIN_ARGS`];
  if (envCmd) {
    return { cmd: envCmd, args: (envArgs ?? "").split(/\s+/).filter(Boolean) };
  }
  const kind = agentKinds.get(agentName);
  return (kind && LOGIN_CMDS_BY_KIND[kind]) || DEFAULT_LOGIN;
}

const sessions = new Map<string, LoginSession>();
export function getSession(agentName: string): LoginSession {
  let s = sessions.get(agentName);
  if (!s) {
    const { cmd, args } = loginCmdFor(agentName);
    s = new LoginSession(cmd, args);
    sessions.set(agentName, s);
  }
  return s;
}

// SSE carries arbitrary terminal bytes (CR/LF, escape sequences) that would
// break the line-oriented `data:` framing, so each chunk is base64-encoded and
// the browser decodes it before writing to xterm.
function sseChunk(res: ServerResponse, data: string): void {
  res.write(`data:${Buffer.from(data, "utf8").toString("base64")}\n\n`);
}

class LoginSession {
  private proc: IPty | null = null;
  private scrollback: string[] = [];
  private scrollbackSize = 0;
  private subs = new Set<ServerResponse>();
  private lastExit: number | null = null;
  // Called once when the login process exits cleanly, so the gateway can bounce
  // the agent to pick up the freshly written credentials.
  onSuccess?: () => void;

  constructor(private cmd: string, private args: string[]) {}

  running(): boolean {
    return this.proc !== null;
  }

  status(): { running: boolean; lastExit: number | null } {
    return { running: this.running(), lastExit: this.lastExit };
  }

  start(cwd?: string): void {
    // If a PTY is still tracked but the underlying process has already exited
    // (e.g. killed via stop()), clear the stale reference so a new one can start.
    try { this.proc?.write(""); } catch { this.proc = null; }
    if (this.proc) return; // one session at a time
    this.scrollback = [];
    this.scrollbackSize = 0;
    this.lastExit = null;
    console.log(`login: pty.spawn ${this.cmd} ${this.args.join(" ")}`);
    // Let the login command run with its default browser-launching behavior.
    // On macOS that just `open`s the URL in Safari.app — the navigation
    // happens in an external process, not the iOS webview, so it does NOT
    // trigger the cross-origin nav confirm that would block the paste field.
    const proc = pty.spawn(this.cmd, this.args, {
      name: "xterm-color",
      cols: 100,
      rows: 30,
      cwd: cwd || process.env.HOME || process.cwd(),
      env: process.env as { [k: string]: string },
    });
    this.proc = proc;
    proc.onData((d) => {
      this.buffer(d);
      for (const r of this.subs) sseChunk(r, d);
    });
    proc.onExit(({ exitCode }) => {
      const banner = `\r\n\x1b[36m[login exited code=${exitCode}]\x1b[0m\r\n`;
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
      console.log(`login: exited code=${exitCode}`);
      if (exitCode === 0) {
        try {
          this.onSuccess?.();
        } catch (e) {
          console.warn(`login: onSuccess hook threw: ${String(e)}`);
        }
      }
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
    this.subs.add(res);
    for (const chunk of this.scrollback) sseChunk(res, chunk); // replay
    if (!this.proc) {
      // Already exited: let the client render the scrollback, then close.
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
  }

  write(text: string): void {
    this.proc?.write(text);
  }

  stop(): void {
    // Tear down a live process and let its onExit set lastExit. Don't clear
    // lastExit here: if the process already exited (e.g. a successful login),
    // kill() is a no-op and we must preserve that record for /login/status —
    // the React cleanup calls stop() right after a successful login.
    try { this.proc?.kill(); } catch { /* already dead */ }
    this.proc = null;
  }
}

// Reads a request body, capped, as a UTF-8 string.
function readBody(req: IncomingMessage, maxPayload: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxPayload) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

// Routes the /login/* surface. Returns true if it handled the request. The
// caller must have already passed it through the Basic-auth gate.
export function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  maxPayload: number,
): boolean {
  const u = new URL(req.url ?? "/", "http://x");
  const agent = u.searchParams.get("agent") || "claude";
  // Only spawn/track sessions for configured agents — an arbitrary ?agent= must
  // not create a LoginSession or launch a login command.
  if (!knownAgents.has(agent)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown agent" }));
    return true;
  }
  const session = getSession(agent);

  if (pathname === "/login/start") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return true;
    }
    session.start();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(session.status()));
    return true;
  }

  if (pathname === "/login/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(session.status()));
    return true;
  }

  if (pathname === "/login/stop") {
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

  if (pathname === "/login/stream") {
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

  if (pathname === "/login/input") {
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
