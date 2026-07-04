import type { AppConfig, AgentKind } from "../types.ts";

// Reads the gateway-injected #acpg-cfg blob. In Vite dev the placeholder is left
// literal ("__ACPG_CFG__"), so fall back to dev defaults (proxy handles routing).
export function readConfig(): AppConfig {
  const raw = document.getElementById("acpg-cfg")?.textContent ?? "";
  let parsed: Partial<AppConfig> = {};
  try { if (raw && raw[0] === "{") parsed = JSON.parse(raw); } catch { /* dev */ }
  return {
    ssePath: parsed.ssePath ?? "/acp/sse",
    rpcPath: parsed.rpcPath ?? "/acp/rpc",
    token: parsed.token ?? "",
    defaultAgent: parsed.defaultAgent ?? "claude",
    agents: parsed.agents ?? [{ name: parsed.defaultAgent ?? "claude", cwd: "" }],
    fsRoot: parsed.fsRoot ?? "",
  };
}

// SSE downstream url. lastEventId < 0 means "fresh/live" (no replay) — the first
// connect — and is sent as cursor=end; otherwise the client resumes after that seq.
export function sseUrl(cfg: AppConfig, agentName: string, lastEventId: number): string {
  const last = lastEventId < 0 ? "end" : String(lastEventId);
  return location.protocol + "//" + location.host + (cfg.ssePath ?? "/acp/sse") +
    "?token=" + encodeURIComponent(cfg.token) +
    "&agent=" + encodeURIComponent(agentName) +
    "&lastEventId=" + encodeURIComponent(last);
}

// POST upstream url for the conn id the SSE stream was issued.
export function rpcUrl(cfg: AppConfig, agentName: string, connId: string): string {
  return location.protocol + "//" + location.host + (cfg.rpcPath ?? "/acp/rpc") +
    "?token=" + encodeURIComponent(cfg.token) +
    "&agent=" + encodeURIComponent(agentName) +
    "&conn=" + encodeURIComponent(connId);
}

// Deep-link to a shared conversation: ?agent=<name>&session=<full id>&cwd=<project path>.
// Reads the params off the URL so a second device can resume the same conversation
// instead of starting its own. `cwd` is needed because sessions are stored
// per-cwd (~/.claude/projects/<cwd>/<id>.jsonl); `agent` identifies which agent the
// session belongs to, so a multi-agent link opens under the right connection.
export function linkParams(search: string = location.search): { agent: string | null; session: string | null; cwd: string | null } {
  const q = new URLSearchParams(search);
  return { agent: q.get("agent"), session: q.get("session"), cwd: q.get("cwd") };
}

// Build a shareable deep-link to a session from the current page location.
export function shareUrl(sessionId: string, cwd: string, agent: string = "", origin: string = location.origin, pathname: string = location.pathname): string {
  const u = new URL(origin + pathname);
  if (agent) u.searchParams.set("agent", agent);
  u.searchParams.set("session", sessionId);
  if (cwd) u.searchParams.set("cwd", cwd);
  return u.toString();
}

// Build the terminal command to continue a conversation on the host running the
// gateway. Each CLI scopes resume to the session's project dir, so we cd in first
// to land in the right folder and match the on-disk transcript. The syntax
// differs per CLI: Claude uses `--resume <id>`, Codex a `resume <id>` subcommand,
// opencode a `--session <id>` flag.
export function resumeCommand(sessionId: string, cwd: string, kind?: AgentKind): string {
  const resume =
    kind === "codex" ? `codex resume ${sessionId}`
    : kind === "opencode" ? `opencode --session ${sessionId}`
    : `claude --resume ${sessionId}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

// Quote a path for a POSIX shell only when it contains characters outside the
// safe set, so clean paths stay readable and odd ones stay correct.
function shellQuote(s: string): string {
  return /^[\w/.@:%+,=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
