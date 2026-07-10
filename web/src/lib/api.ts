import type { PermissionOption } from "../types.ts";

export interface HistorySession { sessionId: string; title: string | null; updatedAt: string; }
export interface DiscoveredHistorySession extends HistorySession { cwd: string; source: "claude-cli"; }
export interface ViewBlock { type: "text" | "thought" | "tool" | "image"; text?: string; name?: string; toolCallId?: string; status?: string; output?: string; mimeType?: string; data?: string; uri?: string; }
export interface ViewMessage { role: "user" | "assistant"; blocks: ViewBlock[]; }
export interface MessagesResult { messages: ViewMessage[]; total: number; truncated: boolean; }
export interface DirEntry { name: string; git: boolean; }
export interface FsResult { root: string; path: string; parent: string | null; dirs: DirEntry[]; }

const base = () => location.protocol + "//" + location.host;

async function readJson(r: Response, unavailableMessage: string): Promise<any> {
  if (r.ok === false) {
    let body = "";
    try { body = (await r.text()).trim(); } catch { /* ignore */ }
    throw new Error(body || unavailableMessage);
  }
  try {
    return await r.json();
  } catch {
    throw new Error(unavailableMessage);
  }
}

export async function getHistory(agent: string, cwd: string, limit = 30): Promise<HistorySession[]> {
  const url = base() + "/history?agent=" + encodeURIComponent(agent) +
    "&cwd=" + encodeURIComponent(cwd) + "&limit=" + limit;
  const r = await readJson(await fetch(url), "Conversation history isn't available for this agent.");
  return (r && r.sessions) || [];
}

export async function getDiscoveredHistory(agent: string, limit = 30): Promise<DiscoveredHistorySession[]> {
  const url = base() + "/history/discovered?agent=" + encodeURIComponent(agent) + "&limit=" + limit;
  const r = await readJson(await fetch(url), "Discovered conversations aren't available for this agent.");
  return (r && r.sessions) || [];
}

export async function getMessages(agent: string, cwd: string, session: string, limit = 120): Promise<MessagesResult> {
  const url = base() + "/history/messages?agent=" + encodeURIComponent(agent) +
    "&cwd=" + encodeURIComponent(cwd) + "&session=" + encodeURIComponent(session) + "&limit=" + limit;
  const r = await readJson(await fetch(url), "Conversation history isn't available for this session yet.");
  return { messages: r.messages || [], total: r.total || 0, truncated: !!r.truncated };
}

export async function renameSession(agent: string, cwd: string, session: string, title: string): Promise<void> {
  const url = base() + "/history/rename?agent=" + encodeURIComponent(agent) +
    "&cwd=" + encodeURIComponent(cwd) + "&session=" + encodeURIComponent(session) +
    "&title=" + encodeURIComponent(title);
  await fetch(url, { method: "POST" });
}

export async function listDir(path: string): Promise<FsResult> {
  const url = base() + "/fs?path=" + encodeURIComponent(path);
  return (await fetch(url)).json();
}

// Files under a cwd for the composer's "@ file" picker, as cwd-relative paths.
// `query` filters by a case-insensitive substring (server-side). Best-effort: a
// failure (offline, older gateway) yields an empty list so the menu just stays empty.
export async function listFiles(cwd: string, query = ""): Promise<string[]> {
  try {
    const url = base() + "/files?cwd=" + encodeURIComponent(cwd) + "&q=" + encodeURIComponent(query);
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.files) ? j.files : [];
  } catch {
    return [];
  }
}

// Pinned ("favorite") folders live on the server (shared across devices/IPs),
// not in this browser's localStorage. Both calls return the updated list.
export async function getPinnedFolders(): Promise<string[]> {
  const r = await readJson(await fetch(base() + "/folders/pinned"), "Pinned folders aren't available.");
  return Array.isArray(r.pinned) ? r.pinned : [];
}

export async function togglePinnedFolder(path: string): Promise<string[]> {
  const url = base() + "/folders/pinned?path=" + encodeURIComponent(path);
  const r = await readJson(await fetch(url, { method: "POST" }), "Couldn't update pinned folders.");
  return Array.isArray(r.pinned) ? r.pinned : [];
}

// Cross-device UI prefs that used to live in this browser's localStorage now live
// on the gateway (shared across devices/IPs — see lib/recentFolders, lib/lock).
// getPrefs hydrates all of them in one request on startup; the mutators below
// each persist one slice and are best-effort (a failure leaves the in-memory cache
// authoritative, exactly as the old localStorage writes degraded).
export interface PrefsDto {
  textSize: string | null;
  lock: unknown | null;
  recentSessions: Array<Record<string, unknown>>;
  recentFolders: Array<Record<string, unknown>>;
}

