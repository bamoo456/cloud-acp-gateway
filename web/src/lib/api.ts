import type { PermissionOption, RateLimit } from "../types.ts";

export interface HistorySession { sessionId: string; title: string | null; updatedAt: string; }
export interface DiscoveredHistorySession extends HistorySession { cwd: string; source: "claude-cli"; }
export interface ViewBlock { type: "text" | "thought" | "tool" | "image"; text?: string; name?: string; toolCallId?: string; status?: string; output?: string; locations?: string[]; kind?: string; mimeType?: string; data?: string; uri?: string; }
export interface ViewMessage { role: "user" | "assistant"; blocks: ViewBlock[]; }
export interface MessagesResult {
  messages: ViewMessage[]; total: number; start: number; truncated: boolean;
  // The controls (config option id -> value) this conversation was last running,
  // as the gateway recorded them. Empty for a conversation older than that
  // tracking, and from a gateway too old to send it.
  controls: Record<string, string>;
}
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
  return {
    messages: r.messages || [], total: r.total || 0, start: r.start || 0, truncated: !!r.truncated,
    controls: r.controls && typeof r.controls === "object" ? r.controls : {},
  };
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
// as `outside-root`, which readJson turns into the prose above. A deployment can
// drop that filter entirely with ACPG_PREVIEW_FILTER_ENABLED=0, in which case
// nothing here is refused for being outside the project.
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
  // Present only for a text file the gateway read WHOLE. It is the token a save
  // echoes back, so its absence is also the answer to "can this be edited" — a
  // truncated read has no digest that describes the file.
  hash?: string;
}

// Which revision a workspace read is about. Null — the ordinary case — is the
// working tree, which is what the panel showed before Review mode existed.
//
//   { commit } — one commit's own change
//   { base }   — everything on HEAD since it diverged from `base`, i.e. what a
//                pull request is
// One of the two is set, never both and never neither — revSpecFrom in
// src/gateway.ts is the only thing that builds one from a request, and it
// refuses both cases. Two optional fields rather than a union of two shapes
// because a union of non-literal properties gives TypeScript nothing to
// discriminate on, so every read of it would need a cast to say what the
// runtime already guarantees.
export interface RevSpec { commit?: string; base?: string }

// The query fragment selecting `spec`, empty for the working tree. Every
// workspace read takes the same pair, so a Review-mode file list, its diffs and
// its draft all describe the same revision without any of them re-deriving it.
export function revParam(spec?: RevSpec | null): string {
  if (spec?.commit) return "&rev=" + encodeURIComponent(spec.commit);
  if (spec?.base) return "&base=" + encodeURIComponent(spec.base);
  return "";
}

export async function getWorkspaceChanges(cwd: string, spec?: RevSpec | null): Promise<ChangesResult> {
  const url = base() + "/workspace/changes?cwd=" + encodeURIComponent(cwd) + revParam(spec);
  const r = await readJson(await fetch(url), "File changes aren't available on this gateway.");
  return {
    repo: typeof r?.repo === "string" ? r.repo : null,
    files: Array.isArray(r?.files) ? r.files : [],
    truncated: !!r?.truncated,
    reason: typeof r?.reason === "string" ? r.reason : undefined,
  };
}

export async function getFileDiff(cwd: string, filePath: string, spec?: RevSpec | null): Promise<FileDiffResult> {
  const url = base() + "/workspace/diff?cwd=" + encodeURIComponent(cwd) +
    "&path=" + encodeURIComponent(filePath) + revParam(spec);
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
    hash: typeof r?.hash === "string" ? r.hash : undefined,
  };
}

// Replacing one file, with the digest of what was read as the precondition.
//
// The 409 is not an error to throw: it carries the file as it is NOW, and the
// caller's whole job at that point is to show both versions. So it comes back
// as a value, and only a genuinely failed request throws.
export type SaveFileResult =
  | { ok: true; size: number; modifiedAt: string; hash: string }
  | { ok: false; code: "stale"; text: string; hash: string; modifiedAt: string };

