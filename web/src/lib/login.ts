// Client for the gateway's scoped agent login PTY terminal (/login/*).
// These calls ride the browser's already-cached Basic-auth on same-origin
// requests, so — unlike the ACP SSE transport — they need no token in the query.
const base = () => location.protocol + "//" + location.host;
const qs = (agent: string) => `?agent=${encodeURIComponent(agent)}`;

export async function startLogin(agent: string): Promise<void> {
  await fetch(base() + "/login/start" + qs(agent), { method: "POST", credentials: "same-origin" });
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
