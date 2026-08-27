import { create } from "zustand";
import { Acp, sseFactory, type RpcMessage } from "../lib/acp.ts";
import { readConfig, sseUrl, rpcUrl, linkParams, shareUrl } from "../lib/config.ts";
import { getMessages, renameSession as apiRename, deleteSession as apiDelete, getPrefs, putTextSize, answerInbox, markInboxRead, toggleHiddenFolder as apiToggleHiddenFolder, togglePinnedSession as apiTogglePinnedSession, toggleArchivedSession as apiToggleArchivedSession, type RunningTask, type InboxItem } from "../lib/api.ts";
import { resolveRunningTask, ingestSeen, type RunningSeen } from "../lib/runningTask.ts";
import { readRecentSessions, touchRecentSession, removeRecentSession, renameRecentSession as renameRecentCache, hydrateRecentSessions, type RecentSession } from "../lib/recentSessions.ts";
import { touchRecentFolder, hydrateRecentFolders } from "../lib/recentFolders.ts";
import { isLockEnabled, hydrateLock } from "../lib/lock.ts";
import { basename } from "../lib/format.ts";
import { lastRanOn } from "../lib/engine.ts";
import { isDesktopPanelWidth } from "../lib/panelWidth.ts";
import { isDesktopSidebarWidth } from "../lib/sidebarWidth.ts";
import { execCommand, shellContext, shellNote } from "../lib/terminal.ts";
import {
  makeSession, applyUpdate, addUserBubble, applyModelsModes, applyHistoryMessages, remapSession, setTitle, evictExcess,
  EMPTY_ENGINE,
} from "./reducers.ts";
import type {
  Session, SessionEngine, ConfigOption, PermissionOption, NewSessionResult, ThreadItem, PendingPermission,
  AgentSkin, MessageImage, MessageFile, QueuedPrompt, PromptCapabilities, ElicitationResponse, RateLimit,
} from "../types.ts";
import { parseElicitationFields } from "../lib/elicitation.ts";

type ConnState = "connecting" | "connected" | "offline";
export type TextSize = "small" | "default" | "large" | "xl";

// Which view of a file the preview pane opens in. "diff" is the default for
// anything the agent changed — that's the question being asked — and it falls
// back to the contents view on its own when there is no diff to show (an
// untouched file, a binary, an image).
// "render" is only ever reached from inside the panel's own mode toggle (see
// FilePanel.tsx) — nothing opens a file straight into it.
export type PreviewMode = "diff" | "file" | "render";
// `abs` is the gateway-side absolute path (how the API addresses a file);
// `path` is the short label shown in the panel's title bar.
// `cwd` is the folder the file was opened FROM, and only set when that isn't the
// conversation's own: /workspace/* resolves a path against the cwd it is sent,
// so a file browsed in another project must carry that project's root or the
// gateway refuses to read it.
export interface FilePreviewTarget { abs: string; path: string; mode: PreviewMode; cwd?: string }

// One floating conversation window (see State's `sideWindows`).
// `slot` is which default corner offset the card is born at, so several open at
// once cascade instead of landing on top of each other. Assigned at open time
// from the free slots rather than derived from the list order, because the list
// is reordered as windows are raised and a position that moved when a *different*
// card was clicked would read as the card jumping on its own.
export interface SideWindow { sessionId: string; parentId: string | null; slot: number }

// The engine lists to read out for a conversation: the one named, or the one in
// the main column. Every consumer goes through this rather than through a global,
// so a dock can only ever show the conversation it is pointed at (a card's own,
// EngineDock's `sessionId`) — and a conversation the agent has not reported on
// reads out empty instead of borrowing another one's values.
export function engineOf(
  state: Pick<State, "sessions" | "activeId">,
  sessionId?: string,
): SessionEngine {
  const id = sessionId ?? state.activeId;
  return (id ? state.sessions[id]?.engine : null) ?? EMPTY_ENGINE;
}

type PromptRequestMethod = "session/request_permission" | "elicitation/create";

type PromptResolution = {
  sessionId: string;
  requestId: number | string;
  requestMethod: PromptRequestMethod;
};

export const TEXT_SIZE_OPTIONS: Array<{ id: TextSize; label: string; description: string }> = [
  { id: "small", label: "Small", description: "More messages on screen" },
  { id: "default", label: "Default", description: "Current Claude-style reading size" },
  { id: "large", label: "Large", description: "Easier reading on phone" },
  { id: "xl", label: "XL", description: "Maximum readability" },
];

// A branch's name, derived from what it was branched off: "X (Branch)", then
// "X (Branch 2)" for the next one off the same name, matching how the Claude CLI
// names its own branches. Branching a branch bumps the counter rather than
// stacking suffixes, so a chain of them stays readable.
export function branchTitle(title: string): string {
  const m = /^(.*?) \(Branch(?: (\d+))?\)$/.exec(title.trim());
  if (!m) return (title.trim() || "Untitled") + " (Branch)";
  return m[1] + " (Branch " + (m[2] ? Number(m[2]) + 1 : 2) + ")";
}

function normalizeTextSize(value: unknown): TextSize {
  return TEXT_SIZE_OPTIONS.some((o) => o.id === value) ? value as TextSize : "default";
}

function applyTextSize(size: TextSize) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.textSize = size;
}

function applyAgentSkin(skin: AgentSkin | null) {
  if (typeof document === "undefined") return;
  if (skin) document.documentElement.dataset.agentSkin = skin;
  else delete document.documentElement.dataset.agentSkin;
}

// Identity color for the active agent, exposed as --agent-color on <html> so the
// edge accents (content left rail, composer ring) tint themselves. Keyed by skin
// (Codex) / name (Claude), else the app accent — mirrors AgentPill's mark logic.
function applyAgentColor(color: string) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--agent-color", color);
}

function normalizeAgentSkin(skin: unknown): AgentSkin | null {
  return skin === "codex" || skin === "opencode" ? skin : null;
}

interface State {
  cfg: ReturnType<typeof readConfig>;
  agentName: string;
  cwd: string;
  conn: ConnState;
  agentReady: boolean;
  tip: string;
  sessions: Record<string, Session>;
  activeId: string | null;
  // The floating windows, oldest first — the last one is the front-most (see
  // BranchWindow.tsx's z-order). Two ways in: a fork of `parentId`
  // (`branchSession`) or an existing conversation opened beside the open one
  // (`openSideChat`) — the window renders both the same way, because from the
  // reader's side they are the same thing: a live conversation next to the one on
  // screen. Each occupant is an ordinary live session in `sessions`; an entry only
  // records that it has a window. Memory-only, so a reload leaves them all as
  // normal conversations.
  // A window is NOT tied to the conversation it was opened over: it stays up
  // while the reader moves around the main column, and hides only while its own
  // conversation is the one on screen (the same thread in both places). `parentId`
  // is the conversation it was forked from (null for a side chat, which was forked
  // from nothing) and is kept for three things: one branch per parent
  // (`branchGate`), closing the window when that fork's own session is deleted,
  // and as the card's identity across the provisional→real id swap.
  // Capped at MAX_SIDE_WINDOWS: every entry is pinned against eviction, so an
  // unbounded list would starve MAX_LIVE_SESSIONS' LRU.
  sideWindows: SideWindow[];
  // NOTE: there is deliberately no store-global models/modes/commands/
  // configOptions. Every one of those describes ONE conversation, and holding
  // them globally meant the last session call won: a notification for a
  // background session relabelled the one on screen, and switching between two
  // live conversations left the previous one's model on the dock. They live on
  // the session now (types.ts's SessionEngine) — read them with engineOf().
  // provider kind ("claude" / "codex") -> rateLimitType -> the latest window
  // that account reported. Keyed by provider, not by the active agent: each
  // provider's quota is polled continuously regardless of which agent is on
  // screen (UsageStrip.tsx shows the active one by default, every provider on
  // hover/click), so switching agents must never wipe another provider's data.
  rateLimits: Record<string, Record<string, RateLimit>>;
  // provider kind -> whether that account reported no windows because it's a
  // Business/enterprise seat metered by credits instead (UsageStrip.tsx shows
  // this as an unbounded gauge rather than leaving the row blank).
  quotaUnlimited: Record<string, boolean>;
  // provider kind -> why the gateway could not read that account's quota
  // ("expired", "reauth", "no-credential", "network", …), or absent when it
  // could. A quota that silently renders nothing is indistinguishable from a
  // broken gauge, and the credential reasons need the user to go and re-auth.
  quotaUnavailable: Record<string, string>;
  promptCapabilities: PromptCapabilities; // what the active agent accepts in a prompt (image, …)
  pendingPermissions: PendingPermission[];
  promptStateRevision: number;
  autoApprove: boolean;
  textSize: TextSize;
  busy: boolean;
  busySessionIds: Record<string, true>;
  // sessionId -> messages typed while that session's turn was in flight, in the
  // order they were typed. Drained ONE per turn end (runPrompt's finally), so two
  // queued messages become two consecutive turns rather than one merged prompt —
  // the agent gets to finish reacting to the first before it reads the second.
  // ponytail: per-tab. A queue dies with the page and no other device sees it;
  // park it in the gateway (Agent.reviveQueue already parks frames per session)
  // if it ever has to survive a reload or show up on the phone.
  queuedPrompts: Record<string, QueuedPrompt[]>;
  // sessionId -> transcripts of "!" commands run since that session's last
  // prompt, waiting to ride ahead of the next one (runPrompt spends the entry).
  // Client-memory only, like the queue above: a reload before the next send
  // drops it — the output is still in the thread, the model just never hears it.
  shellStash: Record<string, string>;
  joining: boolean; // resolving a ?session= deep-link (show a loading state, not "Ready to code?")
  historyNonce: number; // bumped to ask the sidebar to refresh its conversation list (e.g. after rename)
  recentSessions: RecentSession[];
  // Folders chosen (in the folder picker) never to show in the sidebar list —
  // like pinned folders, this lives on the gateway so it's the same on every
  // device. Paths, not patterns (see lib/sessionGroups.ts's hideFolders).
  hiddenFolders: string[];
  // Conversations pinned to the top of the sidebar list, as "agent\nsessionId"
  // keys — the sidebar's own row key. On the gateway like hiddenFolders: a pin is
  // curation, not a per-device view preference, so it follows the account.
  pinnedSessions: string[];
  // Conversations archived out of the default sidebar list — "agent\nsessionId"
  // keys, the same shape the sidebar keys its rows by. Server-persisted like
  // hiddenFolders; the transcript itself is untouched and stays searchable.
  archivedSessions: string[];
  // "agent\nsessionId" -> the title the gateway's own listings report, which is
  // where a rename actually lands (the per-cwd titles sidecar). Filled by the
  // sidebar as it fetches /history and /history/discovered, and read back by
  // anything rendering a conversation from a staler source — recents rows are
  // snapshots taken when a conversation was last touched, and a running task's
  // label is the text of its first prompt. Lives in the store rather than in the
  // sidebar so jumpToTask and the TopBar's task popup resolve the same name the
  // sidebar shows.
  historyTitles: Record<string, string>;
  runningTasks: RunningTask[]; // polled from the gateway: sessions with a prompt in flight, across all agents
  // Tasks seen running, stamped with last-seen time — keeps a just-finished
  // conversation in the sidebar's Running section for a short grace window.
  runningSeen: Record<string, RunningSeen>;
  inboxItems: InboxItem[]; // polled from the gateway: pending permission prompts, durable and across all agents
  locked: boolean; // screen lock engaged — the SSE stream is torn down until unlocked
  lockEnabled: boolean; // a PIN is configured (mirrors lib/lock for UI reactivity)
  // ---- file preview panel ----
  // The panel that shows what the agent actually wrote: the folder's changed
  // files, and one file at a time as a diff, as text, or as an image. It lives
  // in the store rather than in App's local state because the things that open
  // it are scattered through the thread (a tool card's file path), not just the
  // header button.
  filesOpen: boolean;
  // The folder's diffstat, as the file panel last read it. Lives here because
  // the status bar reports it too (§1.4) and that row exists whether or not the
  // panel is open. Null until the first `git status` lands.
  changeStat: { files: number; additions: number; deletions: number } | null;
  // ---- sessions sidebar (desktop column only) ----
  // Whether the left column is expanded at >=860px. Separate from App's mobile
  // `panel` overlay state: collapsing/expanding the column must not re-run the
  // sheet's open-reset (tab, filters), only hide the column.
  sidebarOpen: boolean;
  // Which file the preview pane is showing; null means the file list.
  filePreview: FilePreviewTarget | null;
  // Files staged on the composer, waiting to be sent with the next message —
  // the chips above the input. In the store for the same reason the preview
  // panel is: they are added from the file panel as well as from the composer's
  // own "@" picker, and the panel cannot reach into the composer's local state.
  attachedFiles: MessageFile[];
  // actions
  bootstrap: () => void;
  setAgent: (name: string) => void;
  setActive: (id: string) => void;
  selectSession: (id: string) => void;
  newSession: () => Promise<void>;
  // atMessage: an absolute message index (a search hit) to open the conversation at,
  // instead of its tail.
  openHistorySession: (s: { sessionId: string; title: string | null; agentName?: string; cwd?: string; atMessage?: number }) => Promise<void>;
  openRecentSession: (s: RecentSession) => Promise<void>;
  loadOlderMessages: (id: string) => Promise<void>;
  sendPrompt: (text: string, images?: MessageImage[], files?: MessageFile[]) => Promise<void>;
  // Prompt a specific live conversation, leaving `activeId` alone — what the
  // branch window's own composer sends through. Unlike sendPrompt it does not
  // start, resume, or remap anything: a branch is created live by session/fork,
  // so none of that resolution applies and a caller naming a session that isn't
  // live is a no-op rather than a silent new conversation. Resolves true when the
  // message was taken — on false the caller still holds the only copy of it, which
  // is what lets the queue drain put a refused message back rather than eat it.
  sendPromptTo: (sessionId: string, text: string, images?: MessageImage[], files?: MessageFile[]) => Promise<boolean>;
  // Park a message typed mid-turn (see queuedPrompts). The composer clears its box
  // on queue, so from here on this is the only copy — takeQueuedPrompts hands them
  // back, which is what stop does instead of firing or dropping them.
  queuePrompt: (sessionId: string, prompt: { text: string; images?: MessageImage[]; files?: MessageFile[] }) => void;
  // The composer's "!" escape: run a host shell command (/terminal/exec), show
  // the transcript in this conversation, and stash it to preface the next
  // prompt. No agent turn fires — like Claude Code's own "!", the model learns
  // about it the next time the user actually says something.
  runShell: (sessionId: string, cmd: string) => Promise<void>;
  // Cut the running turn short and send this message as the next one — the
  // composer's stop button with something typed in the box. The already-queued
  // messages keep their place behind it (V1): an interrupt says "this one first",
  // not "forget what I asked for".
  interruptWith: (sessionId: string, prompt: { text: string; images?: MessageImage[]; files?: MessageFile[] }) => void;
  unqueuePrompt: (sessionId: string, id: string) => void;
  takeQueuedPrompts: (sessionId: string) => QueuedPrompt[];
  // Fork the open conversation into a new one (whole history, agent-side), open
  // it as the branch window, and ask the fork the message the caller was
  // holding. The prompt is the point, not a convenience: a branch nobody says
  // anything in has no transcript on disk, so it can only ever surface as a
  // conversation that fails to open. Resolves true when the fork landed — on
  // false the caller still holds the only copy of that message.
  branchSession: (prompt: { text: string; images?: MessageImage[]; files?: MessageFile[] }) => Promise<boolean>;
  // Open an EXISTING conversation in a floating window, beside the one that stays
  // in the main column — the sidebar row's "Open as side chat". Not a fork and not
  // a navigation: the open conversation is untouched (`activeId` and the global
  // `cwd` both stand), and the target is resumed live so it can be chatted in.
  // The row carries its own agent and folder, which is why the target has to name
  // all three: `cwd` is what session/load is asked about.
  openSideChat: (target: { sessionId: string; agentName: string; cwd: string; title: string | null }) => Promise<void>;
  closeSideWindow: (sessionId: string) => void;
  // Bring a window to the front, by moving it to the end of `sideWindows`. Called
  // on pointerdown anywhere in the card, so the one being touched is the one on
  // top — cascaded cards overlap by design.
  raiseSideWindow: (sessionId: string) => void;
  // No sessionId = the conversation in the main column; a sessionId = any live
  // conversation, which is how a floating window's own dock sets ITS model, mode
  // and options without touching the one on screen. A windowed target reads and
  // writes that window's `engine` lists instead of the store's global ones.
  setModel: (id: string, sessionId?: string) => void;
  setMode: (id: string, sessionId?: string) => void;
  setConfigOption: (configId: string, value: string, sessionId?: string) => void;
  cancel: (sessionId?: string) => void;
  setCwd: (p: string) => void;
  // Toggles a folder's hidden state via the gateway; best-effort like the
  // folder picker's own pin toggle, so a failed round-trip just leaves the
  // list as it was.
  toggleHiddenFolder: (path: string) => void;
  // Toggles a conversation's pin via the gateway, best-effort like
  // toggleHiddenFolder — a failed round-trip leaves the list as it was.
  togglePinnedSession: (agentName: string, sessionId: string) => void;
  // Toggles a conversation's archived state via the gateway; best-effort for
  // the same reason as toggleHiddenFolder.
  toggleArchivedSession: (agentName: string, sessionId: string) => void;
  toggleAuto: () => void;
  setTextSize: (size: TextSize) => void;
  setTip: (t: string) => void;
  readActiveSession: () => void;
  // No target = the active conversation (the ActionMenu path); a target = any
  // conversation, active or not (the sidebar's per-row rename). A sidebar row
  // carries its OWN agent and folder — a discovered row names a conversation in
  // a folder this client isn't even in — so the target must supply all three.
  renameSession: (title: string, target?: { sessionId: string; agentName: string; cwd: string }) => void;
  // No argument = the active conversation (the ActionMenu path); an id = any
  // conversation, active or not (the sidebar's per-row delete).
  deleteSession: (sessionId?: string) => Promise<void>;
  answerPermission: (reqId: number | string, optionId: string) => void;
  answerElicitation: (reqId: number | string, response: ElicitationResponse, summary: string) => void;
  answerInboxItem: (agentName: string, reqId: string, optionId: string) => void;
  jumpToTask: (task: RunningTask) => void;
  // Record what a freshly-fetched listing calls these conversations. Merge-only:
  // a listing covers one folder (or one provider's discoverable store), so absence
  // from it means "not asked about", never "no longer named".
  mergeHistoryTitles: (rows: Array<{ agentName: string; sessionId: string; title: string | null }>) => void;
  ingestUsageLimits: (kind: string, windows: Record<string, RateLimit>, unlimited?: boolean, unavailable?: string) => void;
  ingestRunningTasks: (tasks: RunningTask[]) => void;
  ingestInboxItems: (items: InboxItem[], expectedRevision: number) => void;
  ensureConnected: () => void;
  lock: () => void;
  unlock: () => void;
  refreshLockSettings: () => void;
  setChangeStat: (stat: State["changeStat"]) => void;
  toggleFiles: () => void;
  closeFiles: () => void;
  toggleSidebar: () => void;
  // Opens the panel *and* the file — the one entry point for "show me this
  // file", wherever the path was clicked.
  openFilePreview: (file: { abs: string; path?: string; mode?: PreviewMode; cwd?: string }) => void;
  clearFilePreview: () => void;
  attachFiles: (files: MessageFile[]) => void;
  removeAttachedFile: (index: number) => void;
  clearAttachedFiles: () => void;
}