export async function saveFilePreview(
  cwd: string, filePath: string, text: string, hash: string,
): Promise<SaveFileResult> {
  const url = base() + "/workspace/file?cwd=" + encodeURIComponent(cwd) + "&path=" + encodeURIComponent(filePath);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, hash }),
  });
  const body = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (r.status === 409 && body?.code === "stale") {
    return {
      ok: false, code: "stale",
      text: String(body.text ?? ""), hash: String(body.hash ?? ""), modifiedAt: String(body.modifiedAt ?? ""),
    };
  }
  if (!r.ok) {
    throw new Error(
      r.status === 413 ? "This file is too large to save from the browser."
        : typeof body?.error === "string" ? body.error
        : "Couldn't save this file.",
    );
  }
  return { ok: true, size: Number(body?.size ?? 0), modifiedAt: String(body?.modifiedAt ?? ""), hash: String(body?.hash ?? "") };
}

// ---- browsing the project itself ----
// Outputs and Context answer "what did this conversation touch". These answer
// "what else is in here", which is the question you have when the file you want
// was never named in the thread. Same guard as the viewer, so every row listed
// is a row that opens.
export interface TreeEntry {
  name: string;
  abs: string;
  dir: boolean;
  size?: number;
  ignored?: boolean;  // git wouldn't track it — dimmed, still listed
  symlink?: boolean;
}
export interface TreeResult { abs: string; path: string; entries: TreeEntry[]; truncated: boolean }
export interface FoundFile { path: string; abs: string }
// `fromGit`: the search used git's file list, so ignored files were never
// candidates. The panel says so rather than letting a visible-but-ignored file
// look like a search that missed.
// `total` is how many files matched in all, of which `files` is the best slice;
// `pending` means the untracked half of the index hadn't arrived yet, and
// `limited` that a cap cut the indexed corpus short. All three exist so the
// panel can be honest about an incomplete answer instead of implying it is the
// whole one.
export interface FindResult {
  files: FoundFile[]; truncated: boolean; fromGit: boolean;
  total: number; pending?: boolean; limited?: boolean;
}

// The same folder searched by content instead of by name. `more` is how many
// further matches that one file holds, and `fromGit` false means nothing was
// searched at all — the folder isn't a checkout — rather than "no matches".
export interface GrepFile {
  path: string; abs: string;
  matches: Array<{ line: number; text: string }>;
  more: number;
}
export interface GrepResult {
  files: GrepFile[]; truncated: boolean; fromGit: boolean; total: number;
}

// `dir` omitted lists the conversation's own folder — the tree's root.
export async function getWorkspaceTree(cwd: string, dir?: string): Promise<TreeResult> {
  const url = base() + "/workspace/tree?cwd=" + encodeURIComponent(cwd)
    + (dir ? "&path=" + encodeURIComponent(dir) : "");
  const r = await readJson(await fetch(url), "Couldn't list this folder.");
  return {
    abs: String(r?.abs ?? dir ?? cwd),
    path: String(r?.path ?? ""),
    entries: Array.isArray(r?.entries) ? r.entries : [],
    truncated: !!r?.truncated,
  };
}

// ---- an .html output, with its assets ----
// A sandboxed iframe has an opaque origin and can load nothing from disk, so the
// gateway inlines the document's own images, fonts and stylesheets as data: URIs
// before it is rendered — the CSP the sandbox already carries allows exactly
// those. `skipped` is what it could not inline (a remote URL, an external
// <script src>, a file outside what the preview may read); the panel says so
// rather than letting a partly-inlined page read as a broken document.
export interface HtmlRender {
  html: string;
  inlined: number;
  skipped: number;
  truncated: boolean;      // an asset budget stopped the work
  htmlTruncated: boolean;  // the document itself was too big to read whole
}

