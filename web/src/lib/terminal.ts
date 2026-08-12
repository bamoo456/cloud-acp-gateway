// Client for the gateway's opt-in general-shell PTY terminal (/terminal/*).
// Mirrors lib/login.ts: these calls ride the browser's already-cached Basic
// auth on same-origin requests, so no token needs to travel in the query.
const base = () => location.protocol + "//" + location.host;

export async function startTerminal(cwd?: string): Promise<void> {
  const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  await fetch(base() + "/terminal/start" + qs, { method: "POST", credentials: "same-origin" });
}

export function terminalStreamUrl(): string {
  return base() + "/terminal/stream";
}

export async function sendTerminalInput(data: string): Promise<void> {
  try {
    await fetch(base() + "/terminal/input", { method: "POST", body: data, credentials: "same-origin" });
  } catch (e) {
    console.error("sendTerminalInput failed", e);
  }
}

export async function resizeTerminal(cols: number, rows: number): Promise<void> {
  try {
    await fetch(base() + "/terminal/resize", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    });
  } catch (e) {
    console.error("resizeTerminal failed", e);
  }
}

export async function stopTerminal(): Promise<void> {
  await fetch(base() + "/terminal/stop", { method: "POST", credentials: "same-origin" });
}