type SkinState = Pick<State, "cfg" | "agentName">;

// The skin is whatever the gateway computed from the agent's binary name
// (agentSkinFor: "codex" for codex-acp, otherwise unset). We must NOT infer it
// from configOptions: the claude-agent-acp adapter now also emits configOptions
// (mode/model/effort selectors), so "has configOptions ⇒ Codex" mis-skins Claude.
function activeAgentSkin(state: SkinState): AgentSkin | null {
  return normalizeAgentSkin(
    state.cfg.agents.find((a) => a.name === state.agentName)?.skin,
  );
}

// Whether the "branch this conversation" affordance should be offered, and why
// not when it shouldn't. Lives here rather than in the component that renders it
// because the answer is entirely about store state, and the reason strings are
// what the button says on hover — a disabled control that doesn't explain itself
// is a dead end. `show: false` (the agent never advertised
// `sessionCapabilities.fork`) means don't render it at all: a permanently dead
// button teaches nothing.
export interface BranchGate { show: boolean; disabled: boolean; why: string }
export function branchGate(state: State): BranchGate {
  const show = state.cfg.agents.find((a) => a.name === state.agentName)?.sessionFork === true;
  const ready = !!state.activeId && !state.activeId.startsWith("pending-");
  // A turn in flight is not in the transcript yet, so forking mid-turn would
  // silently drop that reply; one parent tracks one branch at a time.
  const running = state.runningTasks.some((t) => t.agentName === state.agentName && t.sessionId === state.activeId)
    || (!!state.activeId && !!state.busySessionIds[state.activeId]);
  const open = state.sideWindows.some((w) => w.parentId === state.activeId);
  const full = state.sideWindows.length >= MAX_SIDE_WINDOWS;
  const why = !ready ? "Send a message first"
    : running ? "Wait for this turn to finish"
    : open ? "This conversation already has a branch open"
    : full ? "Close a floating conversation first"
    : "Branch conversation — forks it into a floating window";
  return { show, disabled: !ready || running || open || full, why };
}

export function hasCodexSkin(state: SkinState): boolean {
  return activeAgentSkin(state) === "codex";
}

// Which provider's quota an agent config maps to — the only two the gateway's
// /usage/limits route knows how to fetch. `kind` is absent on agents configured
// before it existed, so an unnamed kind falls back to the agent's own name.
export function agentQuotaKind(agent: { kind?: string; name: string } | undefined): "claude" | "codex" | null {
  const kind = agent?.kind ?? agent?.name;
  return kind === "claude" || kind === "codex" ? kind : null;
}

export function activeQuotaKind(state: SkinState): "claude" | "codex" | null {
  return agentQuotaKind(state.cfg.agents.find((a) => a.name === state.agentName));
}

function activeAgentColor(state: SkinState): string {
  if (activeAgentSkin(state) === "codex") return "var(--agent-codex)";
  if (state.cfg.agents.find((a) => a.name === state.agentName)?.name === "claude") return "var(--agent-claude)";
  return "var(--accent)";
}

let acp: Acp = undefined as unknown as Acp;
let sessionInit: Promise<unknown> | null = null;
let creatingSession = false; // a "+" / New chat round-trip is in flight — ignore repeat clicks
let pendingResyncId: string | null = null;
// Set by selectSession when the target lives under another agent; consumed by
// handleStatus once that agent's connection is ready (single activation path).
let pendingActivateId: string | null = null;
// Handle for the auto-reconnect backoff timer, so a foreground/pageshow resume can
// cancel it and reconnect immediately instead of racing a second socket against it.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function clearReconnectTimer() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
// agentName -> the conversation that was open under it when we switched away, so
// switching back restores it instead of dropping into a blank new session. Only
// the id and folder: the engine lists used to be stashed here too, because they
// were store-global and setAgent cleared them — they live on the session now
// (SessionEngine), and sessions survive an agent switch, so they come back with it.
const lastSessionByAgent = new Map<string, { id: string; cwd: string }>();
// agentName -> highest SSE seq seen on that agent's stream, so switching back to
// an agent resumes its stream after that seq and the ledger replays the frames
// produced while we were away. Survives Acp recreation (per-agent channels).
const agentCursors = new Map<string, number>();
const PROVISIONAL = () => "pending-" + Math.random().toString(36).slice(2);
const MAX_LIVE_SESSIONS = 8;
// How many floating windows can be up at once. Not a layout limit — a cascade of
// cards fits fine — but an eviction one: every open window pins its conversation
// against MAX_LIVE_SESSIONS' LRU (see evictExcess's `pinned`), so this is what
// leaves the main column slots to browse with.
const MAX_SIDE_WINDOWS = 3;
// The default-position slot a new window is born at (SideWindow's `slot`): the
// lowest one nothing else holds, so cards cascade instead of landing on top of
// each other, and closing the middle one frees its place for the next.
function freeSlot(wins: SideWindow[]): number {
  for (let n = 0; n < MAX_SIDE_WINDOWS; n++) if (!wins.some((w) => w.slot === n)) return n;
  return 0;
}
// Ids for queued messages. A counter rather than the session's own `seq`: a queued
// message is not in the transcript yet, and reusing seq would collide with the item
// the send eventually appends.
let queueSeq = 0;
const QUEUE_ID = () => "q" + (queueSeq += 1);

// Move a session's queue onto its real id. sendPromptTo refuses a provisional
// ("pending-") session, so a message queued against one while session/new was in
// flight would sit under a key nothing ever drains. Appends rather than replaces:
// the destination is normally empty, and losing either side to a clobber is the one
// outcome worse than an odd order.
function remapQueue(q: Record<string, QueuedPrompt[]>, from: string, to: string): Record<string, QueuedPrompt[]> {
  if (!q[from]?.length) return q;
  const next = { ...q };
  delete next[from];
  next[to] = [...(next[to] ?? []), ...q[from]];
  return next;
}

const HISTORY_PAGE = 50;
// A search hit deep-links to an absolute message index. Anchor its page a little
// BEFORE the match so the lead-in to it is on screen rather than the match sitting
// on the very first line. Keyed on `undefined`, never on falsiness: index 0 is a
// legitimate hit (the conversation's opening message).
const HIT_LEAD_IN = 10;
function historyPageFor(atMessage?: number): { limit?: number; from?: number; to?: number } {
  if (atMessage === undefined) return { limit: HISTORY_PAGE };
  const from = Math.max(0, atMessage - HIT_LEAD_IN);
  return { from, to: from + HISTORY_PAGE };
}