export async function getHtmlRender(cwd: string, filePath: string): Promise<HtmlRender> {
  const url = base() + "/workspace/render?cwd=" + encodeURIComponent(cwd) + "&path=" + encodeURIComponent(filePath);
  const r = await readJson(await fetch(url), "Couldn't render this file.");
  return {
    html: typeof r?.html === "string" ? r.html : "",
    inlined: typeof r?.inlined === "number" ? r.inlined : 0,
    skipped: typeof r?.skipped === "number" ? r.skipped : 0,
    truncated: !!r?.truncated,
    htmlTruncated: !!r?.htmlTruncated,
  };
}

// ---- folders this conversation wrote into ----
// The third source behind Outputs, for the files the other two cannot see: a
// tool call names a path only when the tool takes one (`Bash` reports a command),
// and `git status` only knows a checkout. `dirs` are candidates the thread
// implies; the gateway refuses the ones inside the checkout — git's job — and
// the ones that are somewhere everything on the host lives, like /tmp itself.
export interface OutputFile { path: string; abs: string; size: number }
export interface OutputFolder { abs: string; files: OutputFile[]; truncated: boolean }

export async function getWorkspaceOutputs(cwd: string, dirs: string[]): Promise<OutputFolder[]> {
  if (!dirs.length) return [];
  const url = base() + "/workspace/outputs?cwd=" + encodeURIComponent(cwd)
    + dirs.map((d) => "&dir=" + encodeURIComponent(d)).join("");
  const r = await readJson(await fetch(url), "Couldn't list this conversation's output folders.");
  if (!Array.isArray(r?.folders)) return [];
  return r.folders.map((f: OutputFolder) => ({
    abs: String(f?.abs ?? ""),
    files: Array.isArray(f?.files) ? f.files : [],
    truncated: !!f?.truncated,
  }));
}

// ---- review ----
// The checkout's history, and the comments someone has written against a diff
// but not yet sent. The draft lives on the gateway host, in the repo being
// reviewed (see src/review.ts): a phone discards a backgrounded tab without
// warning, and a review started on a laptop should still be there on the phone.
export interface CommitEntry {
  sha: string; shortSha: string; author: string; date: string; subject: string;
  files?: number; additions?: number; deletions?: number;  // absent for a merge
}
export interface ReviewComment {
  path: string;            // repo-root-relative, as the changed-file list names it
  side: "new" | "old";
  line: number;
  endLine?: number;
  code: string;            // the diff line(s) as they read when the comment was written
  body: string;
  id?: string;
}

// `branch` and `defaultBase` ride along because Review mode fetches this once on
// open and needs both to offer "this branch against its base" without a second
// round trip. Either can be absent: a detached HEAD has no branch, and a
// checkout with no remote and no main/master has nothing to default to.
export async function getCommits(cwd: string): Promise<{
  repo: string | null; commits: CommitEntry[]; branch?: string; defaultBase?: string; reason?: string;
}> {
  const url = base() + "/workspace/commits?cwd=" + encodeURIComponent(cwd);
  const r = await readJson(await fetch(url), "This gateway can't list commits.");
  return {
    repo: typeof r?.repo === "string" ? r.repo : null,
    commits: Array.isArray(r?.commits) ? r.commits : [],
    branch: typeof r?.branch === "string" ? r.branch : undefined,
    defaultBase: typeof r?.defaultBase === "string" ? r.defaultBase : undefined,
    reason: typeof r?.reason === "string" ? r.reason : undefined,
  };
}

// `counts` covers every scope with a draft, not just the one asked for — that is
// what badges the Review tab before anything has been opened. `persisted` is
// false in a folder that isn't a checkout: comments still work, they just won't
// survive a reload, and the panel says so rather than silently losing them.
export async function getReviewDraft(cwd: string, spec?: RevSpec | null): Promise<{
  scope: string; comments: ReviewComment[]; counts: Record<string, number>; persisted: boolean;
}> {
  const url = base() + "/workspace/review?cwd=" + encodeURIComponent(cwd) + revParam(spec);
  const r = await readJson(await fetch(url), "Couldn't read this review's draft.");
  return {
    scope: String(r?.scope ?? "working"),
    comments: Array.isArray(r?.comments) ? r.comments : [],
    counts: r?.counts && typeof r.counts === "object" ? r.counts : {},
    persisted: !!r?.persisted,
  };
}

