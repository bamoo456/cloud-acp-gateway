import type { PermissionOption } from "../types.ts";

export interface HistorySession { sessionId: string; title: string | null; updatedAt: string; }
export interface DiscoveredHistorySession extends HistorySession { cwd: string; source: "claude-cli"; }
export interface ViewBlock { type: "text" | "thought" | "tool" | "image"; text?: string; name?: string; toolCallId?: string; status?: string; output?: string; locations?: string[]; kind?: string; mimeType?: string; data?: string; uri?: string; }
export interface ViewMessage { role: "user" | "assistant"; blocks: ViewBlock[]; }
export interface MessagesResult { messages: ViewMessage[]; total: number; start: number; truncated: boolean; }
export interface DirEntry { name: string; git: boolean; }
export interface FsResult { root: string; path: string; parent: string | null; dirs: DirEntry[]; }

const base = () => location.protocol + "//" + location.host;

// Prose for the failures a person can act on. Keyed on a `code` the server
// sends rather than on its English message, so the wording is the client's to
// choose and stays fixable without touching the gateway.
const ERROR_TEXT: Record<string, string> = {
  "outside-root": "This file is outside the conversation's project, so the gateway won't read it. Add its folder to ACPG_PREVIEW_ROOTS to allow it.",
  "not-found": "This file no longer exists — it may have been moved, renamed, or deleted since the list was loaded.",
};