export const useStore = create<State>((set, get) => {
  const cfg = readConfig();
  // A deep-link's ?agent= wins so the session opens under the agent it belongs to;
  // otherwise connect to the gateway's default agent (ACPG_DEFAULT_AGENT) when it
  // names a configured agent, else the first agents.json entry.
  const linkedAgentName = linkParams().agent;
  const linkedAgent = linkedAgentName ? cfg.agents.find((a) => a.name === linkedAgentName) : undefined;
  const initialAgent =
    linkedAgent ??
    cfg.agents.find((a) => a.name === cfg.defaultAgent) ??
    cfg.agents[0];
  // Text size, recents, and the lock config all live on the gateway now (shared
  // across devices). They start at defaults and are hydrated by bootstrap()'s
  // GET /prefs; the page paints at the default size for that first round-trip.
  const initialTextSize: TextSize = "default";
  applyTextSize(initialTextSize);

  // patch a session immutably by id
  const patch = (id: string, fn: (s: Session) => Session) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : {}));

  // The one way this store caps the live-session map: every conversation with a
  // floating window is exempt as well as the active one. `wins` defaults to the
  // current list, and is passed explicitly by the two callers that open a window
  // and evict in the same update.
  const trimSessions = (
    sessions: Record<string, Session>,
    keep: string | null,
    wins: SideWindow[] = get().sideWindows,
  ) => evictExcess(sessions, keep, MAX_LIVE_SESSIONS, wins.map((w) => w.sessionId));

  const sameReq = (a: number | string, b: number | string) => String(a) === String(b);

  // Both blocking prompt kinds — permission cards and elicitation (agent
  // question) forms — resolve the same way: flagged answered with a short
  // human-readable recap of what was chosen.
  const isPromptItem = (it: ThreadItem): it is Extract<ThreadItem, { kind: "permission" | "elicitation" }> =>
    it.kind === "permission" || it.kind === "elicitation";

  function markPromptResolved(s: Session, reqId: number | string, chosen: string): Session {
    let changed = false;
    const items = s.items.map((it) => {
      if (!isPromptItem(it) || it.resolved || !sameReq(it.reqId, reqId)) return it;
      changed = true;
      return { ...it, resolved: true, chosen };
    });
    return changed ? { ...s, items } : s;
  }

  function promptMethodOf(pending: PendingPermission): PromptRequestMethod {
    return pending.elicitation ? "elicitation/create" : "session/request_permission";
  }

  function hasPendingPrompt(items: PendingPermission[], candidate: PendingPermission): boolean {
    return items.some((item) =>
      item.agentName === candidate.agentName &&
      item.sessionId === candidate.sessionId &&
      sameReq(item.reqId, candidate.reqId) &&
      promptMethodOf(item) === promptMethodOf(candidate));
  }

  function itemMatchesResolution(
    item: ThreadItem,
    resolution: PromptResolution,
  ): item is Extract<ThreadItem, { kind: "permission" | "elicitation" }> {
    const expectedKind = resolution.requestMethod === "elicitation/create"
      ? "elicitation"
      : "permission";
    return item.kind === expectedKind && sameReq(item.reqId, resolution.requestId);
  }

  function applyRemotePromptResolution(sourceAgent: string, resolution: PromptResolution) {
    set((state) => {
      const pendingMatches = (pending: PendingPermission) =>
        pending.agentName === sourceAgent &&
        pending.sessionId === resolution.sessionId &&
        sameReq(pending.reqId, resolution.requestId) &&
        promptMethodOf(pending) === resolution.requestMethod;
      const inboxMatches = (item: InboxItem) =>
        item.agentName === sourceAgent &&
        item.sessionId === resolution.sessionId &&
        item.reqId === String(resolution.requestId) &&
        item.type === (resolution.requestMethod === "elicitation/create" ? "elicitation" : "permission");

      let changed = state.pendingPermissions.some(pendingMatches) || state.inboxItems.some(inboxMatches);
      const sessions = { ...state.sessions };
      const session = sessions[resolution.sessionId];
      if (session && (!session.agentName || session.agentName === sourceAgent)) {
        const items = session.items.map((item) => {
          if (!itemMatchesResolution(item, resolution) || item.resolved) return item;
          changed = true;
          return { ...item, resolved: true, chosen: "Answered on another device" };
        });
        sessions[resolution.sessionId] = { ...session, items };
      }
      if (!changed) return state;
      return {
        sessions,
        pendingPermissions: state.pendingPermissions.filter((item) => !pendingMatches(item)),
        inboxItems: state.inboxItems.filter((item) => !inboxMatches(item)),
        promptStateRevision: state.promptStateRevision + 1,
      };
    });
  }

  // Re-attach still-pending permission prompts to a freshly (re)built thread.
  // joinSession/resync replace s.items wholesale, which would drop a prompt that
  // arrived around the load. pendingPermissions is the durable source (the gateway
  // re-delivers outstanding prompts after session/load), so surface any that the
  // rebuilt thread is missing. Skipped only when an UNRESOLVED item with that reqId
  // is already there — a resolved item is a stale record from an earlier round (the
  // agent reuses request ids, see bridge.ts), so it must not suppress a new prompt.
  function appendPendingPermissions(s: Session, pending: PendingPermission[]): Session {
    let cur = s;
    for (const p of pending) {
      if (p.sessionId !== cur.id) continue;
      if (cur.items.some((it) => isPromptItem(it) && !it.resolved && sameReq(it.reqId, p.reqId))) continue;
      const seq = cur.seq + 1;
      const item: ThreadItem = p.elicitation
        ? {
            id: cur.id + ":" + seq, kind: "elicitation", reqId: p.reqId,
            message: p.elicitation.message, fields: p.elicitation.fields, resolved: false,
          }
        : {
            id: cur.id + ":" + seq, kind: "permission", reqId: p.reqId,
            title: p.title, options: p.options, resolved: false,
          };
      cur = { ...cur, seq, hasContent: true, items: [...cur.items, item] };
    }
    return cur;
  }

  // Mirror an SSE-delivered permission into inboxItems so the badge (which reads
  // inboxItems) shows it instantly, instead of waiting up to 5s for the next
  // /inbox poll. The poll stays authoritative: it overwrites inboxItems with
  // server truth (which already holds this prompt — the gateway records it before
  // broadcasting), reconciling anything answered elsewhere. Deduped by
  // (agentName, reqId) so a re-delivery or a poll never doubles it. id 0 is a
  // placeholder until the poll supplies the real surrogate id.
  function upsertInboxItem(items: InboxItem[], agentName: string, sessionId: string, reqId: number | string, title: string, options: PermissionOption[], type: string = "permission"): InboxItem[] {
    const rid = String(reqId);
    return [
      { id: 0, type, agentName, sessionId, reqId: rid, title, options, status: "pending", createdAt: new Date().toISOString() },
      ...items.filter((it) => !(it.agentName === agentName && it.reqId === rid)),
    ];
  }

  function msg(e: any) { return e && e.message ? e.message : JSON.stringify(e); }

  function setSessionBusy(id: string, busy: boolean) {
    set((st) => {
      const busySessionIds = { ...st.busySessionIds };
      if (busy) busySessionIds[id] = true;
      else delete busySessionIds[id];
      return { busySessionIds, busy: Object.keys(busySessionIds).length > 0 };
    });
  }

  // First user message, normalized like the server's history title derivation, so
  // a recents entry shows the same label as the Conversations list instead of
  // falling back to "Untitled" when the session carries no explicit title yet.
  function firstUserTitle(session?: Session): string | null {
    const first = session?.items.find((it) => it.kind === "user");
    const text = first?.kind === "user" ? first.text.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    return text || null;
  }

  // `title` is passed only by a rename — the one caller that knows the name the
  // user chose. Every other call has to derive one, and a derived title is a SEED:
  // it may name a conversation with nothing on record, never replace what is. This
  // runs on every frame of a running turn, so without that distinction a session
  // whose in-memory copy has no title (a deep-link join, an agent restart) reverts
  // a renamed conversation to its first user message mid-turn — on every device,
  // since the derived name is POSTed to the shared recents table too.
  function touchSessionActivity(id: string, title?: string) {
    if (!id || id.startsWith("pending-")) return;
    if (!agentCanLoadSession()) return;
    const st = get();
    const session = st.sessions[id];
    const known = session?.title && session.title !== "Untitled" ? session.title : null;
    const next = touchRecentSession({
      agentName: st.agentName,
      // The session's OWN cwd — not the global one. A background session keeps
      // receiving frames while the user views another folder; recording it under
      // the active cwd would surface a duplicate Recent entry (same title, wrong folder).
      cwd: session?.cwd || st.cwd,
      sessionId: id,
      title: title ?? known ?? firstUserTitle(session) ?? "Untitled",
      lastActiveAt: new Date().toISOString(),
    }, title === undefined);
    set({ recentSessions: next });
  }

  // Bump a session's recency. Returns a new sessions map (or the same if absent).
  function touchRecency(sessions: Record<string, Session>, id: string): Record<string, Session> {
    const s = sessions[id];
    return s ? { ...sessions, [id]: { ...s, lastActiveAt: Date.now() } } : sessions;
  }

  // Activate an in-memory, non-view-only session of the CURRENT agent: pure pointer
  // swap + cwd restore + recency bump, no network. Returns false when the target
  // isn't live here (caller falls back to a rebuild or an agent switch).
  function activateLive(id: string): boolean {
    const st = get();
    const s = st.sessions[id];
    if (!s || s.viewOnly || (s.agentName && s.agentName !== st.agentName)) return false;
    set({ activeId: id, cwd: s.cwd || st.cwd, sessions: touchRecency(st.sessions, id) });
    return true;
  }

  function agentCanLoadSession(): boolean {
    // Read from live state, not the closure: the initialize handshake may have
    // flipped sessionLoad to match what the agent actually reports.
    return get().cfg.agents.find((a) => a.name === get().agentName)?.sessionLoad !== false;
  }

  async function openSavedSession(s: { sessionId: string; title: string | null; atMessage?: number }, cwd: string) {
    const id = s.sessionId;
    if (activateLive(id)) return;   // live in memory → instant, cwd restored
    let sess = get().sessions[id] || makeSession(id, Date.now(), { agentName: get().agentName, cwd });
    if (s.title) sess = setTitle(sess, s.title);
    sess = { ...sess, viewOnly: true };
    set((st) => ({ sessions: { ...st.sessions, [id]: sess }, activeId: id, cwd, tip: "Loading conversation…" }));
    try {
      const r = await getMessages(get().agentName, cwd, id, historyPageFor(s.atMessage));
      set((st) => {
        let cur = makeSession(id, st.sessions[id].createdAt, { agentName: get().agentName, cwd });
        cur = { ...cur, title: st.sessions[id].title, viewOnly: true, historyStart: r.start };
        cur = applyHistoryMessages(cur, r.messages);
        const seq = cur.seq + 1;
        cur = { ...cur, seq, curAssistantId: null, curThoughtId: null,
          items: [...cur.items, {
            id: cur.id + ":" + seq,
            kind: "note",
            // The engine readout is blank until the reply resumes this session (the
            // store's model/effort belong to whichever session is live), so the
            // note carries what it last ran on instead. Only on the resume path:
            // replying to an agent that can't load forks a FRESH session, which
            // will not come back on these values.
            text: agentCanLoadSession()
              ? ["· saved conversation", lastRanOn(r.controls), "reply to resume the agent"].filter(Boolean).join(" — ")
              : "· saved conversation — reply to start a new session",
          }] };
        // Re-attach any still-outstanding permission prompt for this session — the
        // history API never carries an unanswered prompt, so without this a prompt
        // that arrived while we were elsewhere stays hidden until a page refresh.
        cur = appendPendingPermissions(cur, st.pendingPermissions);
        return { sessions: trimSessions({ ...st.sessions, [id]: cur }, id), tip: "" };
      });
    } catch (e) { set({ tip: "Couldn't load conversation: " + msg(e) }); }
  }

  // The gateway sends _gateway/reload when our resume cursor fell below the ledger's
  // retained window — it trimmed frames we never received, so the seq-replay can't
  // fill the gap. Rebuild the session the user is looking at via session/load; for
  // agents that can't load, flag that some history may be missing.
  function onGatewayReload() {
    const id = get().activeId;
    const s = id ? get().sessions[id] : undefined;
    // Drop the current agent's OTHER live sessions: their in-memory tail may be
    // inconsistent after a trim, so let them rebuild from history when next opened.
    set((st) => {
      const sessions: Record<string, Session> = {};
      for (const [sid, sess] of Object.entries(st.sessions)) {
        if (sid === id || sess.agentName !== st.agentName) sessions[sid] = sess;
      }
      // A floating window whose session just went away has nothing to render, and
      // a stale one would be worse: close it rather than leave a dead card up.
      return { sessions, sideWindows: st.sideWindows.filter((w) => sessions[w.sessionId]) };
    });
    if (!s || s.viewOnly) return;
    if (agentCanLoadSession()) void resync(id!);
    else set({ tip: "Reconnected — some earlier messages may be missing." });
  }

  // The gateway broadcasts _gateway/agent_restart every time the underlying agent
  // process dies and is about to be (or has just been) respawned — the new
  // process is fresh and uninitialized. Instead of trying to preserve the in-
  // memory session state across an agent restart (the session/load path is fragile
  // because the old sessionId may not be recognized by the new process), we mimic
  // a page refresh: clear sessions/activeId, close the socket, and reconnect.
  // handleStatus("connected") will run the same path as a fresh page load —
  // it picks up the last session from lastSessionByAgent, fetches its messages
  // from the server history API, and restores the conversation. This is simpler
  // and more reliable than stashing pendingResyncId + resync().
  function onAgentRestart() {
    if (get().locked) return; // screen lock owns the connection
    clearReconnectTimer();
    acp?.close();
    set({
      agentReady: false, tip: "Reconnecting…",
      sessions: {}, activeId: null, sideWindows: [],
      // rateLimits is deliberately untouched: it's polled per provider,
      // independent of this connection, and a restart shouldn't blank it.
      promptCapabilities: {}, pendingPermissions: [],
      busy: false, busySessionIds: {},
      // Every session on this connection is gone, so anything queued against one
      // has nowhere left to drain. It is dropped with them (see queuedPrompts'
      // per-tab note) rather than left keyed to an id that never comes back.
      queuedPrompts: {}, shellStash: {},
      promptStateRevision: get().promptStateRevision + 1,
    });
    // An agent restart is an involuntary reconnect — lock first when the lock is on.
    reconnectOrLock(openConnection);
  }

  function handleNotification(m: RpcMessage, sourceAgent: string) {
    if (m.method === "_gateway/reload") return onGatewayReload();
    if (m.method === "_gateway/agent_restart") return onAgentRestart();
    if (m.method === "_gateway/prompt_resolved") {
      const params = m.params as Partial<PromptResolution> | undefined;
      if (
        typeof params?.sessionId === "string" &&
        (typeof params.requestId === "string" || typeof params.requestId === "number") &&
        (params.requestMethod === "session/request_permission" || params.requestMethod === "elicitation/create")
      ) {
        applyRemotePromptResolution(sourceAgent, params as PromptResolution);
      }
      return;
    }
    if (m.method !== "session/update") return;
    const p = m.params as { sessionId?: string; update?: any } | undefined;
    if (!p?.update) return;
    // Rate limits ride on a usage_update but describe the account, not the
    // session — merge them before the sid check (which drops frames for
    // conversations this client isn't holding) and fall through so the same
    // update's used/size still reaches the session reducer. One event carries
    // one window, so this accumulates rather than replaces.
    const rl = p.update._meta?.["_claude/rateLimit"] as RateLimit | undefined;
    if (p.update.sessionUpdate === "usage_update" && rl?.rateLimitType) {
      // This _meta key only ever rides on a Claude usage_update — hardcoded
      // rather than derived from the active agent, so it lands correctly even
      // if a background Codex poll is what's currently being displayed.
      //
      // Only the fields the event actually carries win. An event can name a
      // window and say nothing about it — the one real event captured on this
      // gateway carried no `utilization` at all (usage-limits.ts) — and
      // replacing the entry outright would erase what the /usage/limits poll
      // had already filled in. The strip skips a window whose utilization
      // isn't a number, so that reads on screen as the 5h segment vanishing
      // mid-conversation while the others stay, until the next poll.
      const carried = Object.fromEntries(Object.entries(rl).filter(([, v]) => v != null));
      const merged = { ...get().rateLimits.claude?.[rl.rateLimitType], ...carried };
      set({ rateLimits: { ...get().rateLimits, claude: { ...get().rateLimits.claude, [rl.rateLimitType]: merged } } });
    }
    const st = get();
    const remotePrompt = p.update.sessionUpdate === "user_message_chunk";
    // Frames that carry a sessionId must never fall back to activeId. The gateway
    // fans out notifications, so late updates from a folder/session we just left
    // can otherwise be appended to the newly active conversation.
    const sid = p.sessionId ? (st.sessions[p.sessionId] ? p.sessionId : "") : (st.activeId || "");
    if (!st.sessions[sid]) return;
    // The engine lists belong to the session the frame names, like every other
    // update here — they used to be assigned before this resolution, straight to a
    // store-global, so whichever session the gateway last re-applied controls for
    // relabelled the conversation on screen. The gateway does that after any
    // client's session/load, session/new or session/fork and broadcasts it to
    // every client (gateway.ts's broadcastConfigOptions), so another device
    // opening a conversation was enough to move this one's model readout.
    if (p.update.sessionUpdate === "available_commands_update") {
      const commands = p.update.availableCommands || [];
      patch(sid, (s) => ({ ...s, engine: { ...s.engine, commands } }));
      return;
    }
    if (p.update.sessionUpdate === "config_option_update") {
      const configOptions = p.update.configOptions;
      if (configOptions) patch(sid, (s) => ({ ...s, engine: { ...s.engine, configOptions } }));
      return;
    }
    // A user_message_chunk on a live session is a prompt the gateway mirrored from
    // another device: applyUpdate renders its bubble and breaks the previous turn;
    // also show the working/typing state until the agent's first chunk clears it.
    let changed = false;
    patch(sid, (s) => {
      const ns = applyUpdate(s, p.update);
      changed = ns !== s;
      return remotePrompt && ns !== s ? { ...ns, working: true } : ns;
    });
    if (changed) touchSessionActivity(sid);
  }

  // A reqId is the agent's own request id, so it is unique only WITHIN an agent's
  // connection — two agents can issue the same number. acp is the active agent's
  // channel, so scope the match to the active agent: clearing a colliding reqId on
  // a retained foreign-agent session would wrongly resolve its still-pending prompt.
  function findActivePrompt(reqId: number | string): PendingPermission | undefined {
    const agent = get().agentName;
    return get().pendingPermissions.find((it) => it.agentName === agent && sameReq(it.reqId, reqId));
  }

  // Shared resolution path for both blocking prompt kinds (permission cards and
  // elicitation forms): send `result` as the JSON-RPC reply on the active agent's
  // channel, then mark every local copy answered — the in-thread item, the durable
  // pendingPermissions entry, and the optimistic inbox mirror.
  function resolvePrompt(reqId: number | string, result: unknown, chosen: string, pending: PendingPermission | undefined) {
    const agent = get().agentName;
    acp.respond(reqId, result);
    set((st) => {
      const sessions: Record<string, Session> = {};
      let changed = false;
      for (const [sid, sess] of Object.entries(st.sessions)) {
        const next = sess.agentName && sess.agentName !== agent ? sess : markPromptResolved(sess, reqId, chosen);
        sessions[sid] = next;
        changed ||= next !== sess;
      }
      const pendingPermissions = st.pendingPermissions.filter((it) => !(it.agentName === agent && sameReq(it.reqId, reqId)));
      const inboxItems = st.inboxItems.filter((it) => !(it.agentName === agent && it.reqId === String(reqId)));
      changed ||= pendingPermissions.length !== st.pendingPermissions.length || inboxItems.length !== st.inboxItems.length;
      if (!changed) return st;
      return {
        pendingPermissions,
        inboxItems,
        sessions,
        promptStateRevision: st.promptStateRevision + 1,
      };
    });
    if (pending?.sessionId) touchSessionActivity(pending.sessionId);
  }

  function handleRequest(m: RpcMessage) {
    if (m.method === "session/request_permission") return handlePermissionRequest(m);
    if (m.method === "elicitation/create") return handleElicitationRequest(m);
    acp.respondErr(m.id!, -32601, "not supported by this client");
  }

  function handlePermissionRequest(m: RpcMessage) {
    const p = m.params as { sessionId?: string; toolCall?: { title?: string }; options?: PermissionOption[] };
    const st = get();
    const sid = p.sessionId ? (st.sessions[p.sessionId] ? p.sessionId : "") : (st.activeId || "");
    const opts = p.options || [];
    if (!st.sessions[sid]) {
      // The prompt is for a session this client hasn't loaded — a background task,
      // or one cleared by a folder/agent switch. Do NOT reply with an error: the
      // gateway's permission gate is first-reply-wins, so an error here would "eat"
      // the prompt for every other viewer/device too. Instead record it (keyed by
      // its real session id) so opening that session later — or a reload's
      // re-delivery — surfaces it, and let a client that has the session answer.
      if (p.sessionId && m.id != null) {
        const title = p.toolCall?.title || "Run a tool";
        const pending = { reqId: m.id!, sessionId: p.sessionId!, agentName: st.agentName, title, options: opts, createdAt: Date.now() };
        set((cur) => {
          const changed = !hasPendingPrompt(cur.pendingPermissions, pending);
          return {
            pendingPermissions: [
            // Dedupe a re-delivery of THIS agent's reqId only — another agent's
            // connection can reuse the same number for an unrelated prompt.
            ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
            pending,
          ],
            inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, p.sessionId!, m.id!, title, opts),
            promptStateRevision: cur.promptStateRevision + (changed ? 1 : 0),
          };
        });
      }
      return;
    }
    if (st.autoApprove) {
      const allow = opts.filter((o) => /allow/.test(o.kind || ""));
      allow.sort((a) => (/once/.test(a.kind || "") ? -1 : 1));
      if (allow.length) { acp.respond(m.id!, { outcome: { outcome: "selected", optionId: allow[0].optionId } }); return; }
    }
    const title = p.toolCall?.title || "Run a tool";
    patch(sid, (s) => {
      // The gateway re-delivers an outstanding prompt after session/load, so the
      // same reqId can arrive twice — don't render a duplicate. Only an UNRESOLVED
      // item counts as a duplicate, though: the agent reuses request ids (see
      // gateway.ts), so a resolved item from an earlier round must not swallow a new
      // prompt that reuses its reqId.
      if (s.items.some((it) => it.kind === "permission" && !it.resolved && sameReq(it.reqId, m.id!))) return s;
      const seq = s.seq + 1;
      const item: ThreadItem = {
        id: s.id + ":" + seq, kind: "permission", reqId: m.id!,
        title, options: opts, resolved: false,
      };
      return { ...s, seq, hasContent: true, working: false, curAssistantId: null, curThoughtId: null, items: [...s.items, item] };
    });
    touchSessionActivity(sid);
    const pending = { reqId: m.id!, sessionId: sid, agentName: st.agentName, title, options: opts, createdAt: Date.now() };
    set((cur) => {
      const changed = !hasPendingPrompt(cur.pendingPermissions, pending);
      return {
        pendingPermissions: [
        // Dedupe a re-delivery of THIS agent's reqId only — another agent's
        // connection can reuse the same number for an unrelated prompt.
        ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
        pending,
      ],
        inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, sid, m.id!, title, opts),
        promptStateRevision: cur.promptStateRevision + (changed ? 1 : 0),
      };
    });
  }

  // The Claude agent's AskUserQuestion tool (and MCP form elicitations) arrive as
  // `elicitation/create` requests: the agent's question(s), each with options
  // and/or a free-text field, blocking the turn until answered. Same routing and
  // durability rules as permissions — record for unloaded sessions instead of
  // error-replying (the gateway gate is first-reply-wins, an error would eat the
  // prompt for every viewer), keep a pendingPermissions entry (with the form
  // payload) so reloads/resyncs re-surface an unanswered question.
  function handleElicitationRequest(m: RpcMessage) {
    const p = m.params as { sessionId?: string; mode?: string; message?: string; requestedSchema?: unknown };
    // Only form mode is advertised (initialize's clientCapabilities.elicitation).
    // Anything else is unanswerable everywhere — no viewer can render it — so an
    // error reply is honest, not prompt-eating.
    if (p.mode && p.mode !== "form") {
      acp.respondErr(m.id!, -32601, "unsupported elicitation mode");
      return;
    }
    const st = get();
    const sid = p.sessionId ? (st.sessions[p.sessionId] ? p.sessionId : "") : (st.activeId || "");
    const message = p.message || "The agent has a question";
    const elicitation = { message, fields: parseElicitationFields(p.requestedSchema) };
    const pendingEntry = (sessionId: string): PendingPermission => ({
      reqId: m.id!, sessionId, agentName: st.agentName, title: message, options: [], createdAt: Date.now(), elicitation,
    });
    if (!st.sessions[sid]) {
      if (p.sessionId && m.id != null) {
        const pending = pendingEntry(p.sessionId!);
        set((cur) => {
          const changed = !hasPendingPrompt(cur.pendingPermissions, pending);
          return {
            pendingPermissions: [
            ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
            pending,
          ],
            inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, p.sessionId!, m.id!, message, [], "elicitation"),
            promptStateRevision: cur.promptStateRevision + (changed ? 1 : 0),
          };
        });
      }
      return;
    }
    // Questions are never auto-approved: unlike a tool permission, there is no
    // "safe default" — the agent is asking because only the user can decide.
    patch(sid, (s) => {
      if (s.items.some((it) => isPromptItem(it) && !it.resolved && sameReq(it.reqId, m.id!))) return s;
      const seq = s.seq + 1;
      const item: ThreadItem = {
        id: s.id + ":" + seq, kind: "elicitation", reqId: m.id!,
        message, fields: elicitation.fields, resolved: false,
      };
      return { ...s, seq, hasContent: true, working: false, curAssistantId: null, curThoughtId: null, items: [...s.items, item] };
    });
    touchSessionActivity(sid);
    const pending = pendingEntry(sid);
    set((cur) => {
      const changed = !hasPendingPrompt(cur.pendingPermissions, pending);
      return {
        pendingPermissions: [
        ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
        pending,
      ],
        inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, sid, m.id!, message, [], "elicitation"),
        promptStateRevision: cur.promptStateRevision + (changed ? 1 : 0),
      };
    });
  }

  // The turn itself, for a session that is already live: build the prompt blocks,
  // send it, and own the bookkeeping that has to happen however it ends. Shared by
  // sendPrompt (which resolves *which* session first — starting, resuming or
  // remapping one) and sendPromptTo (which is handed a live one). The caller has
  // already added the user bubble and marked the session busy; this releases both.
  async function runPrompt(sid: string, text: string, imgs: MessageImage[], refs: MessageFile[]): Promise<void> {
    // Read in the finally below: a turn the user cancelled must not release the
    // queue. Every cancel surface (the composer's stop, a running-row menu, a
    // deep-linked one) lands here as stopReason "cancelled", so gating on it once
    // is what keeps them all honest — a per-caller guard is what drifts.
    let stopReason: string | undefined;
    try {
      // Anything "!" ran since this session's last turn rides ahead of the
      // message as its own text block. Spent BEFORE the send, not after: a turn
      // that errors must not replay the same transcript on the retry.
      const shell = get().shellStash[sid];
      if (shell) set((cur) => { const shellStash = { ...cur.shellStash }; delete shellStash[sid]; return { shellStash }; });
      // text block first (when non-empty), then one image block per attachment,
      // then a block per file reference.
      const prompt: Array<Record<string, unknown>> = [];
      if (shell) prompt.push({ type: "text", text: shell });
      if (text.trim()) prompt.push({ type: "text", text });
      for (const im of imgs) {
        prompt.push(im.data
          ? { type: "image", mimeType: im.mimeType, data: im.data }
          : { type: "image", mimeType: im.mimeType, uri: im.uri });
      }
      // A whole file is a resource_link — the agent reads it itself, and
      // sending a large file inline would spend the context on a file it may
      // only need one function out of. A line range is the opposite case:
      // the lines ARE the point, so they ride along as an embedded resource.
      // Both adapters turn that into a link plus a <context ref="…"> block
      // (claude-agent-acp promptToClaude, codex-acp buildPromptItems), which
      // is how the selection reaches the model without a second read.
      for (const f of refs) {
        prompt.push(f.text !== undefined
          ? { type: "resource", resource: { uri: f.uri, mimeType: "text/plain", text: f.text } }
          : { type: "resource_link", uri: f.uri, name: f.name });
      }
      const res = (await acp.request("session/prompt", { sessionId: sid, prompt })) as { stopReason?: string };
      stopReason = res?.stopReason;
      patch(sid, (s) => ({ ...s, curAssistantId: null, curThoughtId: null }));
      if (res?.stopReason && res.stopReason !== "end_turn") {
        patch(sid, (s) => ({ ...s, seq: s.seq + 1, items: [...s.items, { id: s.id + ":" + (s.seq + 1), kind: "note", text: "· " + res.stopReason }] }));
      }
    } catch (e: any) {
      if (!e?.__disconnected) patch(sid, (s) => ({ ...s, seq: s.seq + 1, items: [...s.items, { id: s.id + ":" + (s.seq + 1), kind: "note", variant: "error", text: "Error: " + msg(e) }] }));
    } finally {
      setSessionBusy(sid, false);
      patch(sid, (s) => ({ ...s, working: false }));
      // A refusal or a token ceiling is still the turn finishing on its own, so
      // those drain. A cancel is the user saying "not this" — the queue stays
      // parked on the rail, where they can send, edit or drop it themselves.
      // Unless the cancel WAS the send: an interrupt cuts the turn precisely so the
      // message at the head can go out now. delete-as-read, so the exemption is
      // spent on this settle and never leaks into the next stop.
      const interrupted = interrupting.delete(sid);
      if (stopReason !== "cancelled" || interrupted) drainQueue(sid);
    }
  }

  // One queued message per turn end. The next one rides this same path, so its own
  // finally drains the one after it — the chain, not a loop here, is what turns N
  // queued messages into N consecutive turns.
  //
  // The message comes OUT of the queue before the send, not after: sendPromptTo's
  // own finally calls back into here, and an item still at the head then would be
  // sent forever. It goes back to the head if the send was refused (a session gone
  // view-only, an agent no longer ready) — that refusal is synchronous, so nothing
  // can drain in between and reorder the queue.
  // Sessions whose running turn was cancelled BY an interrupt (see interruptWith).
  // The flag lives for exactly one turn settle: it is what tells that "cancelled"
  // apart from a plain stop, which parks the queue instead of releasing it.
  const interrupting = new Set<string>();

  // A queued item from what the composer handed over, with the same capability
  // filter a send applies — parking a block this agent will reject only moves the
  // failure a turn later. Null when there is nothing to send.
  function makeQueued(prompt: { text: string; images?: MessageImage[]; files?: MessageFile[] }): QueuedPrompt | null {
    const imgs = get().promptCapabilities.image ? (prompt.images || []) : [];
    const refs = get().promptCapabilities.embeddedContext ? (prompt.files || []) : [];
    if (!prompt.text.trim() && !imgs.length && !refs.length) return null;
    return {
      id: QUEUE_ID(), text: prompt.text,
      ...(imgs.length ? { images: imgs } : {}),
      ...(refs.length ? { files: refs } : {}),
    };
  }

  function drainQueue(sid: string) {
    const next = get().queuedPrompts[sid]?.[0];
    if (!next) return;
    get().unqueuePrompt(sid, next.id);
    void get().sendPromptTo(sid, next.text, next.images, next.files).then((sent) => {
      if (sent) return;
      set((st) => ({ queuedPrompts: { ...st.queuedPrompts, [sid]: [next, ...(st.queuedPrompts[sid] ?? [])] } }));
    });
  }

  function initSession(): Promise<unknown> {
    if (!sessionInit) {
      // A rejection must not stay cached: session/new can now fail fast (the frame
      // never reached the gateway), and a poisoned sessionInit would re-throw that
      // same stale error for every later prompt in this folder.
      const p = acp.request("session/new", { cwd: get().cwd || "", mcpServers: [] });
      sessionInit = p;
      p.catch(() => { if (sessionInit === p) sessionInit = null; });
    }
    return sessionInit;
  }

  function adopt(res: NewSessionResult) {
    const baseSession = makeSession(res.sessionId, Date.now(), { agentName: get().agentName, cwd: get().cwd });
    const session = applyModelsModes(baseSession, res);
    set((st) => ({
      sessions: trimSessions({ ...st.sessions, [res.sessionId]: session }, res.sessionId),
      activeId: res.sessionId,
    }));
  }

  async function resync(id: string) {
    if (!get().sessions[id]) return;
    set((st) => ({ sessions: { ...st.sessions, [id]: {
      ...makeSession(id, st.sessions[id].createdAt, { agentName: st.sessions[id].agentName, cwd: st.sessions[id].cwd }),
      title: st.sessions[id].title,
    } } }));
    try {
      const cwd = get().sessions[id]?.cwd || get().cwd || "";
      await acp.request("session/load", { sessionId: id, cwd, mcpServers: [] });
      // Re-attach any still-outstanding permission prompt for this session. resync
      // (gateway reload / busy-session reconnect) replaces s.items wholesale via the
      // load-replay, which drops the prompt item; the gateway usually re-delivers it,
      // but that can race or not land — and since this is the ACTIVE session, the
      // PendingPermissions badge (non-active only) wouldn't surface it either, so the
      // prompt would silently disappear. pendingPermissions is the durable source, so
      // restore from it here (skips one the replay already re-delivered).
      set((st) => (st.sessions[id]
        ? { sessions: { ...st.sessions, [id]: appendPendingPermissions(st.sessions[id], st.pendingPermissions) }, tip: "" }
        : { tip: "" }));
    }
    catch (e) { set({ tip: "Couldn't sync conversation: " + msg(e) }); }
  }

  // Deep-link join: agents with session/load support open an EXISTING session id
  // as a live viewer. Agents without session/load (Codex ACP today) fall back to
  // the history API as a saved, view-only conversation; replying forks a new
  // session because the old id cannot be resumed over ACP.
  async function joinSession(id: string, atMessage?: number) {
    if (!agentCanLoadSession()) {
      set({ joining: false });
      await openSavedSession({ sessionId: id, title: null, atMessage }, get().cwd);
      return;
    }
    // the Thread shows a "Joining conversation…" loading view (s.joining), so no tip needed
    set((st) => ({ sessions: { ...st.sessions, [id]: makeSession(id, Date.now(), { agentName: get().agentName, cwd: get().cwd }) }, activeId: id, tip: "" }));
    try {
      patch(id, (s) => ({ ...s, suppressReplay: true })); // drop the agent's load-replay; render from the history API instead
      const lr = (await acp.request("session/load", { sessionId: id, cwd: get().cwd || "", mcpServers: [] })) as NewSessionResult;
      const r = await getMessages(get().agentName, get().cwd, id, historyPageFor(atMessage));
      set((st) => {
        const base = makeSession(id, st.sessions[id]?.createdAt ?? Date.now(), { agentName: get().agentName, cwd: get().cwd });
        const cur = applyHistoryMessages({ ...base, historyStart: r.start }, r.messages);
        const ready = appendPendingPermissions(
          { ...applyModelsModes(cur, lr), suppressReplay: false, viewOnly: false }, st.pendingPermissions);
        return { sessions: trimSessions({ ...st.sessions, [id]: ready }, id), tip: "", joining: false };
      });
    } catch {
      set({ tip: "", joining: false });
      set((st) => { const sessions = { ...st.sessions }; delete sessions[id]; return { sessions, activeId: null }; });
      initSession().then((res: any) => { if (res?.sessionId && !get().activeId) adopt(res); }).catch(() => {});
    }
  }

  // Open (or re-open, when switching agents) the SSE+POST connection to the current
  // agent. Each agent is a separate gateway channel, so a switch is a clean reconnect:
  // fresh Acp, same handlers. openConnection binds a per-agent resume cursor from the
  // `agentCursors` map, so the resume position survives Acp recreation and each agent
  // catches up from where it was left.
  function openConnection() {
    const agent = get().agentName;
    acp = new Acp("sse", sseFactory({
      sseUrl: (last) => sseUrl(cfg, agent, last),
      rpcUrl: (conn) => rpcUrl(cfg, agent, conn),
    }, {
      get: () => agentCursors.get(agent) ?? -1,
      set: (n) => agentCursors.set(agent, n),
    }));
    acp.onNotification((message) => handleNotification(message, agent));
    acp.onRequest(handleRequest);
    acp.onStatus(handleStatus);
    acp.connect();
  }

  // Reconnect to `agentName` and open `sessionId` through the shared deep-link
  // join flow (the same path shared links use): write ?agent=&session=&cwd= to the
  // URL, tear down the current channel, and let handleStatus pick up link.session
  // once the target agent is ready. Used to open a sidebar conversation that lives
  // under a different agent (and by jumpToTask for cross-agent/-folder tasks).
  function openViaDeepLink(agentName: string, sessionId: string, cwd: string | undefined, tip: string, atMessage?: number) {
    const params = new URLSearchParams();
    params.set("agent", agentName);
    params.set("session", sessionId);
    if (cwd) params.set("cwd", cwd);
    // A search hit's message index survives the reconnect; without it a cross-agent
    // hit would silently open at the tail. `undefined`, not falsiness — index 0 is real.
    if (atMessage !== undefined) params.set("at", String(atMessage));
    history.replaceState(null, "", location.pathname + "?" + params.toString());
    acp?.close();
    clearReconnectTimer();
    sessionInit = null;
    pendingResyncId = null;
    set({
      agentName, cwd: cwd || get().cwd,
      conn: "connecting", agentReady: false, tip,
      // rateLimits carries over: it's keyed by provider and polled independent
      // of which agent is active, so a different provider's quota is still valid.
      sessions: {}, activeId: null,
      promptCapabilities: {}, pendingPermissions: [], busy: false, busySessionIds: {}, queuedPrompts: {}, shellStash: {}, joining: true,
      promptStateRevision: get().promptStateRevision + 1,
    });
    openConnection();
  }

  // An involuntary (re)connect — a dropped socket, a foreground resume onto a dead
  // socket, or an agent restart. When the screen lock is on, every such reconnect
  // must re-prove the PIN first: engage the lock instead of silently
  // reopening (unlock() reopens). When the lock is off, run the supplied reconnect.
  function reconnectOrLock(reconnect: () => void) {
    if (get().lockEnabled) { if (!get().locked) get().lock(); return; }
    reconnect();
  }

  function handleStatus(s: ConnState, code?: number) {
    set({ conn: s });
    if (s === "connected") {
      clearReconnectTimer();
      (async () => {
        try {
          const init = (await acp.request("initialize", {
            protocolVersion: 1,
            // elicitation.form re-enables the Claude adapter's AskUserQuestion tool
            // (questions with options), which it presents via `elicitation/create`;
            // without this capability the adapter disables the tool entirely.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
          })) as {
            agentCapabilities?: {
              promptCapabilities?: PromptCapabilities;
              loadSession?: boolean;
              // Present (as an empty object) when the agent implements
              // `session/fork`; absent when it doesn't. claude-agent-acp does,
              // codex-acp bundles the schema but has no handler.
              sessionCapabilities?: { fork?: unknown };
            };
          } | undefined;
          // The agent's capabilities flow through the gateway unchanged. Gate image
          // input on promptCapabilities; and trust the agent's own loadSession over
          // the gateway's conservative name-based guess — codex-acp now reports
          // loadSession:true, so resuming it threads the conversation (like Zed)
          // instead of forking a fresh session on every reply.
          const loadSession = init?.agentCapabilities?.loadSession;
          // Only the agent can say whether it forks — there is no name-based
          // guess to fall back on, so absence means "no branching" and the
          // affordance simply doesn't appear.
          const sessionFork = !!init?.agentCapabilities?.sessionCapabilities?.fork;
          set((st) => ({
            agentReady: true, tip: "",
            promptCapabilities: init?.agentCapabilities?.promptCapabilities ?? {},
            cfg: {
              ...st.cfg,
              agents: st.cfg.agents.map((a) => (a.name === st.agentName
                ? { ...a, sessionFork, ...(typeof loadSession === "boolean" ? { sessionLoad: loadSession } : {}) }
                : a)),
            },
          }));
          const link = linkParams();
          if (pendingResyncId) {
            const rid = pendingResyncId; pendingResyncId = null;
            set({ tip: "Reconnected — syncing conversation…" });
            await resync(rid);
          } else if (link.session && get().activeId !== link.session) {
            // deep-link: join the shared session instead of creating our own
            if (link.cwd && get().cwd !== link.cwd) set({ cwd: link.cwd });
            await joinSession(link.session, link.at ?? undefined);
          } else {
            // Pick an activation target. An explicit selectSession request always wins.
            // Otherwise restore the conversation we left under this agent ONLY when no
            // live session of THIS agent is already active — so a transient reconnect
            // (network blip) never pulls the user off their current conversation; a
            // genuine agent switch keeps a foreign-agent session as activeId, so
            // haveLiveActive is false there and the fallback correctly applies.
            const haveLiveActive = !!get().activeId
              && get().sessions[get().activeId!]?.agentName === get().agentName;
            const targetId = pendingActivateId
              ?? (haveLiveActive ? null : (lastSessionByAgent.get(get().agentName)?.id ?? null));
            pendingActivateId = null;
            if (targetId && activateLive(targetId)) {
              // live in memory → the cursor replay (since agentCursors[agent])
              // catches it up, and its engine lists came back with the session
              // (they are the session's own now, not a store-global this switch
              // cleared — which is what restoreEngineLists used to put back).
            } else if (targetId) {
              const last = lastSessionByAgent.get(get().agentName);
              const recentTitle = get().recentSessions.find((r) => r.sessionId === targetId)?.title;
              const title = recentTitle && recentTitle !== "Untitled" ? recentTitle : null;
              await openSavedSession({ sessionId: targetId, title }, last?.cwd ?? get().cwd);
            } else if (!haveLiveActive) {
              // No live session belonging to THIS agent is active (the kept
              // activeId may be a foreign-agent session) → start fresh. Adopt the
              // new session unless a current-agent session became active meanwhile.
              initSession()
                .then((res: any) => {
                  if (!res?.sessionId) return;
                  const cur = get().sessions[get().activeId!];
                  if (!cur || cur.agentName !== get().agentName) adopt(res);
                })
                .catch((e) => set({ tip: "Couldn't start session: " + msg(e) }));
            }
          }
        } catch (e) { set({ tip: "Agent init failed: " + msg(e) }); }
      })();
    } else if (s === "offline") {
      set({ agentReady: false });
      const st = get();
      const activeBusyId = st.activeId && st.busySessionIds[st.activeId] ? st.activeId : Object.keys(st.busySessionIds)[0];
      if (activeBusyId) pendingResyncId = activeBusyId;
      if (code === 4000) { set({ tip: "Disconnected — this agent is open in another tab/client." }); return; }
      if (code === 1000) return; // clean close (our own teardown / normal server close) — no reconnect, no lock
      // Involuntary drop. With the lock on this engages the lock (require the
      // password before reconnecting); otherwise it schedules the usual backoff.
      reconnectOrLock(() => {
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => { reconnectTimer = null; acp.connect(); }, 1500);
        set({ tip: "Disconnected (" + code + "). Reconnecting…" });
      });
    }
  }

  return {
    cfg,
    agentName: initialAgent?.name ?? cfg.defaultAgent,
    cwd: initialAgent?.cwd || cfg.fsRoot || "",
    conn: "connecting", agentReady: false, tip: "Connecting to the local agent…",
    sessions: {}, activeId: null, sideWindows: [],
    rateLimits: {}, quotaUnlimited: {}, quotaUnavailable: {},
    promptCapabilities: {},
    pendingPermissions: [],
    promptStateRevision: 0,
    autoApprove: false, textSize: initialTextSize, busy: false, busySessionIds: {}, queuedPrompts: {}, shellStash: {},
    joining: !!linkParams().session, // deep-link present → show "Joining…" from first paint
    historyNonce: 0,
    recentSessions: readRecentSessions(),
    hiddenFolders: [],
    pinnedSessions: [],
    archivedSessions: [],
    historyTitles: {},
    runningTasks: [],
    runningSeen: {},
    inboxItems: [],
    // The live locked state is local to this browser tab. On startup bootstrap()
    // hydrates the persisted setting before opening the agent connection; if the
    // lock is enabled it engages the local lock first and waits for unlock().
    locked: false,
    lockEnabled: isLockEnabled(),
    // Open by default on a desktop-width screen (the panel renders as a
    // column there, not an overlay sheet that would cover the chat) and
    // closed on a phone-width one.
    filesOpen: isDesktopPanelWidth(),
    changeStat: null,
    // Same shape for the left column, at its own (860px) breakpoint.
    sidebarOpen: isDesktopSidebarWidth(),
    filePreview: null,
    attachedFiles: [],

    bootstrap() {
      // Pull the account's shared prefs (text size, screen-lock config, recent
      // sessions/folders) from the gateway and hydrate the in-memory caches, so a
      // reconnect from any device looks the same. Best-effort: getPrefs swallows
      // failures (older gateway / offline) and leaves the defaults in place. The
      // initial agent connection waits for this so a saved screen lock can gate a
      // full page refresh before any SSE stream is opened.
      void getPrefs().then((p) => {
        hydrateLock(p.lock);
        hydrateRecentSessions(p.recentSessions);
        hydrateRecentFolders(p.recentFolders);
        const textSize = normalizeTextSize(p.textSize);
        const lockEnabled = isLockEnabled();
        applyTextSize(textSize);
        set({
          textSize,
          recentSessions: readRecentSessions(),
          hiddenFolders: p.hiddenFolders,
          pinnedSessions: p.pinnedSessions,
          archivedSessions: p.archivedSessions,
          lockEnabled,
        });
        if (lockEnabled) {
          get().lock();
          return;
        }
        openConnection();
      });
    },

    setAgent(name) {
      if (name === get().agentName || !cfg.agents.some((a) => a.name === name)) return;
      // Silent teardown: no offline status, so no auto-reconnect to the old agent.
      acp?.close();
      clearReconnectTimer();
      sessionInit = null;
      pendingResyncId = null;
      // Remember where we were under the agent we're leaving, so switching back
      // restores that conversation instead of opening a blank new session.
      const leavingId = get().activeId;
      if (leavingId && !leavingId.startsWith("pending-") && get().sessions[leavingId]?.hasContent) {
        lastSessionByAgent.set(get().agentName, { id: leavingId, cwd: get().cwd });
      }
      // A deep-linked ?session= belongs to the previous agent — drop it so the
      // new connection starts fresh instead of trying to join it.
      if (location.search.includes("session=") || location.search.includes("cwd=")) {
        history.replaceState(null, "", location.pathname || "/");
      }
      const ref = cfg.agents.find((a) => a.name === name)!;
      set({
        // Keep the user's current working directory across the switch; only
        // fall back to the new agent's configured cwd when none is set yet.
        agentName: name, cwd: get().cwd || ref.cwd || cfg.fsRoot || "",
        conn: "connecting", agentReady: false, tip: "Switching to " + name + "…",
        // KEEP sessions + activeId. pendingPermissions is also KEPT — it is the
        // durable source for outstanding prompts, and since this switch retains
        // sessions, wiping it would drop a background session's prompt (its badge)
        // on a switch-away/back. Entries carry their agentName so the badge only
        // surfaces prompts answerable on the now-active agent.
        // rateLimits is NOT reset here: it's keyed by provider and polled
        // continuously regardless of which agent is on screen, so switching
        // away from Codex must not blank the Codex quota it already fetched.
        // The engine lists are not reset either, and nothing has to put them back
        // on the way in: they belong to the sessions this switch keeps.
        // The floating windows DO go: their sessions live on the connection being
        // torn down here, so their composers would be prompting an agent that has
        // never heard of them. Unlike the main column, nothing re-resolves them on
        // the new connection — reopen from the sidebar under the agent that owns
        // them, which is the same rule the "Open as side chat" row is gated on.
        sideWindows: [],
        promptCapabilities: {}, busy: false, busySessionIds: {}, queuedPrompts: {}, shellStash: {}, joining: false,
        promptStateRevision: get().promptStateRevision + 1,
      });
      openConnection();
    },

    setActive(id) { if (!activateLive(id)) set({ activeId: id }); },
    selectSession(id) {
      if (activateLive(id)) return;
      const s = get().sessions[id];
      if (s && !s.viewOnly && s.agentName && s.agentName !== get().agentName) {
        pendingActivateId = id;            // activation lands in handleStatus after reconnect
        get().setAgent(s.agentName);
        return;
      }
      // cold (LRU-evicted / post-reload / view-only): rebuild from history
      void get().openHistorySession({ sessionId: id, title: s?.title ?? null });
    },
    setTip(t) { set({ tip: t }); },
    // The reader is looking at the active conversation, so its finished turns are
    // read — on every device, since the unread state lives on the gateway. Called
    // whenever any of the three inputs change (which conversation is open, whether
    // this tab has the reader's attention, what the inbox holds), so it re-checks
    // rather than trusting a single moment. The local drop is optimistic: if the
    // POST fails the next poll brings the row back.
    readActiveSession() {
      const st = get();
      const id = st.activeId;
      if (!id) return;
      if (typeof document !== "undefined" && (!document.hasFocus() || document.visibilityState === "hidden")) return;
      const isRead = (it: InboxItem) => it.type === "task_done" && it.sessionId === id;
      if (!st.inboxItems.some(isRead)) return;
      set({ inboxItems: st.inboxItems.filter((it) => !isRead(it)) });
      void markInboxRead(id);
    },
    renameSession(title, target) {
      const sid = target?.sessionId ?? get().activeId;
      if (!sid || sid.startsWith("pending-")) return;
      const t = title.trim();
      patch(sid, (s) => ({ ...s, title: t || s.title }));
      // Only a real rename touches recents. touchSessionActivity rewrites ONE row
      // (this agent + this session's folder), so the same conversation cached under
      // another spelling of that folder — or under a second agent sharing the
      // provider — is renamed here too; those are the rows that would otherwise put
      // the old name back in the Recent list. CLEARING a rename deliberately does
      // neither: the title this session falls back to is the gateway's to derive,
      // and posting the name being cleared would just persist it again.
      if (t) {
        // Only the ACTIVE conversation gets an activity touch. A targeted rename
        // can name a row this client never opened, owned by another agent in
        // another folder: touchSessionActivity would record it under the active
        // agent/cwd and stamp it as just-used, reordering Recent around a
        // conversation nothing actually ran. The id-keyed cache rewrite below is
        // the whole job there — the gateway rewrites its own rows either way.
        if (!target) touchSessionActivity(sid, t);
        set({ recentSessions: renameRecentCache(sid, t) });
      }
      // persist, then nudge the sidebar to re-pull its list so the entry updates
      apiRename(
        target?.agentName ?? get().agentName,
        target?.cwd || get().sessions[sid]?.cwd || get().cwd,
        sid, t,
      )
        .then(() => set((st) => ({ historyNonce: st.historyNonce + 1 })))
        .catch(() => {});
    },
    // Unlike rename, this is NOT optimistic: the gateway can refuse (a running
    // turn), and removing the conversation from the UI first would leave the
    // sidebar disagreeing with a transcript that's still on disk.
    async deleteSession(sessionId) {
      const sid = sessionId ?? get().activeId;
      if (!sid || sid.startsWith("pending-")) return;
      const { ok, running } = await apiDelete(sid);
      if (!ok) {
        set({ tip: running ? "This conversation is still running." : "Couldn't delete this conversation." });
        return;
      }
      const recentSessions = removeRecentSession(sid);
      set((st) => {
        const sessions = { ...st.sessions };
        delete sessions[sid];
        // When the deleted conversation was the open one there's nothing to
        // activate — land on the empty state rather than picking an arbitrary
        // neighbour. Deleting any other row leaves the open thread alone.
        // historyNonce re-pulls both sidebar lists.
        return {
          sessions, activeId: st.activeId === sid ? null : st.activeId,
          // A window whose own conversation was just deleted has nothing to show.
          // Deleting the conversation it was FORKED from is not that: the fork is
          // its own conversation and outlives its parent.
          sideWindows: st.sideWindows.filter((w) => w.sessionId !== sid),
          recentSessions, historyNonce: st.historyNonce + 1, tip: "",
        };
      });
    },
    answerPermission(reqId, optionId) {
      const pending = findActivePrompt(reqId);
      const opt = pending?.options.find((it) => it.optionId === optionId);
      const chosen = opt?.name || opt?.optionId || optionId;
      resolvePrompt(reqId, { outcome: { outcome: "selected", optionId } }, chosen, pending);
    },
    answerElicitation(reqId, response, summary) {
      resolvePrompt(reqId, response, summary, findActivePrompt(reqId));
    },
    answerInboxItem(agentName, reqId, optionId) {
      // Answer a prompt for ANY agent via the gateway's server-side route — no need
      // to hold that agent's SSE connection (that's why this is separate from
      // answerPermission, which replies on the active agent's channel).
      const item = get().inboxItems.find((it) => it.agentName === agentName && it.reqId === reqId);
      const opt = item?.options.find((o) => o.optionId === optionId);
      const chosen = opt?.name || opt?.optionId || optionId;
      void answerInbox(agentName, reqId, optionId);
      // Drop the inbox item optimistically (the next /inbox poll reconciles), AND
      // clear the SSE-derived pendingPermissions + mark any in-thread copy resolved.
      // Without that last part, a prompt also held in pendingPermissions lingers and
      // appendPendingPermissions re-surfaces it as a ghost prompt when the session is
      // next opened (it only suppresses UNRESOLVED in-thread duplicates).
      const matchesPending = (it: PendingPermission) => it.agentName === agentName && sameReq(it.reqId, reqId);
      set((st) => {
        const sessions: Record<string, Session> = {};
        let changed = false;
        for (const [sid, sess] of Object.entries(st.sessions)) {
          const next = sess.agentName && sess.agentName !== agentName ? sess : markPromptResolved(sess, reqId, chosen);
          sessions[sid] = next;
          changed ||= next !== sess;
        }
        const inboxItems = st.inboxItems.filter((it) => !(it.agentName === agentName && it.reqId === reqId));
        const pendingPermissions = st.pendingPermissions.filter((it) => !matchesPending(it));
        changed ||= inboxItems.length !== st.inboxItems.length || pendingPermissions.length !== st.pendingPermissions.length;
        if (!changed) return st;
        return {
          inboxItems,
          pendingPermissions,
          sessions,
          promptStateRevision: st.promptStateRevision + 1,
        };
      });
      if (item?.sessionId) touchSessionActivity(item.sessionId);
    },
    setCwd(p) {
      sessionInit = null;
      touchRecentFolder(p);
      // Set the cwd for the next new chat; KEEP existing live sessions in the
      // background (each remembers its own cwd). The engine readout follows
      // activeId, so it empties itself here and refills from the new session.
      if (location.search.includes("session=") || location.search.includes("cwd=")) {
        history.replaceState(null, "", location.pathname || "/");
      }
      set({ cwd: p, activeId: null });
      if (get().agentReady) initSession().then((res: any) => { if (res?.sessionId) adopt(res); }).catch(() => {});
    },
    toggleHiddenFolder(path) {
      apiToggleHiddenFolder(path).then((list) => set({ hiddenFolders: list })).catch(() => {});
    },
    togglePinnedSession(agentName, sessionId) {
      apiTogglePinnedSession(agentName, sessionId).then((list) => set({ pinnedSessions: list })).catch(() => {});
    },
    toggleArchivedSession(agentName, sessionId) {
      apiToggleArchivedSession(agentName, sessionId).then((list) => set({ archivedSessions: list })).catch(() => {});
    },
    toggleAuto() { set((st) => ({ autoApprove: !st.autoApprove })); },
    setTextSize(size) {
      const next = normalizeTextSize(size);
      applyTextSize(next);
      void putTextSize(next); // shared across devices; best-effort persist
      set({ textSize: next });
    },

    async newSession() {
      // Ignore repeat clicks while a "+" round-trip is already resolving, so a
      // user who taps several times (because nothing seems to happen) doesn't
      // stack up provisional sessions.
      if (!get().agentReady || creatingSession) return;
      sessionInit = null;
      // Optimistic: switch to an empty provisional conversation NOW so the view
      // moves on the click, then resolve the real sessionId in the background and
      // swap it in (same provisional→real mechanism sendPrompt uses).
      const provId = PROVISIONAL();
      set((st) => ({
        sessions: { ...st.sessions, [provId]: makeSession(provId, Date.now(), { agentName: get().agentName, cwd: get().cwd }) },
        activeId: provId, tip: "Starting session…",
      }));
      creatingSession = true;
      try {
        const ns = (await initSession()) as NewSessionResult;
        if (!ns?.sessionId) throw new Error("no session id");
        set((st) => {
          // A prompt sent during the wait reuses this provisional and remaps it
          // itself (it marks the session busy synchronously before awaiting). If
          // it has taken ownership — or the user navigated away — leave it be.
          if (!st.sessions[provId] || st.busySessionIds[provId]) return { tip: "" };
          const remapped = remapSession(st.sessions[provId], ns.sessionId);
          const sessions = { ...st.sessions }; delete sessions[provId];
          sessions[ns.sessionId] = applyModelsModes(remapped, ns);
          return {
            sessions: trimSessions(sessions, ns.sessionId),
            activeId: st.activeId === provId ? ns.sessionId : st.activeId,
            tip: "",
          };
        });
      } catch (e: any) {
        // Roll back the throwaway provisional and surface the failure — unless a
        // prompt already adopted it (sendPrompt owns its own error handling then).
        set((st) => {
          if (!st.sessions[provId] || st.busySessionIds[provId]) return {};
          const sessions = { ...st.sessions }; delete sessions[provId];
          return { sessions, activeId: st.activeId === provId ? null : st.activeId };
        });
        if (!e?.__disconnected) set({ tip: "Couldn't start session: " + msg(e) });
      } finally {
        creatingSession = false;
      }
    },

    async openHistorySession(s) {
      // A conversation row may belong to another agent (the unified sidebar lists
      // every agent's history). Switch to its agent via the deep-link join flow;
      // otherwise open it in place under the current agent.
      const agentName = s.agentName ?? get().agentName;
      const cwd = s.cwd ?? get().cwd;
      if (agentName !== get().agentName) {
        openViaDeepLink(agentName, s.sessionId, cwd, "Opening conversation…", s.atMessage);
        return;
      }
      if (cwd !== get().cwd) { sessionInit = null; set({ cwd }); } // cold: adopt that folder, NO wipe
      await openSavedSession({ sessionId: s.sessionId, title: s.title, atMessage: s.atMessage }, cwd);
    },

    // Fetch the page immediately before what's loaded and prepend it. Absolute
    // indices mean this is safe while the agent is still appending: the range
    // below `historyStart` can never shift. The page is rendered through a
    // throwaway session whose id namespace differs from the real one, so the
    // generated `id + ":" + seq` item ids cannot collide with what's on screen.
    async loadOlderMessages(id) {
      const s = get().sessions[id];
      if (!s || s.loadingOlder || s.historyStart <= 0) return;
      const from = Math.max(0, s.historyStart - 50);
      const to = s.historyStart;
      patch(id, (cur) => ({ ...cur, loadingOlder: true }));
      try {
        const r = await getMessages(s.agentName || get().agentName, s.cwd || get().cwd, id, { from, to });
        const page = applyHistoryMessages(
          makeSession(id + "#p" + from, s.createdAt, { agentName: s.agentName, cwd: s.cwd }),
          r.messages,
        );
        patch(id, (cur) => ({
          ...cur,
          items: [...page.items, ...cur.items],
          hasContent: cur.hasContent || page.hasContent,
          historyStart: r.start,
          loadingOlder: false,
        }));
      } catch (e) {
        // Deliberately leaves historyStart alone: moving it to 0 would claim the
        // conversation's beginning was reached when the fetch simply failed.
        patch(id, (cur) => ({ ...cur, loadingOlder: false }));
        set({ tip: "Couldn't load earlier messages: " + msg(e) });
      }
    },

    async openRecentSession(s) {
      // Cross-agent recent → reconnect to the owning agent and join it (recents are
      // only recorded for session/load-capable agents, so the join resumes it live).
      if (s.agentName !== get().agentName) {
        openViaDeepLink(s.agentName, s.sessionId, s.cwd, "Opening conversation…");
        return;
      }
      if (activateLive(s.sessionId)) return;        // live in memory → instant
      if (get().cwd !== s.cwd) { sessionInit = null; set({ cwd: s.cwd }); } // cold: adopt that folder, NO wipe
      await openSavedSession({ sessionId: s.sessionId, title: s.title }, s.cwd);
    },

    jumpToTask(task) {
      const st = get();
      // Resolve folder + title via the shared resolver (gateway cwd is
      // authoritative even for tasks this device never opened; recents/live
      // session supply the title and a cwd fallback for older gateways).
      const { title, cwd } = resolveRunningTask(task, st);

      // Same agent + same folder → open in place (no reconnect).
      if (task.agentName === st.agentName && (!cwd || cwd === st.cwd)) {
        if (st.sessions[task.sessionId]) { get().setActive(task.sessionId); return; }
        void get().openHistorySession({ sessionId: task.sessionId, title });
        return;
      }

      // Cross-agent or cross-folder → reconnect and let the deep-link join flow
      // (the same one shared links use) open it once the agent is ready.
      openViaDeepLink(task.agentName, task.sessionId, cwd, "Opening task…");
    },

    mergeHistoryTitles(rows) {
      set((st) => {
        let changed = false;
        const historyTitles = { ...st.historyTitles };
        for (const r of rows) {
          // Only real names: a listing reports `null` for a conversation it can't
          // derive a title for, and storing that would blank a name we already have.
          if (!r.title) continue;
          const key = r.agentName + "\n" + r.sessionId;
          if (historyTitles[key] === r.title) continue;
          historyTitles[key] = r.title;
          changed = true;
        }
        // Same object back when nothing moved — this runs on every list fetch, and
        // a fresh map each time would re-render every subscriber for no reason.
        return changed ? { historyTitles } : st;
      });
    },

    // Called by the /usage/limits poll, once per provider it's running for.
    // Replaces rather than merges that provider's own windows: the route
    // reports every window the account has, so folding it into whatever the
    // ACP path happened to leave behind could only keep a staler copy of the
    // same window alive. Other providers' entries are untouched. Same object
    // back when nothing moved, since this runs on a timer and the strip
    // subscribes to the map.
    ingestUsageLimits(kind, windows, unlimited, unavailable) {
      const prevReason = get().quotaUnavailable[kind] ?? "";
      const nextReason = unavailable ?? "";
      // An unavailable answer carries no windows, and must not be read as "this
      // account now has none": a blip mid-session would wipe a gauge that was
      // right a minute ago. Only the reason changes; whatever was last known
      // stays on screen, and the reason speaks for itself when nothing is.
      if (unavailable) {
        if (prevReason === nextReason) return;
        set({ quotaUnavailable: { ...get().quotaUnavailable, [kind]: nextReason } });
        return;
      }
      const prevWindows = get().rateLimits[kind] ?? {};
      const sameWindows = Object.keys(windows).length === Object.keys(prevWindows).length
        && Object.entries(windows).every(([k, w]) =>
          prevWindows[k]?.utilization === w.utilization && prevWindows[k]?.resetsAt === w.resetsAt);
      const prevUnlimited = !!get().quotaUnlimited[kind];
      const nextUnlimited = !!unlimited;
      if (sameWindows && prevUnlimited === nextUnlimited && prevReason === nextReason) return;
      set({
        rateLimits: sameWindows ? get().rateLimits : { ...get().rateLimits, [kind]: windows },
        quotaUnlimited: prevUnlimited === nextUnlimited
          ? get().quotaUnlimited : { ...get().quotaUnlimited, [kind]: nextUnlimited },
        quotaUnavailable: prevReason === nextReason
          ? get().quotaUnavailable : { ...get().quotaUnavailable, [kind]: nextReason },
      });
    },

    // Called by the /running poll: store the live snapshot and fold it into the
    // grace-window seen-map so a just-finished session lingers in the sidebar's
    // Running section for RUNNING_GRACE_MS after its last activity.
    ingestRunningTasks(tasks) {
      set({ runningTasks: tasks, runningSeen: ingestSeen(get().runningSeen, tasks, Date.now()) });
    },

    ingestInboxItems(items, expectedRevision) {
      set((state) => {
        if (state.promptStateRevision !== expectedRevision) return state;

        const key = (agentName: string, sessionId: string | null, reqId: string, type: string) =>
          JSON.stringify([agentName, sessionId, reqId, type]);
        const pendingKeys = new Set(
          items
            .filter((item) => item.reqId !== null)
            .map((item) => key(item.agentName, item.sessionId, item.reqId!, item.type)),
        );
        const isAuthoritative = (pending: PendingPermission) => pendingKeys.has(key(
          pending.agentName,
          pending.sessionId,
          String(pending.reqId),
          pending.elicitation ? "elicitation" : "permission",
        ));

        let sessions = state.sessions;
        for (const [sessionId, session] of Object.entries(state.sessions)) {
          let sessionChanged = false;
          const threadItems = session.items.map((item) => {
            if ((item.kind !== "permission" && item.kind !== "elicitation") || item.resolved) return item;
            if (pendingKeys.has(key(session.agentName, sessionId, String(item.reqId), item.kind))) return item;
            sessionChanged = true;
            return { ...item, resolved: true, chosen: "Answered on another device" };
          });
          if (!sessionChanged) continue;
          if (sessions === state.sessions) sessions = { ...state.sessions };
          sessions[sessionId] = { ...session, items: threadItems };
        }

        return {
          inboxItems: items,
          pendingPermissions: state.pendingPermissions.filter(isAuthoritative),
          sessions,
          promptStateRevision: state.promptStateRevision + 1,
        };
      });
    },

    async sendPrompt(text, images, files) {
      // Drop images / file references the active agent can't accept rather than
      // failing on send; the composer disables the affordances, these are the
      // belt-and-braces guards. File refs ride on embeddedContext support.
      const imgs = get().promptCapabilities.image ? (images || []) : [];
      const refs = get().promptCapabilities.embeddedContext ? (files || []) : [];
      if ((!text.trim() && !imgs.length && !refs.length) || !get().agentReady) return;
      let activeId = get().activeId;
      let provisional = false;
      if (activeId && get().sessions[activeId] && get().busySessionIds[activeId]) return;
      if (!activeId || !get().sessions[activeId]) {
        activeId = PROVISIONAL(); provisional = true;
        set((st) => ({ sessions: { ...st.sessions, [activeId!]: makeSession(activeId!, Date.now(), { agentName: get().agentName, cwd: get().cwd }) }, activeId }));
      } else if (activeId.startsWith("pending-")) {
        // An optimistic "+" (newSession) conversation whose session/new hasn't
        // landed yet — reuse it and take over resolving the real id below.
        provisional = true;
      }
      patch(activeId, (s) => ({ ...addUserBubble(s, text, imgs.length ? imgs : undefined, refs.length ? refs : undefined), working: true, curAssistantId: null, curThoughtId: null }));
      if (!provisional) touchSessionActivity(activeId);
      setSessionBusy(activeId, true);
      try {
        if (provisional) {
          set({ tip: "Starting session…" });
          const ns = (await initSession()) as NewSessionResult;
          if (!ns?.sessionId) throw new Error("no session id");
          set((st) => {
            const old = st.sessions[activeId!];
            const remapped = remapSession(old, ns.sessionId);
            const sessions = { ...st.sessions }; delete sessions[activeId!];
            sessions[ns.sessionId] = applyModelsModes(remapped, ns);
            const busySessionIds = { ...st.busySessionIds };
            if (busySessionIds[activeId!]) {
              delete busySessionIds[activeId!];
              busySessionIds[ns.sessionId] = true;
            }
            return {
              sessions: trimSessions(sessions, ns.sessionId),
              activeId: ns.sessionId, tip: "",
              busySessionIds, busy: Object.keys(busySessionIds).length > 0,
              queuedPrompts: remapQueue(st.queuedPrompts, activeId!, ns.sessionId),
            };
          });
          activeId = get().activeId!;
          touchSessionActivity(activeId);
        } else if (get().sessions[activeId].viewOnly) {
          if (agentCanLoadSession()) {
            set({ tip: "Resuming agent…" });
            patch(activeId, (s) => ({ ...s, suppressReplay: true }));
            const sessionCwd = get().sessions[activeId]?.cwd || get().cwd || "";
            const lr = (await acp.request("session/load", { sessionId: activeId, cwd: sessionCwd, mcpServers: [] })) as NewSessionResult;
            set((st) => {
              const session = applyModelsModes(st.sessions[activeId!], lr);
              return { sessions: { ...st.sessions, [activeId!]: { ...session, suppressReplay: false, viewOnly: false } }, tip: "" };
            });
          } else {
            // This agent can't resume the old session over ACP, so replying forks
            // a fresh one. Cancel the predecessor first: if its previous turn is
            // still tracked as running on the gateway (e.g. it stalled on a
            // permission nobody answered), the fork would otherwise leave it
            // lingering as a second, duplicate-looking running task forever.
            acp.notify("session/cancel", { sessionId: activeId });
            sessionInit = null;
            set({ tip: "Starting session…" });
            const ns = (await initSession()) as NewSessionResult;
            if (!ns?.sessionId) throw new Error("no session id");
            set((st) => {
              const old = st.sessions[activeId!];
              const remapped = remapSession(old, ns.sessionId);
              const sessions = { ...st.sessions };
              delete sessions[activeId!];
              sessions[ns.sessionId] = applyModelsModes({ ...remapped, suppressReplay: false, viewOnly: false }, ns);
              const busySessionIds = { ...st.busySessionIds };
              if (busySessionIds[activeId!]) {
                delete busySessionIds[activeId!];
                busySessionIds[ns.sessionId] = true;
              }
              return {
                sessions: trimSessions(sessions, ns.sessionId),
                activeId: ns.sessionId, tip: "",
                busySessionIds, busy: Object.keys(busySessionIds).length > 0,
                queuedPrompts: remapQueue(st.queuedPrompts, activeId!, ns.sessionId),
              };
            });
            activeId = get().activeId!;
            touchSessionActivity(activeId);
          }
        }
      } catch (e: any) {
        setSessionBusy(activeId, false);
        if (provisional) {
          // roll back the throwaway session (matches legacy console.html:1050-1052).
          // Anything queued against it goes with it — there is no session left to
          // drain into, and the tip below says the send never happened.
          set((st) => {
            const sessions = { ...st.sessions }; delete sessions[activeId!];
            const queuedPrompts = { ...st.queuedPrompts }; delete queuedPrompts[activeId!];
            return { sessions, activeId: null, queuedPrompts };
          });
        } else {
          patch(activeId, (s) => ({ ...s, suppressReplay: false, working: false }));
        }
        if (!e?.__disconnected) set({ tip: "Couldn't start session: " + msg(e) });
        return;
      }
      await runPrompt(activeId!, text, imgs, refs);
    },

    async sendPromptTo(sessionId, text, images, files) {
      const target = get().sessions[sessionId];
      // A provisional id belongs to a conversation the agent has not created yet
      // (a branch whose session/fork is still in flight) — prompting it would be
      // a request about a session that does not exist. The branch window already
      // shows a waiting strip instead of a composer; this is the belt to that
      // braces, for any other caller.
      if (!target || target.viewOnly || sessionId.startsWith("pending-") || !get().agentReady) return false;
      if (get().busySessionIds[sessionId]) return false;
      const imgs = get().promptCapabilities.image ? (images || []) : [];
      const refs = get().promptCapabilities.embeddedContext ? (files || []) : [];
      if (!text.trim() && !imgs.length && !refs.length) return false;
      patch(sessionId, (s) => ({
        ...addUserBubble(s, text, imgs.length ? imgs : undefined, refs.length ? refs : undefined),
        working: true, curAssistantId: null, curThoughtId: null,
      }));
      touchSessionActivity(sessionId);
      setSessionBusy(sessionId, true);
      await runPrompt(sessionId, text, imgs, refs);
      return true;
    },

    async runShell(sessionId, cmd) {
      const sess = get().sessions[sessionId];
      if (!sess) return;
      // Two notes, not one: the command lands immediately so a slow run has
      // visible feedback, the output follows when the gateway answers.
      const note = (text: string, variant: "shell" | "error") =>
        patch(sessionId, (s) => ({
          ...s, seq: s.seq + 1, hasContent: true,
          items: [...s.items, { id: s.id + ":" + (s.seq + 1), kind: "note" as const, variant, text }],
        }));
      note("! " + cmd, "shell");
      touchSessionActivity(sessionId);
      try {
        const res = await execCommand(cmd, sess.cwd || get().cwd);
        note(shellNote(res), "shell");
        set((cur) => ({
          shellStash: { ...cur.shellStash, [sessionId]: [cur.shellStash[sessionId], shellContext(cmd, res)].filter(Boolean).join("\n") },
        }));
      } catch (e) {
        // Nothing ran (terminal withheld, gateway away) — nothing to stash.
        note("Shell error: " + msg(e), "error");
      }
    },

    queuePrompt(sessionId, prompt) {
      const item = makeQueued(prompt);
      if (!item) return;
      set((st) => ({ queuedPrompts: { ...st.queuedPrompts, [sessionId]: [...(st.queuedPrompts[sessionId] ?? []), item] } }));
    },

    interruptWith(sessionId, prompt) {
      const item = makeQueued(prompt);
      if (!item) return;
      // Head of the queue, not the tail: interrupt means "this one, now". Anything
      // already queued keeps its place behind it and goes out after this turn.
      set((st) => ({ queuedPrompts: { ...st.queuedPrompts, [sessionId]: [item, ...(st.queuedPrompts[sessionId] ?? [])] } }));
      // Whether there is still a turn to cut is read HERE, not from the composer's
      // `activeBusy`: that is React state, and over a phone link the turn can settle
      // while the tap is landing. Cancelling a finished turn is a no-op that nothing
      // settles, so the message would sit parked — and the exemption below would
      // stay armed and fire the queue after the NEXT deliberate stop.
      if (!get().busySessionIds[sessionId]) { drainQueue(sessionId); return; }
      // The agent cannot take a second prompt mid-turn, so the send is the drain
      // that the cancel's own settle triggers. That settle arrives as "cancelled",
      // which normally parks the queue — this is the one cancel that must not.
      interrupting.add(sessionId);
      get().cancel(sessionId);
    },

    unqueuePrompt(sessionId, id) {
      set((st) => {
        const rest = (st.queuedPrompts[sessionId] ?? []).filter((q) => q.id !== id);
        const queuedPrompts = { ...st.queuedPrompts };
        // Drop the key rather than leave an empty array: the rail renders on
        // length, and an empty entry per session ever queued into is litter.
        if (rest.length) queuedPrompts[sessionId] = rest; else delete queuedPrompts[sessionId];
        return { queuedPrompts };
      });
    },

    takeQueuedPrompts(sessionId) {
      const items = get().queuedPrompts[sessionId] ?? [];
      if (!items.length) return [];
      set((st) => { const queuedPrompts = { ...st.queuedPrompts }; delete queuedPrompts[sessionId]; return { queuedPrompts }; });
      return items;
    },

    async branchSession(prompt) {
      const parentId = get().activeId;
      const parent = parentId ? get().sessions[parentId] : null;
      // A conversation the agent has never seen (an optimistic "+" tab) has
      // nothing to fork, and a turn in flight is not in the transcript yet — the
      // fork would silently drop it, so it is refused rather than half-copied.
      if (!parentId || !parent || parentId.startsWith("pending-")) return false;
      if (get().busySessionIds[parentId]) { set({ tip: "Wait for this turn to finish before branching." }); return false; }
      // Nothing to ask the branch means nothing would ever be written in it — the
      // one state this feature cannot render. See the action's doc comment.
      if (!prompt.text.trim() && !prompt.images?.length && !prompt.files?.length) return false;
      // Both checked again here even though branchGate already disables the
      // button: one branch per parent is the invariant the React key for a card
      // rests on ("b:" + parentId), and pinning one more conversation past the cap
      // would start starving the main column's own eviction budget.
      if (get().sideWindows.some((w) => w.parentId === parentId)) return false;
      if (get().sideWindows.length >= MAX_SIDE_WINDOWS) {
        set({ tip: "Close a floating conversation first." });
        return false;
      }

      // The window opens NOW, on a provisional id, and the fork round trip
      // happens behind it. Everything it shows is already in memory (the copy is
      // the parent's own thread), so waiting on the agent before painting would
      // be a second of nothing for no reason — the same optimistic-then-remap
      // move sendPrompt makes for a first message. The window renders its
      // composer as a waiting strip until the real id lands, because a
      // provisional session is one the agent cannot be prompted about yet.
      const provisionalId = PROVISIONAL();
      set((st) => {
        // The fork copies the transcript agent-side, but that copy is not on
        // disk until the branch's first turn — so the window is filled from the
        // parent's items in memory rather than from the history API. It is a
        // copy, not a hand-over: the parent stays exactly as it is. Streaming
        // cursors and the busy flag are reset because a mid-turn parent must not
        // hand its half-open bubble to the branch, and `historyStart` rides
        // along untouched: the agent's copy really does have those older
        // messages, so the affordance is honest once the transcript lands.
        const source = st.sessions[parentId] ?? parent;
        const copy: Session = {
          ...remapSession(source, provisionalId),
          title: branchTitle(source.title),
          createdAt: Date.now(), lastActiveAt: Date.now(),
          working: false, curAssistantId: null, curThoughtId: null,
          viewOnly: false, suppressReplay: false, loadingOlder: false,
        };
        // Where the copy ends and the branch's own turns begin. Without it the
        // window reads as a conversation that always had this history, and the
        // one thing the reader needs to know about a branch — that everything
        // above is shared with its parent, and nothing below is — is invisible.
        const seq = copy.seq + 1;
        const marked: Session = {
          ...copy, seq,
          items: [...copy.items, {
            id: copy.id + ":" + seq, kind: "note",
            text: "· branched from \u201c" + source.title + "\u201d — everything above is copied",
          }],
        };
        const sideWindows = [...st.sideWindows, { parentId, sessionId: provisionalId, slot: freeSlot(st.sideWindows) }];
        return {
          // Deliberately NOT applyModelsModes on the fork result, here or below:
          // it reports the values the fork came up at, BEFORE the gateway puts the
          // parent's controls back onto it. The branch inherits the parent's, which
          // the copied session already carries (engine and all), and the
          // config_option_update the gateway broadcasts once it has re-applied them
          // is what corrects the copy if they differ.
          sessions: trimSessions({ ...st.sessions, [provisionalId]: marked }, st.activeId, sideWindows),
          sideWindows,
          tip: "",
        };
      });

      try {
        const cwd = parent.cwd || get().cwd || "";
        const res = (await acp.request("session/fork", { sessionId: parentId, cwd, mcpServers: [] })) as NewSessionResult;
        if (!res?.sessionId) throw new Error("no session id");
        set((st) => {
          // Closed while the fork was in flight (or evicted): the branch exists
          // agent-side and stays reachable from the sidebar, but nothing here
          // should reopen a window the user just dismissed.
          const provisional = st.sessions[provisionalId];
          if (!provisional) return {};
          const sessions = { ...st.sessions };
          delete sessions[provisionalId];
          sessions[res.sessionId] = remapSession(provisional, res.sessionId);
          const sideWindows = st.sideWindows.map((w) =>
            w.sessionId === provisionalId ? { ...w, sessionId: res.sessionId } : w);
          return {
            sessions: trimSessions(sessions, st.activeId, sideWindows),
            sideWindows,
            tip: "",
          };
        });
        // The message that motivated the branch is its first turn. That is also
        // what writes the fork's transcript (the agent copies the history into it
        // then, not at fork time) and what records it in the recents list — so a
        // branch only ever reaches the sidebar with something behind it. Not
        // awaited: the caller needs to know the fork landed, not how the turn goes.
        void get().sendPromptTo(res.sessionId, prompt.text, prompt.images, prompt.files);
        return true;
      } catch (e) {
        // Take the optimistic window back down with the failure — leaving a
        // window that can never be prompted would be worse than never opening it.
        set((st) => {
          const sessions = { ...st.sessions };
          delete sessions[provisionalId];
          return {
            sessions,
            sideWindows: st.sideWindows.filter((w) => w.sessionId !== provisionalId),
            tip: "Couldn't branch conversation: " + msg(e),
          };
        });
        return false;
      }
    },

    async openSideChat(target) {
      const parentId = get().activeId;
      const id = target.sessionId;
      // The sidebar gates the menu row on exactly these, and this checks them
      // again anyway — same belt-to-the-braces as sendPromptTo. A conversation the
      // agent has never seen has nothing to sit beside; a row under another agent
      // lives on a connection we don't hold (opening it would need the deep-link
      // reconnect, which replaces the whole page's session set); and opening the
      // conversation that IS on screen would put the same thread in both places.
      if (!parentId || parentId.startsWith("pending-") || id === parentId) return;
      if (target.agentName !== get().agentName || !agentCanLoadSession()) return;

      // Already has a window: raise it rather than opening a second card on the
      // same conversation — but only if its session is still live and promptable.
      // An entry whose session was evicted (or came back view-only) falls through
      // to the load below, which is what makes reopening it from the sidebar the
      // way to get a blanked card back.
      const win = get().sideWindows.find((w) => w.sessionId === id);
      const alive = get().sessions[id];
      if (win && alive && !alive.viewOnly) { get().raiseSideWindow(id); return; }
      if (!win && get().sideWindows.length >= MAX_SIDE_WINDOWS) {
        set({ tip: "Close a floating conversation first." });
        return;
      }

      // Already live here and promptable: opening the window is the whole change.
      // A view-only session does NOT qualify — sendPromptTo refuses one, so
      // shortcutting would open a window with a dead composer; that one is
      // re-loaded live below like any other.
      if (alive && !alive.viewOnly) {
        set((st) => ({ sideWindows: [...st.sideWindows, { parentId: null, sessionId: id, slot: freeSlot(st.sideWindows) }] }));
        return;
      }

      // The window opens NOW, on an empty shell, and the load round trip happens
      // behind it — a menu click that does nothing for a round trip reads as a
      // click that missed. `suppressReplay` from the start: the agent replays the
      // whole conversation on session/load, and the thread is rendered from the
      // history API instead (same trade as joinSession).
      set((st) => {
        let shell = makeSession(id, Date.now(), { agentName: target.agentName, cwd: target.cwd });
        if (target.title) shell = setTitle(shell, target.title);
        // Reopening a window whose session had been evicted keeps its existing
        // entry (and so its slot and z-order); a new one joins at the front.
        const sideWindows = st.sideWindows.some((w) => w.sessionId === id)
          ? st.sideWindows
          : [...st.sideWindows, { parentId: null, sessionId: id, slot: freeSlot(st.sideWindows) }];
        return {
          sessions: trimSessions({ ...st.sessions, [id]: { ...shell, suppressReplay: true } }, st.activeId, sideWindows),
          sideWindows,
          tip: "",
        };
      });

      try {
        // The ROW's cwd, not the store's: the conversation may live in a folder
        // this client isn't in, and the folder on screen must not move for it.
        const lr = (await acp.request("session/load", { sessionId: id, cwd: target.cwd, mcpServers: [] })) as NewSessionResult;
        const r = await getMessages(target.agentName, target.cwd, id, historyPageFor());
        set((st) => {
          // Closed (or evicted) while the load was in flight: like a branch, the
          // conversation stays live and reachable, but nothing here reopens a
          // window the reader just dismissed.
          const shell = st.sessions[id];
          if (!shell) return {};
          const base = makeSession(id, shell.createdAt, { agentName: target.agentName, cwd: target.cwd });
          const cur = applyHistoryMessages({ ...base, title: shell.title, historyStart: r.start }, r.messages);
          // The load result lands on THIS session — its model/mode and the lists
          // its dock offers alike (Session.engine). That is the whole reason the
          // lists are per session: the card's dock reads this conversation's, and
          // the main column's dock is left describing the conversation on screen.
          const ready = appendPendingPermissions(
            { ...applyModelsModes(cur, lr), suppressReplay: false, viewOnly: false }, st.pendingPermissions);
          return { sessions: trimSessions({ ...st.sessions, [id]: ready }, st.activeId), tip: "" };
        });
      } catch (e) {
        // Take the optimistic window back down with the failure — a window that
        // can never be prompted is worse than never having opened one. activeId
        // was never touched, so unlike joinSession there is nothing to recover:
        // the conversation on screen is still the conversation on screen.
        set((st) => {
          const sessions = { ...st.sessions };
          delete sessions[id];
          return {
            sessions,
            sideWindows: st.sideWindows.filter((w) => w.sessionId !== id),
            tip: "Couldn't open side chat: " + msg(e),
          };
        });
      }
    },

    closeSideWindow(sessionId) {
      set((st) => ({ sideWindows: st.sideWindows.filter((w) => w.sessionId !== sessionId) }));
    },
    raiseSideWindow(sessionId) {
      set((st) => {
        const win = st.sideWindows.find((w) => w.sessionId === sessionId);
        if (!win || st.sideWindows.at(-1) === win) return {}; // already on top
        return { sideWindows: [...st.sideWindows.filter((w) => w !== win), win] };
      });
    },

    setModel(id, sessionId) {
      const st = get(); const sid = sessionId ?? st.activeId; if (!sid || !st.sessions[sid]) return;
      const prev = st.sessions[sid].modelId;
      patch(sid, (s) => ({ ...s, modelId: id }));
      touchSessionActivity(sid);
      acp.request("session/set_model", { sessionId: sid, modelId: id }).catch((e) => {
        patch(sid, (s) => ({ ...s, modelId: prev })); set({ tip: "Couldn't switch model: " + msg(e) });
      });
    },
    setMode(id, sessionId) {
      const st = get(); const sid = sessionId ?? st.activeId; if (!sid || !st.sessions[sid]) return;
      const prev = st.sessions[sid].mode;
      patch(sid, (s) => ({ ...s, mode: id }));
      touchSessionActivity(sid);
      acp.request("session/set_mode", { sessionId: sid, modeId: id }).catch((e) => {
        patch(sid, (s) => ({ ...s, mode: prev })); set({ tip: "Couldn't switch mode: " + msg(e) });
      });
    },
    setConfigOption(configId, value, sessionId) {
      // The option is looked up in, and written back to, the TARGET session's own
      // list — a floating window's dock and the main column's set different
      // conversations, and neither may relabel the other.
      const sid = sessionId ?? get().activeId;
      if (!sid || !get().sessions[sid]) return;
      const list = engineOf(get(), sid).configOptions;
      const opt = list.find((o) => o.id === configId);
      if (!opt) return;
      const write = (configOptions: ConfigOption[]) =>
        patch(sid, (s) => ({ ...s, engine: { ...s.engine, configOptions } }));
      write(list.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)));
      acp.request("session/set_config_option", { sessionId: sid, configId, value })
        .then((r: any) => { if (r?.configOptions) write(r.configOptions); })
        .catch((e) => { write(list); set({ tip: "Couldn't change " + opt.name + ": " + msg(e) }); });
    },
    // No argument = the conversation on screen; an id = any of them, which is how
    // the branch window's own composer stops its own turn.
    cancel(sessionId) { const sid = sessionId ?? get().activeId; if (sid) { touchSessionActivity(sid); acp.notify("session/cancel", { sessionId: sid }); } },

    // Called when the page returns to the foreground (visibilitychange/pageshow).
    // iOS suspends a backgrounded tab: the socket can drop with its onclose-driven
    // reconnect timer frozen, or never fire onclose at all — either way the client
    // sits "connected" to a dead link and the in-flight response never lands.
    // Reconnect now if the socket isn't live; the "connected" handler then resyncs
    // the busy session (pendingResyncId) so the completed turn streams back in.
    ensureConnected() {
      // While locked the socket stays down on purpose — unlock() reopens it.
      if (get().locked) return;
      if (!acp || !acp.needsReconnect()) return;
      // A dead socket on resume is an involuntary reconnect: lock first when the
      // lock is on (iOS can drop the socket while backgrounded without firing
      // onclose, so this path — not the offline handler — is what catches it).
      reconnectOrLock(() => {
        clearReconnectTimer();
        const st = get();
        const busyId = st.activeId && st.busySessionIds[st.activeId] ? st.activeId : Object.keys(st.busySessionIds)[0];
        if (busyId) pendingResyncId = busyId;
        acp.connect();
      });
    },

    // Engage the screen lock: sever the live agent connection (so a held device
    // can't keep driving the agent) and show the LockScreen. Session state is
    // kept in memory so unlock() can resume where we left off. Silent close →
    // no offline status, no auto-reconnect.
    lock() {
      if (get().locked || !get().lockEnabled) return;
      const st = get();
      const busyId = st.activeId && st.busySessionIds[st.activeId] ? st.activeId : Object.keys(st.busySessionIds)[0];
      if (busyId) pendingResyncId = busyId;
      clearReconnectTimer();
      acp?.close();
      set({
        locked: true, conn: "offline", agentReady: false, tip: "",
        promptStateRevision: get().promptStateRevision + 1,
      });
    },

    // Unlock (the LockScreen has already verified the PIN) and reopen the
    // connection to the current agent; the connected handler resyncs a busy
    // session via pendingResyncId, same as a foreground resume.
    unlock() {
      if (!get().locked) return;
      set({ locked: false, conn: "connecting", tip: "Reconnecting…" });
      openConnection();
    },

    // Re-read the PIN config after the user sets/changes/removes it in the
    // settings UI, so lockEnabled stays in sync.
    refreshLockSettings() {
      set({ lockEnabled: isLockEnabled() });
    },

    // Closing the panel deliberately keeps `filePreview`: reopening it should
    // land back on the file you were reading, not throw you to the top of the
    // list. Only the panel's own back button clears it.
    setChangeStat(stat) {
      set({ changeStat: stat });
    },

    toggleFiles() {
      set((st) => ({ filesOpen: !st.filesOpen }));
    },

    closeFiles() {
      set({ filesOpen: false });
    },

    // Collapsing keeps the sidebar's own state (tab, query, filters) — it goes
    // through this flag, never through the mobile sheet's `open` prop.
    toggleSidebar() {
      set((st) => ({ sidebarOpen: !st.sidebarOpen }));
    },

    openFilePreview(file) {
      if (!file.abs) return;
      set({
        filesOpen: true,
        filePreview: {
          abs: file.abs, path: file.path || basename(file.abs), mode: file.mode ?? "diff", cwd: file.cwd,
        },
      });
    },

    clearFilePreview() {
      set({ filePreview: null });
    },

    // De-duplicated on the URI, which carries the line range: two ranges of one
    // file are two attachments, the same range attached twice is one.
    attachFiles(files) {
      if (!files.length) return;
      set((st) => {
        const next = [...st.attachedFiles];
        for (const f of files) if (!next.some((p) => p.uri === f.uri)) next.push(f);
        return { attachedFiles: next };
      });
    },

    // By index rather than by URI: an upload that failed to report one would
    // otherwise be a chip that cannot be removed.
    removeAttachedFile(index) {
      set((st) => ({ attachedFiles: st.attachedFiles.filter((_, i) => i !== index) }));
    },

    clearAttachedFiles() {
      set({ attachedFiles: [] });
    },
  };
});

