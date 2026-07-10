import { create } from "zustand";
import { Acp, sseFactory, type RpcMessage } from "../lib/acp.ts";
import { readConfig, sseUrl, rpcUrl, linkParams, shareUrl } from "../lib/config.ts";
import { getMessages, renameSession as apiRename, getPrefs, putTextSize, answerInbox, type RunningTask, type InboxItem } from "../lib/api.ts";
import { resolveRunningTask } from "../lib/runningTask.ts";
import { readRecentSessions, touchRecentSession, hydrateRecentSessions, type RecentSession } from "../lib/recentSessions.ts";
import { touchRecentFolder, hydrateRecentFolders } from "../lib/recentFolders.ts";
import { isLockEnabled, hydrateLock } from "../lib/lock.ts";
import {
  makeSession, applyUpdate, addUserBubble, applyModelsModes, applyHistoryMessages, remapSession, setTitle, evictExcess,
} from "./reducers.ts";
import type {
  Session, Model, Mode, ConfigOption, SlashCommand, PermissionOption, NewSessionResult, ThreadItem, PendingPermission,
  AgentSkin, MessageImage, MessageFile, PromptCapabilities, ElicitationResponse,
} from "../types.ts";
import { parseElicitationFields } from "../lib/elicitation.ts";

type ConnState = "connecting" | "connected" | "offline";
export type TextSize = "small" | "default" | "large" | "xl";

export const TEXT_SIZE_OPTIONS: Array<{ id: TextSize; label: string; description: string }> = [
  { id: "small", label: "Small", description: "More messages on screen" },
  { id: "default", label: "Default", description: "Current Claude-style reading size" },
  { id: "large", label: "Large", description: "Easier reading on phone" },
  { id: "xl", label: "XL", description: "Maximum readability" },
];

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
  models: Model[];
  modes: Mode[];
  commands: SlashCommand[];
  configOptions: ConfigOption[];
  promptCapabilities: PromptCapabilities; // what the active agent accepts in a prompt (image, …)
  pendingPermissions: PendingPermission[];
  autoApprove: boolean;
  textSize: TextSize;
  busy: boolean;
  busySessionIds: Record<string, true>;
  joining: boolean; // resolving a ?session= deep-link (show a loading state, not "Ready to code?")
  historyNonce: number; // bumped to ask the sidebar to refresh its conversation list (e.g. after rename)
  recentSessions: RecentSession[];
  runningTasks: RunningTask[]; // polled from the gateway: sessions with a prompt in flight, across all agents
  inboxItems: InboxItem[]; // polled from the gateway: pending permission prompts, durable and across all agents
  locked: boolean; // screen lock engaged — the SSE stream is torn down until unlocked
  lockEnabled: boolean; // a PIN is configured (mirrors lib/lock for UI reactivity)
  // actions
  bootstrap: () => void;
  setAgent: (name: string) => void;
  setActive: (id: string) => void;
  selectSession: (id: string) => void;
  newSession: () => Promise<void>;
  openHistorySession: (s: { sessionId: string; title: string | null; agentName?: string; cwd?: string }) => Promise<void>;
  openRecentSession: (s: RecentSession) => Promise<void>;
  sendPrompt: (text: string, images?: MessageImage[], files?: MessageFile[]) => Promise<void>;
  setModel: (id: string) => void;
  setMode: (id: string) => void;
  setConfigOption: (configId: string, value: string) => void;
  cancel: () => void;
  setCwd: (p: string) => void;
  toggleAuto: () => void;
  setTextSize: (size: TextSize) => void;
  setTip: (t: string) => void;
  renameSession: (title: string) => void;
  answerPermission: (reqId: number | string, optionId: string) => void;
  answerElicitation: (reqId: number | string, response: ElicitationResponse, summary: string) => void;
  answerInboxItem: (agentName: string, reqId: string, optionId: string) => void;
  jumpToTask: (task: RunningTask) => void;
  ensureConnected: () => void;
  lock: () => void;
  unlock: () => void;
  refreshLockSettings: () => void;
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

