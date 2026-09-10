// Client for the gateway's scoped agent login PTY terminal (/login/*).
// These calls ride the browser's already-cached Basic-auth on same-origin
// requests, so — unlike the ACP SSE transport — they need no token in the query.
const base = () => location.protocol + "//" + location.host;
const qs = (agent: string) => `?agent=${encodeURIComponent(agent)}`;

export async function startLogin(agent: string): Promise<void> {
  const res = await fetch(base() + "/login/start" + qs(agent), { method: "POST", credentials: "same-origin" });
  if (res.ok) return;
  // The gateway answers 501 for an agent whose backing CLI it has no login
  // command for, and says how to supply one. Throw so the caller renders that
  // rather than opening a stream that fails with nothing to read.
  const body = await res.json().catch(() => null) as { error?: string; hint?: string } | null;
  throw new Error([body?.error || `HTTP ${res.status}`, body?.hint].filter(Boolean).join(" — "));
}

export function loginStreamUrl(agent: string): string {
  return base() + "/login/stream" + qs(agent);
}

export async function sendLoginInput(agent: string, data: string): Promise<void> {
  try {
    await fetch(base() + "/login/input" + qs(agent), { method: "POST", body: data, credentials: "same-origin" });
  } catch (e) {
    console.error("sendLoginInput failed", e);
  }
}

export async function stopLogin(agent: string): Promise<void> {
  await fetch(base() + "/login/stop" + qs(agent), { method: "POST", credentials: "same-origin" });
}