async function readJson(r: Response, unavailableMessage: string): Promise<any> {
  if (r.ok === false) {
    let body = "";
    try { body = (await r.text()).trim(); } catch { /* ignore */ }
    // A JSON error body is written for a program, not for a reader — rendering
    // it raw put a literal {"error":"path outside root"} in the panel. Use the
    // mapped text, or the caller's own message, but never the payload.
    if (body.startsWith("{")) {
      let code = "";
      try { code = String((JSON.parse(body) as { code?: unknown }).code ?? ""); } catch { /* not our shape */ }
      throw new Error(ERROR_TEXT[code] || unavailableMessage);
    }
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

// `page` picks one of two modes. Default: the last `limit` messages. With
// `from`/`to`: that absolute half-open range, which is how scrolling up walks
// backwards without repeating or skipping messages while the agent is still
// appending. `start` is the returned page's first index; a gateway too old to
// send it is read as 0, which just means "no paging available".
export async function getMessages(
  agent: string,
  cwd: string,
  session: string,
  page: { limit?: number; from?: number; to?: number } = {},
): Promise<MessagesResult> {
  const params = new URLSearchParams({ agent, cwd, session, limit: String(page.limit ?? 50) });
  if (page.from !== undefined && page.to !== undefined) {
    params.set("from", String(page.from));
    params.set("to", String(page.to));
  }
  const url = base() + "/history/messages?" + params.toString();
  const r = await readJson(await fetch(url), "Conversation history isn't available for this session yet.");
  return { messages: r.messages || [], total: r.total || 0, start: r.start || 0, truncated: !!r.truncated };
}

export async function renameSession(agent: string, cwd: string, session: string, title: string): Promise<void> {
  const url = base() + "/history/rename?agent=" + encodeURIComponent(agent) +
    "&cwd=" + encodeURIComponent(cwd) + "&session=" + encodeURIComponent(session) +
    "&title=" + encodeURIComponent(title);
  await fetch(url, { method: "POST" });
}

// Permanently delete a conversation — the transcript plus the gateway's own
// records of it. Addressed by session id alone: the id identifies the
// conversation, while an agent name or cwd only says where this client happened
// to see it (two agents can share one provider and its transcripts), so neither
// is something the client should be trusted to get right. `running`
// distinguishes the one refusal the UI can explain (409: a turn is still in
// flight) from a generic failure.
export async function deleteSession(session: string): Promise<{ ok: boolean; running: boolean }> {
  const url = base() + "/history/session?session=" + encodeURIComponent(session);
  try {
    const r = await fetch(url, { method: "DELETE" });
    return { ok: r.ok, running: r.status === 409 };
  } catch {
    return { ok: false, running: false };
  }
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

// Upload a generic (non-image) file attachment: the file's raw bytes as the
// POST body, its original name in ?name=. The response shape ({name, uri})
// drops straight into a MessageFile — identical to what makeMessageFile()
// builds for an "@ file" pick.
export async function uploadFile(file: File): Promise<{ name: string; uri: string }> {
  const url = base() + "/uploads?name=" + encodeURIComponent(file.name);
  const r = await fetch(url, { method: "POST", body: file });
  const j = await readJson(r, "Couldn't upload the file.");
  if (!j?.uri) throw new Error("Couldn't upload the file.");
  return { name: String(j.name || file.name), uri: String(j.uri) };
}

// ---- workspace file preview ----
// The agent writes files on the gateway host; these read them back so the panel
// can show what it produced instead of only what it said about it. Every path
// travels as the absolute path the gateway itself reported (ChangedFile.abs, or
// a tool call's own location), with `cwd` supplying the git context.
//
// The gateway serves what is inside the conversation's project (its cwd and the
// repo around it) plus whatever ACPG_PREVIEW_ROOTS names — see
// allowedPreviewPath in src/gateway.ts. A path outside all of those comes back
// as `outside-root`, which readJson turns into the prose above.
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
export interface ChangedFile {
  path: string;   // repo-root-relative, for display
  abs: string;    // how every other call addresses this file
  status: ChangeStatus;
  staged: boolean;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}
// `repo: null` means the folder isn't a git checkout (or git isn't installed) —
// `reason` distinguishes those so the panel can say which.
export interface ChangesResult { repo: string | null; files: ChangedFile[]; truncated: boolean; reason?: string }
export interface FileDiffResult { path: string; status: ChangeStatus; diff: string; binary: boolean; truncated: boolean }
export interface FilePreviewResult {
  path: string; abs: string;
  kind: "text" | "image" | "binary";
  size: number; modifiedAt: string;
  mimeType?: string; text?: string; truncated?: boolean;
}

export async function getWorkspaceChanges(cwd: string): Promise<ChangesResult> {
  const url = base() + "/workspace/changes?cwd=" + encodeURIComponent(cwd);
  const r = await readJson(await fetch(url), "File changes aren't available on this gateway.");
  return {
    repo: typeof r?.repo === "string" ? r.repo : null,
    files: Array.isArray(r?.files) ? r.files : [],
    truncated: !!r?.truncated,
    reason: typeof r?.reason === "string" ? r.reason : undefined,
  };
}

export async function getFileDiff(cwd: string, filePath: string): Promise<FileDiffResult> {
  const url = base() + "/workspace/diff?cwd=" + encodeURIComponent(cwd) + "&path=" + encodeURIComponent(filePath);
  const r = await readJson(await fetch(url), "Couldn't read this file's diff.");
  return {
    path: String(r?.path ?? filePath),
    status: (r?.status ?? "modified") as ChangeStatus,
    diff: typeof r?.diff === "string" ? r.diff : "",
    binary: !!r?.binary,
    truncated: !!r?.truncated,
  };
}

export async function getFilePreview(cwd: string, filePath: string): Promise<FilePreviewResult> {
  const url = base() + "/workspace/file?cwd=" + encodeURIComponent(cwd) + "&path=" + encodeURIComponent(filePath);
  const r = await readJson(await fetch(url), "Couldn't open this file.");
  return {
    path: String(r?.path ?? filePath),
    abs: String(r?.abs ?? filePath),
    kind: r?.kind === "image" || r?.kind === "binary" ? r.kind : "text",
    size: typeof r?.size === "number" ? r.size : 0,
    modifiedAt: String(r?.modifiedAt ?? ""),
    mimeType: typeof r?.mimeType === "string" ? r.mimeType : undefined,
    text: typeof r?.text === "string" ? r.text : undefined,
    truncated: !!r?.truncated,
  };
}

// The <img> source for an image preview, and the href behind "Download" for
// everything else. A URL rather than a fetch: the browser sends the console's
// Basic credentials with a subresource load on the same origin, so an <img>
// works without pulling megabytes of base64 through JSON first.
export function rawFileUrl(cwd: string, filePath: string): string {
  return base() + "/workspace/raw?cwd=" + encodeURIComponent(cwd) + "&path=" + encodeURIComponent(filePath);
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
  type: string; // 'permission' (one-tap options) | 'elicitation' (a form; answered in the conversation)
  agentName: string;
  sessionId: string | null;
  reqId: string | null;
  title: string;
  options: PermissionOption[];
  status: string;
  createdAt: string;
}

// Pending inbox prompts across every agent. Only a successful response is
// authoritative; null keeps the current client state intact during failures.
export async function getInboxPending(): Promise<InboxItem[] | null> {
  try {
    const r = await fetch(base() + "/inbox?status=pending");
    if (!r.ok) return null;
    const j = await r.json();
    const items: Array<Record<string, unknown>> = Array.isArray(j?.items) ? j.items : [];
    return items.map((it) => ({
      id: Number(it.id),
      type: String(it.type ?? "permission"),
      agentName: String(it.agentName ?? ""),
      sessionId: (it.sessionId as string | null) ?? null,
      reqId: it.reqId == null ? null : String(it.reqId),
      title: String(it.title ?? "Run a tool"),
      options: parseOptions(it.bodyJson),
      status: String(it.status ?? "pending"),
      createdAt: String(it.createdAt ?? ""),
    }));
  } catch {
    return null;
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

export interface SearchHit { index: number; role: "user" | "assistant"; snippet: string; offsets: Array<[number, number]>; }
export interface SearchResultSession {
  sessionId: string; source: "claude-cli" | "codex-cli"; agentName: string;
  cwd: string; title: string | null; updatedAt: string; hitCount: number; hits: SearchHit[];
}
export interface SearchResponse {
  results: SearchResultSession[]; truncated: boolean; cursor: string | null;
  skipped: string[]; scanned: { files: number; bytes: number; ms: number };
}
export interface SearchOptions {
  since?: string; until?: string; all?: boolean;
  agent?: string; cwd?: string; role?: "user" | "assistant";
  limit?: number; cursor?: string;
}

// Content search across conversations. `since`/`until` are date bounds — NOT the
// `from`/`to` message indices getMessages pages by.
export async function searchSessions(q: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  let url = base() + "/history/search?q=" + encodeURIComponent(q);
  if (opts.since) url += "&since=" + encodeURIComponent(opts.since);
  if (opts.until) url += "&until=" + encodeURIComponent(opts.until);
  if (opts.all) url += "&all=1";
  if (opts.agent) url += "&agent=" + encodeURIComponent(opts.agent);
  if (opts.cwd) url += "&cwd=" + encodeURIComponent(opts.cwd);
  if (opts.role) url += "&role=" + encodeURIComponent(opts.role);
  if (opts.limit) url += "&limit=" + opts.limit;
  if (opts.cursor) url += "&cursor=" + encodeURIComponent(opts.cursor);
  const r = await readJson(await fetch(url), "Search isn't available.");
  const results: Array<Record<string, unknown>> = Array.isArray(r?.results) ? r.results : [];
  const scannedRaw = r && typeof r.scanned === "object" && r.scanned !== null ? r.scanned : {};
  return {
    // A wrong-typed but truthy `hits` (or `results`/`skipped`) would otherwise pass a
    // gateway's malformed payload straight into a typed slot and throw when Task 11
    // iterates it — degrade those cases to the empty shape, same as every other
    // best-effort read in this file.
    results: results.map((s) => ({ ...s, hits: Array.isArray(s?.hits) ? s.hits : [] })) as SearchResultSession[],
    truncated: !!(r && r.truncated),
    cursor: (r && r.cursor) || null,
    skipped: Array.isArray(r?.skipped) ? r.skipped : [],
    scanned: {
      files: typeof scannedRaw.files === "number" ? scannedRaw.files : 0,
      bytes: typeof scannedRaw.bytes === "number" ? scannedRaw.bytes : 0,
      ms: typeof scannedRaw.ms === "number" ? scannedRaw.ms : 0,
    },
  };
}