// Replaces the scope's comments wholesale — the list is small and last write
// wins, so there is no add/edit/delete protocol to keep in step with the UI.
// Never throws: a draft that can't be stored (read-only checkout, no repo) is
// reported so the panel can say so once, and is not a reason to lose a comment
// the person is still writing.
export async function saveReviewDraft(
  cwd: string, spec: RevSpec | null, comments: ReviewComment[],
): Promise<boolean> {
  const url = base() + "/workspace/review?cwd=" + encodeURIComponent(cwd) + revParam(spec);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comments }),
    });
    if (!r.ok) return false;
    return !!(await r.json())?.saved;
  } catch {
    return false;
  }
}

export async function findWorkspaceFiles(cwd: string, query: string): Promise<FindResult> {
  const url = base() + "/workspace/find?cwd=" + encodeURIComponent(cwd) + "&q=" + encodeURIComponent(query);
  const r = await readJson(await fetch(url), "Couldn't search this folder.");
  const files = Array.isArray(r?.files) ? r.files : [];
  return {
    files,
    truncated: !!r?.truncated,
    fromGit: !!r?.fromGit,
    // A gateway too old to send `total` still returns the matches it found, so
    // fall back to counting them rather than reporting a match set of zero.
    total: typeof r?.total === "number" ? r.total : files.length,
    pending: !!r?.pending,
    limited: !!r?.limited,
  };
}