// Keep the URL in sync with the active session + cwd, so a refresh, bookmark, or
// copied address resumes the same conversation (same shape as a shared deep-link).
// replaceState (not push) — switching conversations shouldn't spam browser history.
useStore.subscribe((state, prev) => {
  const id = state.activeId;
  const session = id ? state.sessions[id] : null;
  const hasContent = !!session?.hasContent;
  const prevSession = prev.activeId ? prev.sessions[prev.activeId] : null;
  if (state.activeId === prev.activeId && state.cwd === prev.cwd && hasContent === !!prevSession?.hasContent) return;
  if (!id || id.startsWith("pending-")) return; // only real, persisted sessions
  if (!hasContent) {
    if (location.search.includes("session=") || location.search.includes("cwd=")) history.replaceState(null, "", location.pathname || "/");
    return;
  }
  // Link any conversation that can actually be reopened: agents that can resume
  // (Claude) reopen it live, agents that can't but expose history (Codex) reopen it
  // view-only. An agent with neither would produce a dead link, so skip those.
  const agentRef = state.cfg.agents.find((a) => a.name === state.agentName);
  const reopenable = agentRef?.sessionLoad !== false || agentRef?.history !== false;
  if (!reopenable && !session?.viewOnly) {
    if (location.search.includes("session=") || location.search.includes("cwd=")) history.replaceState(null, "", location.pathname || "/");
    return;
  }
  // The ?agent= keeps the link unambiguous across agents.
  const fullUrl = new URL(shareUrl(id, session?.cwd || state.cwd, state.agentName));
  const url = fullUrl.pathname + fullUrl.search + fullUrl.hash;
  if (location.pathname + location.search + location.hash !== url) history.replaceState(null, "", url);
});

applyAgentSkin(activeAgentSkin(useStore.getState()));
applyAgentColor(activeAgentColor(useStore.getState()));
useStore.subscribe((state, prev) => {
  if (activeAgentSkin(state) !== activeAgentSkin(prev)) applyAgentSkin(activeAgentSkin(state));
  if (activeAgentColor(state) !== activeAgentColor(prev)) applyAgentColor(activeAgentColor(state));
});

// expose the permission resolver for the PermissionPrompt component
export function answerPermission(reqId: number | string, optionId: string) {
  useStore.getState().answerPermission(reqId, optionId);
}

// expose the elicitation resolver for the ElicitationPrompt component
export function answerElicitation(reqId: number | string, response: ElicitationResponse, summary: string) {
  useStore.getState().answerElicitation(reqId, response, summary);
}

// Whether a row's file is the one the preview pane is showing. A hook rather
// than a prop threaded down every list: the file rows are leaves in four
// different lists (two of them recursive), and the answer is one field of the
// store either way.
export function useIsOpenFile(abs: string): boolean {
  return useStore((s) => s.filePreview?.abs === abs);
}
