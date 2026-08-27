// Client for the gateway's general-shell PTY terminals (/terminal/*).
// Mirrors lib/login.ts: these calls ride the browser's already-cached Basic
// auth on same-origin requests, so no token needs to travel in the query.
//
// `id` is one terminal tab. The client picks it; the gateway keys a shell by
// it and hands the live list back from listTerminals(), so a reloaded page
// re-attaches to its shells instead of orphaning them.
const base = () => location.protocol + "//" + location.host;
const qs = (id: string) => `?id=${encodeURIComponent(id)}`;

export function newTerminalId(): string {
  // randomUUID() is secure-context-only, and this gateway is legitimately
  // served over plain HTTP on a LAN address when TLS is terminated elsewhere
  // (ACPG_TLS=off) — there it is undefined and calling it would throw before a
  // single tab rendered. The id is a handle the gateway tells tabs apart by,
  // not a secret, so any collision-unlikely token does. Shape matches the
  // gateway's ID_RE.
  return crypto.randomUUID?.()
    ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// A tab as the gateway sees it. `name` is "" until someone renames it, and the
// UI falls back to the tab's position.
export interface TerminalTab { id: string; name: string }

export async function listTerminals(): Promise<TerminalTab[]> {
  try {
    const r = await fetch(base() + "/terminal/status", { credentials: "same-origin" });
    if (!r.ok) return [];
    const body = (await r.json()) as { sessions?: Array<{ id?: string; name?: string }> };
    return (body.sessions ?? [])
      .filter((s): s is { id: string; name?: string } => !!s.id)
      .map((s) => ({ id: s.id, name: s.name ?? "" }));
  } catch {
    return []; // offline or an older gateway — start fresh rather than fail to open
  }
}

// The name lives on the gateway, not in localStorage: the console is driven
// from a phone and a desktop against the same shells, and a label only one of
// them can see is worse than no label.
export async function renameTerminal(id: string, name: string): Promise<void> {
  try {
    await fetch(base() + "/terminal/rename" + qs(id), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    console.error("renameTerminal failed", e);
  }
}

export async function startTerminal(id: string, cwd?: string): Promise<void> {
  const url = base() + "/terminal/start" + qs(id) + (cwd ? `&cwd=${encodeURIComponent(cwd)}` : "");
  await fetch(url, { method: "POST", credentials: "same-origin" });
}

export function terminalStreamUrl(id: string): string {
  return base() + "/terminal/stream" + qs(id);
}

// Keystrokes have to reach the shell in the order they were typed. Firing an
// independent fetch per keystroke does not guarantee that — the browser runs
// several in parallel and they can land out of order, which a line editor
// survives and vim does not ("vp3.txt" arriving as "vp3t.xt"). So: one POST in
// flight per terminal, with everything typed behind it coalesced into the next
// body. Fire-and-forget by design; the caller has nothing to do with the ack.
const backlog = new Map<string, string>();
const sending = new Set<string>();

export function sendTerminalInput(id: string, data: string): void {
  backlog.set(id, (backlog.get(id) ?? "") + data);
  if (sending.has(id)) return;
  sending.add(id);
  void (async () => {
    try {
      for (let body = backlog.get(id); body; body = backlog.get(id)) {
        backlog.delete(id);
        await fetch(base() + "/terminal/input" + qs(id), { method: "POST", body, credentials: "same-origin" });
      }
    } catch (e) {
      console.error("sendTerminalInput failed", e);
      backlog.delete(id); // drop the burst rather than replay it after a gap
    } finally {
      sending.delete(id);
    }
  })();
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  try {
    await fetch(base() + "/terminal/resize" + qs(id), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    });
  } catch (e) {
    console.error("resizeTerminal failed", e);
  }
}

export async function stopTerminal(id: string): Promise<void> {
  try {
    await fetch(base() + "/terminal/stop" + qs(id), { method: "POST", credentials: "same-origin" });
  } catch (e) {
    console.error("stopTerminal failed", e);
  }
}

// ------------------------------------------------------------------ "!" exec ----
// One-shot exec for the composer's "!" escape. Unlike the PTY routes above
// there is no session to key: the gateway runs the command to completion and
// answers with what it printed. Errors reject — the caller owns what a failed
// run looks like in the thread.
export interface ExecResult { code: number; stdout: string; stderr: string }

export async function execCommand(cmd: string, cwd?: string): Promise<ExecResult> {
  const r = await fetch(base() + "/terminal/exec", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, cwd }),
  });
  if (!r.ok) throw new Error(`exec failed (${r.status})`);
  return (await r.json()) as ExecResult;
}

// The transcript block that rides ahead of the NEXT prompt, so the model hears
// what the user just watched happen. Tag names follow Claude Code's own "!"
// feature — models already know this shape.
export function shellContext(cmd: string, res: ExecResult): string {
  const parts = [`<bash-input>${cmd}</bash-input>`];
  if (res.stdout) parts.push(`<bash-stdout>${res.stdout}</bash-stdout>`);
  if (res.stderr) parts.push(`<bash-stderr>${res.stderr}</bash-stderr>`);
  if (res.code !== 0) parts.push(`<bash-exit-code>${res.code}</bash-exit-code>`);
  return parts.join("\n");
}

// What the thread shows for a finished run: the output as printed (stderr after
// stdout), or a placeholder so a silent command doesn't render as a blank row,
// with the exit code only when it says something ("exit 0" is noise).
export function shellNote(res: ExecResult): string {
  const out = [res.stdout, res.stderr].filter(Boolean).join("").replace(/\n+$/, "");
  return [out || "(no output)", res.code !== 0 ? `(exit ${res.code})` : ""].filter(Boolean).join("\n");
}