export async function grepWorkspace(cwd: string, query: string): Promise<GrepResult> {
  const url = base() + "/workspace/grep?cwd=" + encodeURIComponent(cwd) + "&q=" + encodeURIComponent(query);
  const r = await readJson(await fetch(url), "Couldn't search this folder.");
  const files: GrepFile[] = (Array.isArray(r?.files) ? r.files : []).map((f: GrepFile) => ({
    path: String(f?.path ?? ""),
    abs: String(f?.abs ?? ""),
    matches: Array.isArray(f?.matches) ? f.matches : [],
    more: typeof f?.more === "number" ? f.more : 0,
  }));
  return {
    files,
    truncated: !!r?.truncated,
    // A gateway too old to know this route can't answer at all, so there is no
    // older-gateway shape to fall back to here — only the fields' own defaults.
    fromGit: !!r?.fromGit,
    total: typeof r?.total === "number" ? r.total : files.length,
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

// Hidden folders live on the server too (see /folders/pinned above) — a filter
// set up on one device must carry to every other one, which localStorage can't.
// There is no reader here on purpose: GET /prefs already hydrates the list on
// startup, and this toggle returns the updated one.
export async function toggleHiddenFolder(path: string): Promise<string[]> {
  const url = base() + "/folders/hidden?path=" + encodeURIComponent(path);
  const r = await readJson(await fetch(url, { method: "POST" }), "Couldn't update hidden folders.");
  return Array.isArray(r.hidden) ? r.hidden : [];
}

// Pinned conversations live on the server for the same reason the folder lists do:
// a pin is curation, not a per-device view preference, so it has to follow the
// account. Keys are "agentName\nsessionId" — the sidebar's own row key. There is no
// reader here on purpose: GET /prefs hydrates the list on startup, and this toggle
// returns the updated one.
export async function togglePinnedSession(agentName: string, sessionId: string): Promise<string[]> {
  const url = base() + "/history/pinned?agent=" + encodeURIComponent(agentName)
    + "&session=" + encodeURIComponent(sessionId);
  const r = await readJson(await fetch(url, { method: "POST" }), "Couldn't update pinned conversations.");
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
  hiddenFolders: string[];
  pinnedSessions: string[];
}

export async function getPrefs(): Promise<PrefsDto> {
  try {
    const r = await fetch(base() + "/prefs");
    if (!r.ok) return { textSize: null, lock: null, recentSessions: [], recentFolders: [], hiddenFolders: [], pinnedSessions: [] };
    const j = await r.json();
    return {
      textSize: typeof j?.textSize === "string" ? j.textSize : null,
      lock: j?.lock ?? null,
      recentSessions: Array.isArray(j?.recentSessions) ? j.recentSessions : [],
      recentFolders: Array.isArray(j?.recentFolders) ? j.recentFolders : [],
      hiddenFolders: Array.isArray(j?.hiddenFolders) ? j.hiddenFolders : [],
      pinnedSessions: Array.isArray(j?.pinnedSessions) ? j.pinnedSessions : [],
    };
  } catch {
    return { textSize: null, lock: null, recentSessions: [], recentFolders: [], hiddenFolders: [], pinnedSessions: [] };
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

// `seedTitle` says the title was derived here (first user message, or "Untitled")
// rather than chosen by the user, so the gateway may only apply it to a row that
// doesn't exist yet — see Db.touchRecentSession.
export async function postRecentSession(
  s: { agentName: string; cwd: string; sessionId: string; title: string; lastActiveAt: string },
  seedTitle = false,
): Promise<void> {
  try {
    const url = base() + "/prefs/recent-session?agent=" + encodeURIComponent(s.agentName) +
      "&cwd=" + encodeURIComponent(s.cwd) + "&session=" + encodeURIComponent(s.sessionId) +
      "&title=" + encodeURIComponent(s.title) + "&at=" + encodeURIComponent(s.lastActiveAt) +
      (seedTitle ? "&seed=1" : "");
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

// This account's quota windows, keyed the same way the ACP rate-limit path
// keys them ("five_hour", "seven_day", …) and carrying the same
// {utilization, resetsAt} shape, so both sources land in one store map and the
// gauge renders them identically. Unlike the ACP path this needs no turn to have
// happened. `null` means the gateway couldn't say (too old to have the route,
// offline, no credential) — which is different from "no windows". `kind`
// selects which account the gateway reads — Claude's own OAuth usage endpoint,
// or Codex's ChatGPT-backend one on "codex". `unlimited` is set for a
// Business/enterprise seat, which reports no windows at all — metered by
// credits instead — so the UI has something to show besides a blank row.
export interface UsageLimitsResult { windows: Record<string, RateLimit>; unlimited?: boolean; unavailable?: string }

export async function getUsageLimits(kind: "claude" | "codex" = "claude"): Promise<UsageLimitsResult | null> {
  try {
    const r = await fetch(base() + "/usage/limits?kind=" + kind);
    if (!r.ok) return null;
    const j = await r.json();
    // "unavailable" is an answer, not a failure — the gateway says it when the
    // account's credential is expired or missing, which no amount of retrying
    // fixes. Passing it through is what lets the strip say so; dropping it (as
    // this did) leaves an empty gauge that reads as a broken feature.
    if (j?.status === "unavailable") {
      return { windows: {}, unavailable: typeof j.reason === "string" ? j.reason : "unknown" };
    }
    if (j?.status !== "ok" || !j.windows || typeof j.windows !== "object") return null;
    return { windows: j.windows as Record<string, RateLimit>, unlimited: j.unlimited === true || undefined };
  } catch {
    return null;
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

// Clear a conversation's finished-turn unreads. The badge is server state (so it
// spans devices), which is why opening the conversation has to tell the gateway
// rather than just clearing something locally. Best-effort: a failure only means
// the next /inbox poll brings the badge back.
export async function markInboxRead(sessionId: string): Promise<void> {
  try {
    const u = new URL(base() + "/inbox/read");
    u.searchParams.set("sessionId", sessionId);
    await fetch(u.toString(), { method: "POST" });
  } catch {
    // ignore
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
  // Find-in-conversation: one session, no date window (the gateway drops
  // since/until for a scoped search), every matching message rather than the
  // three a results list shows.
  session?: string;
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
  if (opts.session) url += "&session=" + encodeURIComponent(opts.session);
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