export function hasCodexSkin(state: SkinState): boolean {
  return activeAgentSkin(state) === "codex";
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
// switching back restores it instead of dropping into a blank new session.
const lastSessionByAgent = new Map<string, { id: string; cwd: string }>();
// agentName -> highest SSE seq seen on that agent's stream, so switching back to
// an agent resumes its stream after that seq and the ledger replays the frames
// produced while we were away. Survives Acp recreation (per-agent channels).
const agentCursors = new Map<string, number>();
const PROVISIONAL = () => "pending-" + Math.random().toString(36).slice(2);
const MAX_LIVE_SESSIONS = 8;

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

  const sameReq = (a: number | string, b: number | string) => String(a) === String(b);

  // Both blocking prompt kinds — permission cards and elicitation (agent
  // question) forms — resolve the same way: flagged answered with a short
  // human-readable recap of what was chosen.
  const isPromptItem = (it: ThreadItem): it is Extract<ThreadItem, { kind: "permission" | "elicitation" }> =>
    it.kind === "permission" || it.kind === "elicitation";

  function markPromptResolved(s: Session, reqId: number | string, chosen: string): Session {
    let changed = false;
    const items = s.items.map((it) => {
      if (!isPromptItem(it) || !sameReq(it.reqId, reqId)) return it;
      changed = true;
      return { ...it, resolved: true, chosen };
    });
    return changed ? { ...s, items } : s;
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
    });
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

  async function openSavedSession(s: { sessionId: string; title: string | null }, cwd: string) {
    const id = s.sessionId;
    if (activateLive(id)) return;   // live in memory → instant, cwd restored
    let sess = get().sessions[id] || makeSession(id, Date.now(), { agentName: get().agentName, cwd });
    if (s.title) sess = setTitle(sess, s.title);
    sess = { ...sess, viewOnly: true };
    set((st) => ({ sessions: { ...st.sessions, [id]: sess }, activeId: id, cwd, tip: "Loading conversation…" }));
    try {
      const r = await getMessages(get().agentName, cwd, id);
      set((st) => {
        let cur = makeSession(id, st.sessions[id].createdAt, { agentName: get().agentName, cwd });
        cur = { ...cur, title: st.sessions[id].title, viewOnly: true };
        cur = applyHistoryMessages(cur, r.messages);
        const seq = cur.seq + 1;
        cur = { ...cur, seq, curAssistantId: null, curThoughtId: null,
          items: [...cur.items, {
            id: cur.id + ":" + seq,
            kind: "note",
            text: agentCanLoadSession()
              ? "· saved conversation — reply to resume the agent"
              : "· saved conversation — reply to start a new session",
          }] };
        // Re-attach any still-outstanding permission prompt for this session — the
        // history API never carries an unanswered prompt, so without this a prompt
        // that arrived while we were elsewhere stays hidden until a page refresh.
        cur = appendPendingPermissions(cur, st.pendingPermissions);
        return { sessions: evictExcess({ ...st.sessions, [id]: cur }, id, MAX_LIVE_SESSIONS), tip: "" };
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
      return { sessions };
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
      sessions: {}, activeId: null,
      models: [], modes: [], commands: [], configOptions: [],
      promptCapabilities: {}, pendingPermissions: [],
      busy: false, busySessionIds: {},
    });
    // An agent restart is an involuntary reconnect — lock first when the lock is on.
    reconnectOrLock(openConnection);
  }

  function handleNotification(m: RpcMessage) {
    if (m.method === "_gateway/reload") return onGatewayReload();
    if (m.method === "_gateway/agent_restart") return onAgentRestart();
    if (m.method !== "session/update") return;
    const p = m.params as { sessionId?: string; update?: any } | undefined;
    if (!p?.update) return;
    if (p.update.sessionUpdate === "available_commands_update") {
      set({ commands: p.update.availableCommands || [] });
      return;
    }
    if (p.update.sessionUpdate === "config_option_update") {
      if (p.update.configOptions) set({ configOptions: p.update.configOptions });
      return;
    }
    const st = get();
    const remotePrompt = p.update.sessionUpdate === "user_message_chunk";
    // Frames that carry a sessionId must never fall back to activeId. The gateway
    // fans out notifications, so late updates from a folder/session we just left
    // can otherwise be appended to the newly active conversation.
    const sid = p.sessionId ? (st.sessions[p.sessionId] ? p.sessionId : "") : (st.activeId || "");
    if (!st.sessions[sid]) return;
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
      for (const [sid, sess] of Object.entries(st.sessions)) {
        sessions[sid] = sess.agentName && sess.agentName !== agent ? sess : markPromptResolved(sess, reqId, chosen);
      }
      return {
        pendingPermissions: st.pendingPermissions.filter((it) => !(it.agentName === agent && sameReq(it.reqId, reqId))),
        inboxItems: st.inboxItems.filter((it) => !(it.agentName === agent && it.reqId === String(reqId))),
        sessions,
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
        set((cur) => ({
          pendingPermissions: [
            // Dedupe a re-delivery of THIS agent's reqId only — another agent's
            // connection can reuse the same number for an unrelated prompt.
            ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
            { reqId: m.id!, sessionId: p.sessionId!, agentName: st.agentName, title, options: opts, createdAt: Date.now() },
          ],
          inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, p.sessionId!, m.id!, title, opts),
        }));
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
    set((cur) => ({
      pendingPermissions: [
        // Dedupe a re-delivery of THIS agent's reqId only — another agent's
        // connection can reuse the same number for an unrelated prompt.
        ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
        { reqId: m.id!, sessionId: sid, agentName: st.agentName, title, options: opts, createdAt: Date.now() },
      ],
      inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, sid, m.id!, title, opts),
    }));
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
        set((cur) => ({
          pendingPermissions: [
            ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
            pendingEntry(p.sessionId!),
          ],
          inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, p.sessionId!, m.id!, message, [], "elicitation"),
        }));
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
    set((cur) => ({
      pendingPermissions: [
        ...cur.pendingPermissions.filter((it) => !(it.agentName === st.agentName && sameReq(it.reqId, m.id!))),
        pendingEntry(sid),
      ],
      inboxItems: upsertInboxItem(cur.inboxItems, st.agentName, sid, m.id!, message, [], "elicitation"),
    }));
  }

  function initSession(): Promise<unknown> {
    if (!sessionInit) sessionInit = acp.request("session/new", { cwd: get().cwd || "", mcpServers: [] });
    return sessionInit;
  }

  function adopt(res: NewSessionResult) {
    const baseSession = makeSession(res.sessionId, Date.now(), { agentName: get().agentName, cwd: get().cwd });
    const { session, models, modes, configOptions } = applyModelsModes(baseSession, res);
    set((st) => ({
      sessions: evictExcess({ ...st.sessions, [res.sessionId]: session }, res.sessionId, MAX_LIVE_SESSIONS),
      models: models ?? st.models,
      modes: modes ?? st.modes,
      configOptions: configOptions ?? st.configOptions,
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
  async function joinSession(id: string) {
    if (!agentCanLoadSession()) {
      set({ joining: false });
      await openSavedSession({ sessionId: id, title: null }, get().cwd);
      return;
    }
    // the Thread shows a "Joining conversation…" loading view (s.joining), so no tip needed
    set((st) => ({ sessions: { ...st.sessions, [id]: makeSession(id, Date.now(), { agentName: get().agentName, cwd: get().cwd }) }, activeId: id, tip: "" }));
    try {
      patch(id, (s) => ({ ...s, suppressReplay: true })); // drop the agent's load-replay; render from the history API instead
      const lr = (await acp.request("session/load", { sessionId: id, cwd: get().cwd || "", mcpServers: [] })) as NewSessionResult;
      const r = await getMessages(get().agentName, get().cwd, id);
      set((st) => {
        const cur = applyHistoryMessages(makeSession(id, st.sessions[id]?.createdAt ?? Date.now(), { agentName: get().agentName, cwd: get().cwd }), r.messages);
        const { session, models, modes, configOptions } = applyModelsModes(cur, lr);
        const ready = appendPendingPermissions({ ...session, suppressReplay: false, viewOnly: false }, st.pendingPermissions);
        return {
          sessions: evictExcess({ ...st.sessions, [id]: ready }, id, MAX_LIVE_SESSIONS),
          models: models ?? st.models, modes: modes ?? st.modes, configOptions: configOptions ?? st.configOptions, tip: "", joining: false,
        };
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
    acp.onNotification(handleNotification);
    acp.onRequest(handleRequest);
    acp.onStatus(handleStatus);
    acp.connect();
  }

  // Reconnect to `agentName` and open `sessionId` through the shared deep-link
  // join flow (the same path shared links use): write ?agent=&session=&cwd= to the
  // URL, tear down the current channel, and let handleStatus pick up link.session
  // once the target agent is ready. Used to open a sidebar conversation that lives
  // under a different agent (and by jumpToTask for cross-agent/-folder tasks).
  function openViaDeepLink(agentName: string, sessionId: string, cwd: string | undefined, tip: string) {
    const params = new URLSearchParams();
    params.set("agent", agentName);
    params.set("session", sessionId);
    if (cwd) params.set("cwd", cwd);
    history.replaceState(null, "", location.pathname + "?" + params.toString());
    acp?.close();
    clearReconnectTimer();
    sessionInit = null;
    pendingResyncId = null;
    set({
      agentName, cwd: cwd || get().cwd,
      conn: "connecting", agentReady: false, tip,
      sessions: {}, activeId: null, models: [], modes: [], commands: [], configOptions: [],
      promptCapabilities: {}, pendingPermissions: [], busy: false, busySessionIds: {}, joining: true,
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
          })) as { agentCapabilities?: { promptCapabilities?: PromptCapabilities; loadSession?: boolean } } | undefined;
          // The agent's capabilities flow through the gateway unchanged. Gate image
          // input on promptCapabilities; and trust the agent's own loadSession over
          // the gateway's conservative name-based guess — codex-acp now reports
          // loadSession:true, so resuming it threads the conversation (like Zed)
          // instead of forking a fresh session on every reply.
          const loadSession = init?.agentCapabilities?.loadSession;
          set((st) => ({
            agentReady: true, tip: "",
            promptCapabilities: init?.agentCapabilities?.promptCapabilities ?? {},
            cfg: typeof loadSession === "boolean"
              ? { ...st.cfg, agents: st.cfg.agents.map((a) => (a.name === st.agentName ? { ...a, sessionLoad: loadSession } : a)) }
              : st.cfg,
          }));
          const link = linkParams();
          if (pendingResyncId) {
            const rid = pendingResyncId; pendingResyncId = null;
            set({ tip: "Reconnected — syncing conversation…" });
            await resync(rid);
          } else if (link.session && get().activeId !== link.session) {
            // deep-link: join the shared session instead of creating our own
            if (link.cwd && get().cwd !== link.cwd) set({ cwd: link.cwd });
            await joinSession(link.session);
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
              // live in memory → the cursor replay (since agentCursors[agent]) catches it up
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
    sessions: {}, activeId: null,
    models: [], modes: [], commands: [], configOptions: [],
    promptCapabilities: {},
    pendingPermissions: [],
    autoApprove: false, textSize: initialTextSize, busy: false, busySessionIds: {},
    joining: !!linkParams().session, // deep-link present → show "Joining…" from first paint
    historyNonce: 0,
    recentSessions: readRecentSessions(),
    runningTasks: [],
    inboxItems: [],
    // The live locked state is local to this browser tab. On startup bootstrap()
    // hydrates the persisted setting before opening the agent connection; if the
    // lock is enabled it engages the local lock first and waits for unlock().
    locked: false,
    lockEnabled: isLockEnabled(),

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
        // KEEP sessions + activeId; only the agent-scoped lists reset (the new
        // connection's initialize/session refills them). pendingPermissions is also
        // KEPT — it is the durable source for outstanding prompts, and since this
        // switch retains sessions, wiping it would drop a background session's prompt
        // (its badge) on a switch-away/back. Entries carry their agentName so the
        // badge only surfaces prompts answerable on the now-active agent.
        models: [], modes: [], commands: [], configOptions: [],
        promptCapabilities: {}, busy: false, busySessionIds: {}, joining: false,
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
    renameSession(title) {
      const sid = get().activeId;
      if (!sid || sid.startsWith("pending-")) return;
      const t = title.trim();
      patch(sid, (s) => ({ ...s, title: t || s.title }));
      touchSessionActivity(sid, t || get().sessions[sid]?.title);
      // persist, then nudge the sidebar to re-pull its list so the entry updates
      apiRename(get().agentName, get().sessions[sid]?.cwd || get().cwd, sid, t)
        .then(() => set((st) => ({ historyNonce: st.historyNonce + 1 })))
        .catch(() => {});
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
        for (const [sid, sess] of Object.entries(st.sessions)) {
          sessions[sid] = sess.agentName && sess.agentName !== agentName ? sess : markPromptResolved(sess, reqId, chosen);
        }
        return {
          inboxItems: st.inboxItems.filter((it) => !(it.agentName === agentName && it.reqId === reqId)),
          pendingPermissions: st.pendingPermissions.filter((it) => !matchesPending(it)),
          sessions,
        };
      });
      if (item?.sessionId) touchSessionActivity(item.sessionId);
    },
    setCwd(p) {
      sessionInit = null;
      touchRecentFolder(p);
      // Set the cwd for the next new chat; KEEP existing live sessions in the
      // background (each remembers its own cwd). configOptions follow the new
      // session once it's created.
      if (location.search.includes("session=") || location.search.includes("cwd=")) {
        history.replaceState(null, "", location.pathname || "/");
      }
      set({ cwd: p, activeId: null, configOptions: [] });
      if (get().agentReady) initSession().then((res: any) => { if (res?.sessionId) adopt(res); }).catch(() => {});
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
          const { session, models, modes, configOptions } = applyModelsModes(remapped, ns);
          const sessions = { ...st.sessions }; delete sessions[provId]; sessions[ns.sessionId] = session;
          return {
            sessions: evictExcess(sessions, ns.sessionId, MAX_LIVE_SESSIONS),
            activeId: st.activeId === provId ? ns.sessionId : st.activeId,
            models: models ?? st.models, modes: modes ?? st.modes, configOptions: configOptions ?? st.configOptions, tip: "",
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
        openViaDeepLink(agentName, s.sessionId, cwd, "Opening conversation…");
        return;
      }
      if (cwd !== get().cwd) { sessionInit = null; set({ cwd }); } // cold: adopt that folder, NO wipe
      await openSavedSession({ sessionId: s.sessionId, title: s.title }, cwd);
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
            const { session, models, modes, configOptions } = applyModelsModes(remapped, ns);
            const sessions = { ...st.sessions }; delete sessions[activeId!]; sessions[ns.sessionId] = session;
            const busySessionIds = { ...st.busySessionIds };
            if (busySessionIds[activeId!]) {
              delete busySessionIds[activeId!];
              busySessionIds[ns.sessionId] = true;
            }
            return {
              sessions: evictExcess(sessions, ns.sessionId, MAX_LIVE_SESSIONS),
              activeId: ns.sessionId, models: models ?? st.models, modes: modes ?? st.modes, configOptions: configOptions ?? st.configOptions, tip: "",
              busySessionIds, busy: Object.keys(busySessionIds).length > 0,
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
              const { session, models, modes, configOptions } = applyModelsModes(st.sessions[activeId!], lr);
              return { sessions: { ...st.sessions, [activeId!]: { ...session, suppressReplay: false, viewOnly: false } }, models: models ?? st.models, modes: modes ?? st.modes, configOptions: configOptions ?? st.configOptions, tip: "" };
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
              const { session, models, modes, configOptions } = applyModelsModes({ ...remapped, suppressReplay: false, viewOnly: false }, ns);
              const sessions = { ...st.sessions };
              delete sessions[activeId!];
              sessions[ns.sessionId] = session;
              const busySessionIds = { ...st.busySessionIds };
              if (busySessionIds[activeId!]) {
                delete busySessionIds[activeId!];
                busySessionIds[ns.sessionId] = true;
              }
              return {
                sessions: evictExcess(sessions, ns.sessionId, MAX_LIVE_SESSIONS),
                activeId: ns.sessionId, models: models ?? st.models, modes: modes ?? st.modes,
                configOptions: configOptions ?? st.configOptions, tip: "",
                busySessionIds, busy: Object.keys(busySessionIds).length > 0,
              };
            });
            activeId = get().activeId!;
            touchSessionActivity(activeId);
          }
        }
      } catch (e: any) {
        setSessionBusy(activeId, false);
        if (provisional) {
          // roll back the throwaway session (matches legacy console.html:1050-1052)
          set((st) => {
            const sessions = { ...st.sessions }; delete sessions[activeId!];
            return { sessions, activeId: null };
          });
        } else {
          patch(activeId, (s) => ({ ...s, suppressReplay: false, working: false }));
        }
        if (!e?.__disconnected) set({ tip: "Couldn't start session: " + msg(e) });
        return;
      }
      try {
        // text block first (when non-empty), then one image block per attachment,
        // then a resource_link per "@ file" reference (the agent reads the file).
        const prompt: Array<Record<string, unknown>> = [];
        if (text.trim()) prompt.push({ type: "text", text });
        for (const im of imgs) {
          prompt.push(im.data
            ? { type: "image", mimeType: im.mimeType, data: im.data }
            : { type: "image", mimeType: im.mimeType, uri: im.uri });
        }
        for (const f of refs) prompt.push({ type: "resource_link", uri: f.uri, name: f.name });
        const res = (await acp.request("session/prompt", { sessionId: activeId, prompt })) as { stopReason?: string };
        patch(activeId, (s) => ({ ...s, curAssistantId: null, curThoughtId: null }));
        if (res?.stopReason && res.stopReason !== "end_turn") {
          patch(activeId, (s) => ({ ...s, seq: s.seq + 1, items: [...s.items, { id: s.id + ":" + (s.seq + 1), kind: "note", text: "· " + res.stopReason }] }));
        }
      } catch (e: any) {
        if (!e?.__disconnected) patch(activeId!, (s) => ({ ...s, seq: s.seq + 1, items: [...s.items, { id: s.id + ":" + (s.seq + 1), kind: "note", variant: "error", text: "Error: " + msg(e) }] }));
      } finally {
        setSessionBusy(activeId!, false);
        patch(activeId!, (s) => ({ ...s, working: false }));
      }
    },

    setModel(id) {
      const st = get(); const sid = st.activeId; if (!sid) return;
      const prev = st.sessions[sid].modelId;
      patch(sid, (s) => ({ ...s, modelId: id }));
      touchSessionActivity(sid);
      acp.request("session/set_model", { sessionId: sid, modelId: id }).catch((e) => {
        patch(sid, (s) => ({ ...s, modelId: prev })); set({ tip: "Couldn't switch model: " + msg(e) });
      });
    },
    setMode(id) {
      const st = get(); const sid = st.activeId; if (!sid) return;
      const prev = st.sessions[sid].mode;
      patch(sid, (s) => ({ ...s, mode: id }));
      touchSessionActivity(sid);
      acp.request("session/set_mode", { sessionId: sid, modeId: id }).catch((e) => {
        patch(sid, (s) => ({ ...s, mode: prev })); set({ tip: "Couldn't switch mode: " + msg(e) });
      });
    },
    setConfigOption(configId, value) {
      const st = get();
      const opt = st.configOptions.find((o) => o.id === configId);
      if (!opt) return;
      const prev = st.configOptions;
      set({ configOptions: st.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)) });
      acp.request("session/set_config_option", { sessionId: get().activeId || undefined, configId, value })
        .then((r: any) => { if (r?.configOptions) set({ configOptions: r.configOptions }); })
        .catch((e) => { set({ configOptions: prev, tip: "Couldn't change " + opt.name + ": " + msg(e) }); });
    },
    cancel() { const sid = get().activeId; if (sid) { touchSessionActivity(sid); acp.notify("session/cancel", { sessionId: sid }); } },

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
      set({ locked: true, conn: "offline", agentReady: false, tip: "" });
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
