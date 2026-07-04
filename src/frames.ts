// Lightweight classification of ACP JSON-RPC frames. The gateway needs to route
// by these categories; it does NOT otherwise interpret ACP.
export type Frame = Record<string, unknown>;

export function parse(line: Buffer | string): Frame | null {
  try {
    const o = JSON.parse(typeof line === "string" ? line : line.toString("utf8"));
    return o && typeof o === "object" ? (o as Frame) : null;
  } catch {
    return null;
  }
}

export function isRequest(f: Frame): boolean {
  return typeof f.method === "string" && f.id !== undefined && f.id !== null;
}
export function isResponse(f: Frame): boolean {
  return f.method === undefined && f.id !== undefined && f.id !== null;
}
export function isNotification(f: Frame): boolean {
  return typeof f.method === "string" && (f.id === undefined || f.id === null);
}
export function sessionIdOf(f: Frame): string | null {
  const p = f.params as { sessionId?: unknown } | undefined;
  return p && typeof p.sessionId === "string" ? p.sessionId : null;
}
// The working directory a session/new (or session/load / session/prompt) targets.
// session/new has no sessionId yet — its cwd is paired to the session on the
// response — so this reads the cwd independently of sessionIdOf.
export function cwdOf(f: Frame): string | null {
  const p = f.params as { cwd?: unknown } | undefined;
  return p && typeof p.cwd === "string" && p.cwd ? p.cwd : null;
}