export async function getPrefs(): Promise<PrefsDto> {
  try {
    const r = await fetch(base() + "/prefs");
    if (!r.ok) return { textSize: null, lock: null, recentSessions: [], recentFolders: [] };
    const j = await r.json();
    return {
      textSize: typeof j?.textSize === "string" ? j.textSize : null,
      lock: j?.lock ?? null,
      recentSessions: Array.isArray(j?.recentSessions) ? j.recentSessions : [],
      recentFolders: Array.isArray(j?.recentFolders) ? j.recentFolders : [],
    };
  } catch {
    return { textSize: null, lock: null, recentSessions: [], recentFolders: [] };
  }
}

export async function putTextSize(value: string): Promise<void> {
  try { await fetch(base() + "/prefs/text-size?value=" + encodeURIComponent(value), { method: "POST" }); } catch { /* best-effort */ }
}

// configJson is the opaque lock blob (PIN hash/salt); null clears the lock server-side.
export async function putLockConfig(configJson: string | null): Promise<void> {
  try {
    if (configJson === null) await fetch(base() + "/prefs/lock", { method: "DELETE", keepalive: true });
    else await fetch(base() + "/prefs/lock?config=" + encodeURIComponent(configJson), { method: "POST", keepalive: true });
  } catch { /* best-effort */ }
}

export async function postRecentSession(s: { agentName: string; cwd: string; sessionId: string; title: string; lastActiveAt: string }): Promise<void> {
  try {
    const url = base() + "/prefs/recent-session?agent=" + encodeURIComponent(s.agentName) +
      "&cwd=" + encodeURIComponent(s.cwd) + "&session=" + encodeURIComponent(s.sessionId) +
      "&title=" + encodeURIComponent(s.title) + "&at=" + encodeURIComponent(s.lastActiveAt);
    await fetch(url, { method: "POST" });
  } catch { /* best-effort */ }
}

export async function postRecentFolder(path: string, lastUsedAt: string): Promise<void> {
  try {
    await fetch(base() + "/prefs/recent-folder?path=" + encodeURIComponent(path) + "&at=" + encodeURIComponent(lastUsedAt), { method: "POST" });
  } catch { /* best-effort */ }
}

export type TaskState = "active" | "awaiting-input";
// cwd is the folder the session runs in, reported by the gateway. It lets a device
// that never opened the session locally show the right folder and jump accurately
// (without it, a cross-device task falls back to recents and a short id).
// title is the text of the session's first prompt (capped by the gateway). It
// labels the task so two concurrent tasks in the same folder don't both collapse
// to a short session id and read as duplicates.
export interface RunningTask { agentName: string; sessionId: string; state: TaskState; cwd?: string; title?: string; }

// Sessions whose prompt is running right now, across every agent — including
// ones started on other devices that this client never observed over its WS.
// Best-effort: a failure (offline, older gateway) just yields no tasks.
export async function getRunning(): Promise<RunningTask[]> {
  try {
    const r = await fetch(base() + "/running");
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.tasks) ? j.tasks : [];
  } catch {
    return [];
  }
}

// A pending permission from the gateway's durable inbox. Unlike the SSE-derived
// pendingPermissions (live, active-agent only), this is server truth: it survives
// a page reload and spans every agent — so a device sees prompts raised anywhere.
export interface InboxItem {
  id: number;
  agentName: string;
  sessionId: string | null;
  reqId: string | null;
  title: string;
  options: PermissionOption[];
  status: string;
  createdAt: string;
}

// Pending inbox prompts across every agent. Best-effort: an offline or older
// gateway just yields an empty list.
export async function getInboxPending(): Promise<InboxItem[]> {
  try {
    const r = await fetch(base() + "/inbox?status=pending");
    if (!r.ok) return [];
    const j = await r.json();
    const items: Array<Record<string, unknown>> = Array.isArray(j?.items) ? j.items : [];
    return items.map((it) => ({
      id: Number(it.id),
      agentName: String(it.agentName ?? ""),
      sessionId: (it.sessionId as string | null) ?? null,
      reqId: it.reqId == null ? null : String(it.reqId),
      title: String(it.title ?? "Run a tool"),
      options: parseOptions(it.bodyJson),
      status: String(it.status ?? "pending"),
      createdAt: String(it.createdAt ?? ""),
    }));
  } catch {
    return [];
  }
}

function parseOptions(bodyJson: unknown): PermissionOption[] {
  if (typeof bodyJson !== "string") return [];
  try {
    const v = JSON.parse(bodyJson);
    return Array.isArray(v) ? (v as PermissionOption[]) : [];
  } catch {
    return [];
  }
}

// Answer a pending permission server-side: the gateway routes the chosen option
// to the live agent, so any device can answer a prompt for any agent without
// holding that agent's SSE connection. Returns whether the answer was accepted
// (false if the prompt is already resolved or the agent is gone).
export async function answerInbox(agentName: string, reqId: string, optionId: string): Promise<boolean> {
  try {
    const u = new URL(base() + "/inbox/answer");
    u.searchParams.set("agent", agentName);
    u.searchParams.set("reqId", reqId);
    u.searchParams.set("optionId", optionId);
    const r = await fetch(u.toString(), { method: "POST" });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j?.ok;
  } catch {
    return false;
  }
}
