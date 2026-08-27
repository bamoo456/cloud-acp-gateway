import { useEffect, useRef, useState } from "react";
import { getHistory, getDiscoveredHistory, searchSessions, type HistorySession, type DiscoveredHistorySession, type RunningTask, type SearchResponse } from "../lib/api.ts";
import type { RecentSession } from "../lib/recentSessions.ts";
import { resolveRunningTask, runningView } from "../lib/runningTask.ts";
import { useStore } from "../store/store.ts";
import { SearchResults } from "./SearchResults.tsx";
import { SearchFilters, DEFAULT_FILTERS, filtersToOptions, type FilterState } from "./SearchFilters.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { useRowMenu } from "./FileMenu.tsx";
import {
  clampSidebarWidth, readSidebarWidth, saveSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH,
  DESKTOP_SIDEBAR_QUERY, isDesktopSidebarWidth,
} from "../lib/sidebarWidth.ts";
import { IconFolder, IconChevron, IconChevronDown, IconCheck, IconTrash, IconPencil, IconX, IconHide, IconArchive, IconPlus, IconSideChat, IconPin, WorkingDots,
  Robot, CodexMark, OpencodeMark } from "../lib/icons.tsx";
import { basename, timeAgo } from "../lib/format.ts";
import { folderKey, homeFrom } from "../lib/folderKey.ts";
import { groupByFolder, latestWithPinned, splitByAge, hideFolders, type GroupableRow } from "../lib/sessionGroups.ts";
import {
  readSessionsView, saveSessionsView, readFolderOverrides, saveFolderOverrides, type SessionsView,
} from "../lib/sessionsView.ts";
import type { AgentRef } from "../types.ts";

// How many rows a collapsed list shows before "See more". Recent is a
// cross-folder recency timeline now (server recents + discovered CLI sessions),
// so five rows is a keyhole: one busy agent's folder fills them all and every
// other agent falls off the bottom, which reads as "my codex conversations are
// gone" rather than "they're behind See more".
const RECENT_LIMIT = 15;
const CONVERSATION_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
// A content search reads transcripts off disk, so it waits for the typing to
// settle; a one-character term would scan everything to match everything, so it
// never leaves the client at all.
const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LEN = 2;
// A history row tagged with the agent it was fetched from, so the unified list can
// show the owning agent's mark and reopen it under that agent.
type TaggedHistory = HistorySession & { agentName: string };
type TaggedDiscoveredHistory = DiscoveredHistorySession & { agentName: string };
function withinRecentWindow(iso: string) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t <= CONVERSATION_WINDOW_MS;
}
function matchesQuery(it: HistorySession, q: string) {
  return (it.title || it.sessionId).toLowerCase().includes(q.toLowerCase());
}
// Recents are only recorded for agents that can resume a session (session/load);
// surface a recent only while its owning agent still reports both that and history,
// so every Recent row stays reopenable across an agents.json / capability change.
function recentReopenable(agent?: AgentRef) {
  return !!agent && agent.history !== false && agent.sessionLoad !== false;
}
// Whether /history/discovered can list this agent's conversations from folders
// we aren't in. The gateway advertises it; the kind check is only the fallback
// for gateways predating that field, and stays claude-only on purpose — those
// gateways answer empty for codex anyway.
function discoverable(agent: AgentRef) {
  return agent.discover ?? (agent.kind === "claude" || (!agent.kind && agent.name === "claude"));
}
function sessionTitle(id: string, title?: string | null) {
  return title && title !== "Untitled" ? title : id.slice(0, 8);
}
// What a row's actions need to name its conversation. DELETE /history/session
// takes the id alone (the gateway resolves the owning provider itself), but
// POST /history/rename writes a per-cwd sidecar, so a rename also needs the
// row's OWN agent and folder — a discovered row points at a folder this client
// isn't in. `name` is the real title and is empty when there isn't one; the
// short-id fallback is a display label, never something to persist.
type RowTarget = { sessionId: string; agentName: string; cwd: string; name: string };
const rowLabel = (t: RowTarget) => t.name || t.sessionId.slice(0, 8);
// One list row: the session button and its delete affordance as SIBLINGS — a
// <button> cannot legally nest another. A component rather than a render
// helper because useRowMenu is a hook. Rows with no `target` (Current) render
// without the affordance or the menu gestures. A running row keeps both: the
// trash is disabled (the gateway refuses a delete mid-turn anyway) but renaming
// or pairing a conversation is exactly what you want WHILE it works.
function SessionRow({ className, onOpen, target, running, active, pinned, onAskDelete, onMenu, children }: {
  className: string; onOpen: () => void;
  target?: RowTarget; running?: boolean; active?: boolean; pinned?: boolean;
  onAskDelete: (t: RowTarget) => void;
  onMenu: (t: RowTarget, x: number, y: number) => void;
  children: React.ReactNode;
}) {
  const menu = useRowMenu((x, y) => { if (target) onMenu(target, x, y); });
  return (
    <div className="sess-row">
      {/* The badge lives here, not inside each caller's children, because every
          row that can be pinned is a row that has a `target` — which is exactly
          what SessionRow already gates its other affordances on. */}
      <button className={className} onClick={onOpen} aria-current={active ? "true" : undefined} {...(target ? menu : {})}>
        {pinned && <span className="sess-pin" title="Pinned" aria-label="Pinned"><IconPin filled /></span>}
        {children}
      </button>
      {target && (
        <button className="sess-del" title="Delete conversation" aria-label="Delete conversation"
          disabled={running} onClick={() => onAskDelete(target)}><IconTrash /></button>
      )}
    </div>
  );
}
// The row's right-click / long-press menu: FileMenu's sheet-or-dropdown
// pattern with a single destructive action.
const MENU_W = 214;
const MENU_H = 334; // header + 6 rows: Open as side chat / Pin / Archive / Rename / Hide folder / Delete
const SHEET_QUERY = "(max-width: 640px)"; // matches .wf-menu's own sheet breakpoint
function SessionRowMenu({ target, pinned, archived, onSideChat, onTogglePin, onRename, onArchive, onHideFolder, onDelete, onClose }: {
  target: RowTarget & { x: number; y: number };
  pinned: boolean;
  archived?: boolean;
  onSideChat?: () => void; onTogglePin: () => void; onRename: () => void; onArchive?: () => void;
  onHideFolder?: () => void; onDelete?: () => void; onClose: () => void;
}) {
  // Read once, on open: the menu lives for a few seconds and a device does not
  // cross the breakpoint inside them.
  const [sheet] = useState(() => !!window.matchMedia?.(SHEET_QUERY).matches);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Inline positioning only in the dropdown case: as a sheet the stylesheet
  // owns the geometry, and a left/top here would override it.
  const style = sheet ? undefined : {
    left: Math.max(8, Math.min(target.x, window.innerWidth - MENU_W - 8)),
    top: Math.max(8, Math.min(target.y, window.innerHeight - MENU_H - 8)),
  };
  return (
    <>
      <div className="wf-menu-scrim" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={"wf-menu" + (sheet ? " sheet" : "")} style={style} role="menu" aria-label={rowLabel(target)}>
        <div className="wf-menu-head"><div className="nm">{rowLabel(target)}</div></div>
        {/* First because it's the only row that opens something rather than
            administering it — and it's offered only when the pairing is possible
            at all (same agent, resumable, a real conversation to sit beside). */}
        {onSideChat && (
          <button className="wf-menu-row" role="menuitem" onClick={onSideChat}>
            <IconSideChat /><span>Open as side chat</span>
          </button>
        )}
        {/* Above Rename because it's the only administering action that changes
            where the row LIVES rather than what it says. Offered on every row —
            unlike Hide folder and Open as side chat there is no case where a pin
            can't be honoured; the list is sorted client-side either way. */}
        <button className="wf-menu-row" role="menuitem" onClick={onTogglePin}>
          <IconPin filled={pinned} /><span>{pinned ? "Unpin conversation" : "Pin conversation"}</span>
        </button>
        <button className="wf-menu-row" role="menuitem" onClick={onRename}>
          <IconPencil /><span>Rename conversation</span>
        </button>
        {/* Keeps the transcript (unlike Delete) but drops the row out of the
            default list; See more and search still surface it. */}
        {onArchive && (
          <button className="wf-menu-row" role="menuitem" onClick={onArchive}>
            <IconArchive /><span>{archived ? "Unarchive conversation" : "Archive conversation"}</span>
          </button>
        )}
        {/* Only offered for a row from a folder other than the current one — same
            reason the folder header's hide affordance skips it (see below). */}
        {onHideFolder && (
          <button className="wf-menu-row" role="menuitem" onClick={onHideFolder}>
            <IconHide /><span>Hide folder “{basename(target.cwd)}”</span>
          </button>
        )}
        {/* Withheld while the conversation is running, same as the row's trash:
            the gateway refuses the delete and all the row would get is a tip. */}
        {onDelete && (
          <button className="wf-menu-row danger" role="menuitem" onClick={onDelete}>
            <IconTrash /><span>Delete conversation</span>
          </button>
        )}
      </div>
    </>
  );
}
export function Sidebar({ open, onClose, onOpenPicker, focusSearch = 0 }: { open: boolean; onClose: () => void; onOpenPicker: () => void; focusSearch?: number }) {
  const s = useStore();
  const [items, setItems] = useState<TaggedHistory[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [discovered, setDiscovered] = useState<TaggedDiscoveredHistory[] | null>(null);
  // The list is one list now — no Recent/Conversations tabs (§1.3). What the
  // reader chooses is the VIEW over it, and that choice is theirs to keep:
  // local, not the cross-device prefs KV, because a phone and a desktop want
  // different views of the same sessions (§4.3).
  const [view, setView] = useState<SessionsView>(readSessionsView);
  const [viewMenu, setViewMenu] = useState(false);
  // Folders the reader has toggled away from their default state (see
  // sessionsView.ts) — NOT a list of collapsed folders.
  const [folderFlips, setFolderFlips] = useState<Set<string>>(readFolderOverrides);
  // In-memory only, by design: neither localStorage nor the cross-device `meta` KV
  // that holds text_size/screen_lock. A sticky custom range that silently applies
  // to the next search is worse than re-picking it.
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [searchRes, setSearchRes] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  // Width is applied inline, so it must only exist in column mode — below the
  // breakpoint the panel is an overlay sheet whose width the stylesheet owns,
  // and an inline value would override it.
  const [width, setWidth] = useState(readSidebarWidth);
  const [desktop, setDesktop] = useState(isDesktopSidebarWidth);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP_SIDEBAR_QUERY);
    if (!mq) return;
    // Re-clamp on resize too: a width chosen on a wide window would otherwise
    // leave no room for the chat after the window shrinks.
    const sync = () => { setDesktop(mq.matches); setWidth((w) => clampSidebarWidth(w)); };
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => { mq.removeEventListener("change", sync); window.removeEventListener("resize", sync); };
  }, []);
  // Every content search — debounced or cursor-resumed — stamps a generation, and
  // only a response whose stamp is still current is allowed to reach state. A
  // resumed page can take seconds, so without this it could land after the query
  // was erased (resurrecting results under an empty box), after a newer query
  // resolved (overwriting it with the old term's pages), or after unmount.
  const searchGen = useRef(0);
  // Only so clearing the box can hand focus back to it — a clear that also
  // dismisses the keyboard costs a second tap to type the next term.
  const searchRef = useRef<HTMLInputElement>(null);
  // Cmd-Shift-F (App owns the key) lands here. The counter starts at 0 so a
  // plain mount doesn't steal focus, and App reveals the panel in the same
  // event, so the column is no longer display:none by the time this runs.
  useEffect(() => { if (focusSearch) searchRef.current?.focus(); }, [focusSearch]);
  // The gateway marks agents with no native history reader as history:false.
  // Missing flag (dev fallback, older gateway) = supported.
  const agentByName = new Map(s.cfg.agents.map((a) => [a.name, a] as const));
  const multiAgent = s.cfg.agents.length >= 2;
  // The sidebar is now shared across agents: Conversations merges every
  // history-capable agent's sessions for the current folder, and Recent merges
  // every resumable agent's recents. The active agent still gates the local
  // "Current" fallback (in-memory sessions for agents that can't load history).
  const histAgentNames = s.cfg.agents.filter((a) => a.history !== false).map((a) => a.name);
  const discoverAgentNames = s.cfg.agents
    .filter((a) => a.history !== false && discoverable(a))
    .map((a) => a.name);
  const anyHistSupported = histAgentNames.length > 0;
  const agentRef = agentByName.get(s.agentName);
  const histSupported = agentRef?.history !== false;
  const localRecentSupported = recentReopenable(agentRef);
  // Fetch on mount + cwd change + (re)open, across every history-capable agent and
  // merged by recency. Not gated on `open` because on desktop the panel is
  // persistent (always visible), not a toggle overlay. Agent switching does NOT
  // refetch — the list is unified — so it stays put when you flip agents.
  const histAgentsKey = histAgentNames.join(",");
  const discoverAgentsKey = discoverAgentNames.join(",");
  function loadHistory(reset: boolean) {
    if (reset) { setItems(null); setErr(false); setShowMore(false); }
    if (!anyHistSupported) { setItems([]); return; }
    Promise.all(
      histAgentNames.map((name) =>
        getHistory(name, s.cwd)
          .then((list) => list.map((it): TaggedHistory => ({ ...it, agentName: name })))
          .catch(() => null)),
    ).then((lists) => {
      // All agents failed → surface the error; otherwise show whatever loaded.
      if (lists.every((l) => l === null)) { setErr(true); return; }
      const merged = lists.flat().filter((it): it is TaggedHistory => it !== null)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setItems(merged);
      s.mergeHistoryTitles(merged);
    });
  }
  function loadDiscovered(reset: boolean) {
    if (reset) setDiscovered(null);
    if (!discoverAgentNames.length) { setDiscovered([]); return; }
    Promise.all(
      discoverAgentNames.map((name) =>
        getDiscoveredHistory(name)
          .then((list) => list.map((it): TaggedDiscoveredHistory => ({ ...it, agentName: name })))
          .catch(() => null)),
    ).then((lists) => {
      if (lists.every((l) => l === null)) { setDiscovered([]); return; }
      const merged = lists.flat().filter((it): it is TaggedDiscoveredHistory => it !== null)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setDiscovered(merged);
      s.mergeHistoryTitles(merged);
    });
  }
  useEffect(() => { loadHistory(true); loadDiscovered(true); }, [open, s.cwd, histAgentsKey, discoverAgentsKey]);
  // Reopening collapses the list back to the first few rows and clears the
  // search. The filters reset with it: they're deliberately unpersisted, and the
  // panel stays mounted while closed (desktop keeps it as a column), so nothing
  // else would ever drop them. The VIEW is not reset — it is a saved preference.
  useEffect(() => { if (open) { setShowMore(false); setQ(""); setFilters(DEFAULT_FILTERS); } }, [open]);
  const pickView = (next: SessionsView) => { setView(next); saveSessionsView(next); setViewMenu(false); };
  const toggleFolder = (key: string) => setFolderFlips((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    saveFolderOverrides(next);
    return next;
  });
  // refresh the list in place (no loading flash) when something renames a session
  useEffect(() => {
    if (s.historyNonce === 0) return;
    loadHistory(false);
    loadDiscovered(false);
  }, [s.historyNonce]);

  // Tier 2: the server content search. Tier 1 (the local title filter above it) stays
  // instant and untouched — this only ADDS the matches a title filter cannot see.
  useEffect(() => {
    // A term takes over the whole panel (the tab strip gives way to results),
    // so no scan is ever spent on a hidden query. Deliberately NOT gated on
    // `open`: above 860px the panel is a persistent column, so `open` is false
    // there for a panel the user is looking at, and an `open` gate would kill
    // search on desktop entirely.
    const term = q.trim();
    const gen = ++searchGen.current;
    // Clearing `searching` here too: without it, backspacing from a pending query
    // down to one character strands the spinner with no request left to answer it.
    if (term.length < MIN_SEARCH_LEN) { setSearchRes(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchSessions(term, filtersToOptions(filters, s.cwd, Date.now()))
        .then((r) => { if (gen === searchGen.current) setSearchRes(r); })
        .catch(() => { if (gen === searchGen.current) setSearchRes(null); })
        .finally(() => { if (gen === searchGen.current) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    // Drops a queued query a later keystroke or filter change has outdated, and
    // retires this generation so nothing already in flight — from here or from the
    // cursor-resume below — can still write state, including after unmount.
    return () => { clearTimeout(t); searchGen.current++; };
  }, [q, filters, s.cwd]);

  // Running indicator, reusing the polled runningTasks. Rows can belong to any
  // agent now, so match on agent + sessionId (a bare sessionId could collide
  // across agents).
  const runningById = new Map(
    s.runningTasks.map((t) => [t.agentName + "\n" + t.sessionId, t.state] as const),
  );
  // A prompt waiting on an answer, anywhere. The durable inbox spans every agent
  // and survives a reload, so it — not the live SSE state — is what says a row
  // needs you.
  const needsYouKeys = new Set(
    s.inboxItems.filter((it) => it.reqId != null && it.sessionId).map((it) => it.agentName + "\n" + it.sessionId),
  );
  // Turns that finished with nobody reading them — the same durable inbox, minus
  // the half that wants an answer. Server-side, so a run started on another
  // device marks the row here too.
  const unreadKeys = new Set(
    s.inboxItems.filter((it) => it.type === "task_done" && it.sessionId).map((it) => it.agentName + "\n" + it.sessionId),
  );
  const runDot = (agentName: string, id: string) => {
    const state = runningById.get(agentName + "\n" + id);
    // Awaiting input isn't "working", so keep it as a static attention dot;
    // the spinner is reserved for actively-running sessions. Amber is the one
    // colour that means "needs you" (§1.1), whether the gateway said so through
    // /running or through the durable inbox.
    if (state === "awaiting-input" || needsYouKeys.has(agentName + "\n" + id))
      return <span className="run-dot awaiting" title="Needs input" />;
    // Nothing is happening in it, but something happened while you were away:
    // the same ink dot the working state uses, held still. Amber stays reserved
    // for a turn that is actually blocked on you (§1.1).
    if (!state) return unreadKeys.has(agentName + "\n" + id)
      ? <span className="run-dot unread" title="Finished — not read yet" />
      : null;
    return <span className="run-working" title="Working"><WorkingDots /></span>;
  };
  // Per-row identity: the agent's own glyph. A wordmark reads as one more
  // word in a list that is already all words, and at this density the mark is
  // what the eye picks a row out by — so §1.2's wordmark rule is relaxed here
  // and only here. An agent with no glyph of its own still gets its name.
  const mark = (agentName: string) => {
    if (!multiAgent) return null;
    const agent = agentByName.get(agentName);
    // Same classification the agent glyph used, kept so anything keying off
    // "which agent is this row" still can.
    const kind = agent?.skin === "codex" ? "codex" : agent?.kind === "opencode" ? "opencode"
      : agent?.name === "claude" ? "claude" : "mono";
    return (
      <span className={"mark who " + kind} title={agentName}>
        {kind === "codex" ? <CodexMark />
          : kind === "opencode" ? <OpencodeMark />
            : kind === "claude" ? <Robot />
              : <span className="wm">{agentName}</span>}
      </span>
    );
  };

  const allItems = items || [];
  // A Recent row carries the title that was current when the conversation was last
  // touched — a snapshot, which drifts from the gateway's title (renames, agent
  // thread names, JSONL-derived) and is the stalest thing on this panel. Both
  // freshly-fetched lists are authoritative, so mirror them here: discovery spans
  // every folder (and now carries renames too), the current folder's own list is
  // laid over it as the more specific answer. Keyed by agent + id — NOT by folder,
  // since a recents row can spell the same cwd differently than the gateway does —
  // so a cross-agent id collision still can't borrow the wrong title.
  const historyTitleById = new Map<string, string | null>();
  for (const it of discovered || []) historyTitleById.set(it.agentName + "\n" + it.sessionId, it.title);
  for (const it of allItems) historyTitleById.set(it.agentName + "\n" + it.sessionId, it.title);
  // Running tasks (polled from the gateway across agents/devices) get their own
  // pinned section at the top of Recent. `active` are live tasks in stable start
  // order — the /running array order is the gateway task-map insertion order (≈ when
  // each task started) and does NOT re-sort on activity. `cooling` are ones that
  // finished within the grace window and linger so a session doesn't flip-flop
  // between Running and Recent across turns. Keeping both OUT of the recency-sorted
  // list below is what stops that list from flapping while sessions stream frames.
  const { active: activeTasks, cooling: coolingTasks } = runningView(s.runningTasks, s.runningSeen, Date.now());
  const runningKeys = new Set([...activeTasks, ...coolingTasks.map((c) => c.task)].map((t) => t.agentName + "\n" + t.sessionId));
  const isRunning = (agentName: string, sessionId: string) => runningKeys.has(agentName + "\n" + sessionId);
  // Conversations the reader pinned, keyed the same way every other per-row set
  // here is. Server-side state (see store.pinnedSessions) so a pin set on the
  // phone is already on top when the desktop loads.
  const pinnedKeys = new Set(s.pinnedSessions);
  const isPinned = (agentName: string, sessionId: string) => pinnedKeys.has(agentName + "\n" + sessionId);
  // The one conversation the main view is showing — the marker every row type
  // uses, so exactly one row can wear it. Merely being open in memory is not it:
  // several sessions are, and lighting them all up is what made the current one
  // impossible to pick out. Agent-scoped because a bare id can collide across
  // agents; NOT cwd-scoped, since a recents row can spell the same folder
  // differently than the gateway does.
  const isCurrent = (agentName: string, sessionId: string) =>
    s.agentName === agentName && s.activeId === sessionId;
  // Archived conversations, keyed the same way rows are. They leave the default
  // list (See more brings them back, dimmed) but the transcript stays put, so
  // both search tiers still surface them untouched.
  const archivedSet = new Set(s.archivedSessions);
  const isArchived = (agentName: string, sessionId: string) => archivedSet.has(agentName + "\n" + sessionId);
  const archivedCls = (agentName: string, sessionId: string) => (isArchived(agentName, sessionId) ? " archived" : "");
  // Local Recent entries need session/load to be reopenable, so list only recents
  // whose owning agent still reports it — across ALL agents, not just the active one.
  // Default to the first RECENT_LIMIT; "See more" reveals the rest of the cache.
  const allRecentItems = s.recentSessions
    .filter((it) => recentReopenable(agentByName.get(it.agentName)))
    .filter((it) => !isRunning(it.agentName, it.sessionId));
  const recentKeys = new Set(s.recentSessions.map((it) => it.agentName + "\n" + it.cwd + "\n" + it.sessionId));
  // Sessions discovered from CLI transcripts fold into the same Recent list (no
  // separate section): dedupe against the recents cache, then interleave by
  // last-activity time so they read as one timeline.
  const discoveredExtras = (discovered || [])
    .filter((it) => recentReopenable(agentByName.get(it.agentName)))
    .filter((it) => !recentKeys.has(it.agentName + "\n" + it.cwd + "\n" + it.sessionId))
    .filter((it) => !isRunning(it.agentName, it.sessionId));
  const currentItems = !localRecentSupported && histSupported
    ? Object.values(s.sessions)
      .filter((it) => !it.viewOnly && it.hasContent)
      .filter((it) => !isRunning(s.agentName, it.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RECENT_LIMIT)
    : [];
  const queriedItems = allItems.filter((it) => matchesQuery(it, q));
  const visibleItems = showMore ? queriedItems : queriedItems.filter((it) => withinRecentWindow(it.updatedAt));
  const hasOlderItems = queriedItems.some((it) => !withinRecentWindow(it.updatedAt));
  // "The user already asked for this range, so widening it would discard what they
  // asked for" — and `all` is the widest range there is. Leaving `all` out makes the
  // 搜尋全部 button re-run the identical query forever and the resume cursor dead code.
  const rangeExplicit = filters.window === "custom" || filters.window === "all";
  const hasServerHits = (searchRes?.results.length ?? 0) > 0;
  // A term takes over the panel from the first character (the instant tier-1
  // title filter), replacing the tab strip with the results list; clearing the
  // box hands back whichever tab was active.
  const searchOpen = q.trim().length > 0;
  // Delete is two-step everywhere: the trash (or menu row) only nominates a
  // target; the fixed confirm card is what actually calls the store.
  const [confirmDel, setConfirmDel] = useState<RowTarget | null>(null);
  const [rowMenu, setRowMenu] = useState<(RowTarget & { x: number; y: number }) | null>(null);
  // Rename uses the confirm card's shape rather than an input in the row: below
  // 860px this panel is a near-full-height sheet, so an in-place box on a row
  // near the bottom lands under the on-screen keyboard, and the long press that
  // would open it is a timer callback — iOS routinely declines to raise the
  // keyboard for a focus that no tap asked for. The card is top-anchored and is
  // reached by TAPPING a menu row, so both problems go away.
  const [renaming, setRenaming] = useState<RowTarget | null>(null);
  const [draft, setDraft] = useState("");
  // Prefilled with the REAL title, so an unnamed conversation opens an empty box:
  // rows fall back to a short session id for display, and saving that would
  // persist the id as the conversation's name.
  const startRename = (t: RowTarget) => { setDraft(t.name); setRenaming(t); };
  const rowActions = {
    onAskDelete: setConfirmDel,
    onMenu: (t: RowTarget, x: number, y: number) => setRowMenu({ ...t, x, y }),
  };
  const renderItem = (it: TaggedHistory, variant: "recent" | "all" = "all") => {
    const active = isCurrent(it.agentName, it.sessionId);
    return (
      <SessionRow key={variant + ":" + it.agentName + ":" + it.sessionId}
        className={"sess-item" + (active ? " active" : "") + (variant === "recent" ? " recent" : "") + archivedCls(it.agentName, it.sessionId)}
        onOpen={() => { s.openHistorySession({ sessionId: it.sessionId, title: it.title, agentName: it.agentName, cwd: s.cwd }); onClose(); }}
        target={{ sessionId: it.sessionId, agentName: it.agentName, cwd: s.cwd, name: it.title || "" }}
        running={isRunning(it.agentName, it.sessionId)} active={active}
        pinned={isPinned(it.agentName, it.sessionId)} {...rowActions}>
        {runDot(it.agentName, it.sessionId)}
        {mark(it.agentName)}
        <span className="name">{it.title || it.sessionId.slice(0, 8)}</span>
        <span className="when">{it.updatedAt ? timeAgo(it.updatedAt) : ""}</span>
      </SessionRow>
    );
  };
  // coolingAt set → the task finished within the grace window: a muted "recently
  // active" dot and a relative time instead of the live spinner/state label.
  const renderRunningItem = (t: RunningTask, coolingAt?: number) => {
    // Title/folder come from the shared resolver (gateway cwd first, recents/live as
    // fallback) — the same one jumpToTask uses, so the label can't drift from where
    // the click lands. jumpToTask resolves the agent/folder and opens it.
    const { title, cwd } = resolveRunningTask(t, s);
    const active = isCurrent(t.agentName, t.sessionId);
    return (
      <SessionRow key={"running:" + t.agentName + ":" + t.sessionId}
        className={"sess-item recent with-folder" + (active ? " active" : "")}
        onOpen={() => { s.jumpToTask(t); onClose(); }}
        // The resolver's folder, falling back to the one on screen exactly as the
        // row's `push()` does. `title || ""` and never the short-id label below
        // it: that fallback is display-only and must not reach a rename box.
        target={{ sessionId: t.sessionId, agentName: t.agentName, cwd: cwd || s.cwd, name: title || "" }}
        running={isRunning(t.agentName, t.sessionId)} active={active} {...rowActions}>
        {/* Cooling only speaks for a turn with nothing to say: an unread finish (or
            a prompt still waiting) is the more actionable statement, and burying
            it under the muted ring for the length of the grace window is what
            made the just-finished state unreadable. */}
        {runDot(t.agentName, t.sessionId)
          ?? (coolingAt === undefined ? null : <span className="run-dot cooling" title="Recently active" />)}
        {mark(t.agentName)}
        <span className="sess-main">
          <span className="name">{title || t.sessionId.slice(0, 8)}</span>
          {cwd && <span className="folder-name">{basename(cwd)}</span>}
        </span>
        <span className="when">
          {coolingAt === undefined
            ? (t.state === "awaiting-input" ? "Needs input" : "Working")
            : timeAgo(new Date(coolingAt).toISOString())}
        </span>
      </SessionRow>
    );
  };
  const renderRecentItem = (it: RecentSession) => {
    const active = isCurrent(it.agentName, it.sessionId);
    // Present in a freshly-fetched list → defer to the gateway title (matching
    // renderItem's fallback exactly, including null); otherwise the cached snapshot.
    const histKey = it.agentName + "\n" + it.sessionId;
    const named = (historyTitleById.has(histKey) ? historyTitleById.get(histKey) : it.title) || "";
    const title = named || it.sessionId.slice(0, 8);
    return (
      <SessionRow key={"recent:" + it.agentName + ":" + it.cwd + ":" + it.sessionId}
        className={"sess-item recent with-folder" + (active ? " active" : "") + archivedCls(it.agentName, it.sessionId)}
        // Opened with the name on screen, not the snapshot behind it: the opened
        // session carries that title in memory and offers it back on every activity
        // touch, so handing it the stale one is how the stale one gets re-recorded.
        // `named`, not `title` — the short-id display fallback is not a name.
        onOpen={() => { void s.openRecentSession(named ? { ...it, title: named } : it); onClose(); }}
        // `named`, not `title`, for the same reason the open above uses it: the
        // short-id display fallback is not a name, and a rename box must not be
        // prefilled with one.
        target={{ sessionId: it.sessionId, agentName: it.agentName, cwd: it.cwd, name: named }}
        running={isRunning(it.agentName, it.sessionId)} active={active}
        pinned={isPinned(it.agentName, it.sessionId)} {...rowActions}>
        {runDot(it.agentName, it.sessionId)}
        {mark(it.agentName)}
        <span className="sess-main">
          <span className="name">{title}</span>
          <span className="folder-name">{basename(it.cwd)}</span>
        </span>
        <span className="when">{it.lastActiveAt ? timeAgo(it.lastActiveAt) : ""}</span>
      </SessionRow>
    );
  };
  const renderDiscoveredItem = (it: TaggedDiscoveredHistory) => {
    const active = isCurrent(it.agentName, it.sessionId);
    return (
      <SessionRow key={"discovered:" + it.agentName + ":" + it.cwd + ":" + it.sessionId}
        className={"sess-item recent with-folder" + (active ? " active" : "") + archivedCls(it.agentName, it.sessionId)}
        onOpen={() => { void s.openHistorySession({ sessionId: it.sessionId, title: it.title, agentName: it.agentName, cwd: it.cwd }); onClose(); }}
        target={{ sessionId: it.sessionId, agentName: it.agentName, cwd: it.cwd, name: it.title || "" }}
        running={isRunning(it.agentName, it.sessionId)} active={active}
        pinned={isPinned(it.agentName, it.sessionId)} {...rowActions}>
        {runDot(it.agentName, it.sessionId)}
        {mark(it.agentName)}
        <span className="sess-main">
          <span className="name">{it.title || it.sessionId.slice(0, 8)}</span>
          <span className="folder-name">{basename(it.cwd)}</span>
        </span>
        <span className="when">{it.updatedAt ? timeAgo(it.updatedAt) : ""}</span>
      </SessionRow>
    );
  };
  const renderCurrentItem = (it: typeof currentItems[number]) => {
    const active = isCurrent(s.agentName, it.id);
    return (
      <button className={"sess-item recent" + (active ? " active" : "")} key={"current:" + it.id}
        aria-current={active ? "true" : undefined}
        onClick={() => { s.selectSession(it.id); onClose(); }}>
        {runDot(s.agentName, it.id)}
        {mark(s.agentName)}
        <span className="name">{sessionTitle(it.id, it.title)}</span>
        <span className="when">{timeAgo(new Date(it.createdAt).toISOString())}</span>
      </button>
    );
  };
  // ---- one list, two views (§3 P4) ----
  // Every source folds into the same row shape so the ordering and the grouping
  // live in one pure place (lib/sessionGroups) instead of once per section.
  // First source to claim a session wins: a running task knows more about it
  // than the recents cache, which knows more than a discovered transcript.
  const awaitingKeys = new Set(
    s.runningTasks.filter((t) => t.state === "awaiting-input").map((t) => t.agentName + "\n" + t.sessionId),
  );
  const rows: Array<GroupableRow<React.ReactNode>> = [];
  const claimed = new Set<string>();
  const push = (agentName: string, sessionId: string, cwd: string, when: string | number, node: React.ReactNode, running: boolean) => {
    const key = agentName + "\n" + sessionId;
    if (claimed.has(key)) return;
    claimed.add(key);
    const ms = typeof when === "number" ? when : new Date(when).getTime();
    rows.push({
      key, cwd, when: Number.isFinite(ms) ? ms : 0, running,
      needsYou: needsYouKeys.has(key) || awaitingKeys.has(key),
      unread: unreadKeys.has(key),
      pinned: pinnedKeys.has(key),
      data: node,
    });
  };
  // One `now` for every live task, not one per row: the pinned block sorts by
  // `when` and Array#sort is stable, so equal stamps preserve the /running
  // array's own order — which is roughly start order and deliberately does NOT
  // re-sort on activity, so the list can't flap between concurrent streams.
  const now = Date.now();
  for (const t of activeTasks) push(t.agentName, t.sessionId, resolveRunningTask(t, s).cwd || s.cwd, now, renderRunningItem(t), true);
  // A cooling task counts as running for ordering — that is the whole point of
  // the grace window: it keeps the row pinned (and its folder's dot lit) for a
  // few seconds instead of dropping it into the recency list the moment a turn
  // ends, which is what made rows flip-flop between sections. It still renders
  // with the muted "recently active" dot, and it sorts below the live ones
  // because its `when` is the finish time rather than `now`.
  for (const c of coolingTasks) push(c.task.agentName, c.task.sessionId, resolveRunningTask(c.task, s).cwd || s.cwd, c.at, renderRunningItem(c.task, c.at), true);
  for (const it of allRecentItems) push(it.agentName, it.sessionId, it.cwd, it.lastActiveAt, renderRecentItem(it), false);
  for (const it of discoveredExtras) push(it.agentName, it.sessionId, it.cwd, it.updatedAt, renderDiscoveredItem(it), false);
  // The current folder's server-side history used to be a tab of its own; it is
  // the same list, so it joins it. The two-day window is still what "See more"
  // widens, it just widens one list now instead of one tab.
  for (const it of (showMore ? allItems : allItems.filter((x) => withinRecentWindow(x.updatedAt))))
    push(it.agentName, it.sessionId, s.cwd, it.updatedAt, renderItem(it), false);
  for (const it of currentItems) push(s.agentName, it.id, it.cwd || s.cwd, it.createdAt, renderCurrentItem(it), false);
  const home = homeFrom(s.cwd, s.cfg.fsRoot, s.cfg.agents[0]?.cwd);
  // Filtered once, here, so the qty count, hasMoreRows and both views below all
  // agree on the same list. This deliberately overrides sessionGroups.ts's
  // "must not sink out of sight" rule — a hidden folder's rows disappear even
  // when running or needing you — because hiding is explicit (chosen from the
  // folder's own header or a row menu), the durable inbox still surfaces those
  // prompts elsewhere,
  // and the "N hidden" affordance in .sb-head keeps the cut non-silent.
  // Archived rows leave the default list the same way old rows do: "See more"
  // brings them back (dimmed, via .archived). Filtered before hideFolders so
  // the "N hidden" count keeps meaning folders only.
  const archivedRowCount = rows.reduce((n, r) => n + (archivedSet.has(r.key) ? 1 : 0), 0);
  const listedRows = showMore ? rows : rows.filter((r) => !archivedSet.has(r.key));
  const visibleRows = hideFolders(listedRows, s.hiddenFolders, s.cwd, home);
  const hiddenCount = listedRows.length - visibleRows.length;
  // The cap applies to the flat view only: by folder, hiding rows would leave a
  // folder header claiming a count its children don't add up to. Archived rows
  // keep the toggle alive too — it is their only way back on screen.
  const hasMoreRows = visibleRows.length > RECENT_LIMIT || allItems.some((it) => !withinRecentWindow(it.updatedAt))
    || archivedRowCount > 0;
  const folders = groupByFolder(visibleRows, s.cwd, home);
  const { pinned, rest } = latestWithPinned(visibleRows);
  const latestRest = showMore ? rest : rest.slice(0, RECENT_LIMIT);
  // Split the flat recency list into "just happened" and "sometime since" so a
  // long tail of quiet sessions doesn't read as one undifferentiated wall.
  const { fresh, older } = splitByAge(latestRest, now);
  const listEmpty = visibleRows.length === 0;

  return (
    <>
      <div id="scrim" className={open ? "open" : ""} onClick={onClose} />
      <div id="panel" className={(open ? "open" : "") + (s.sidebarOpen ? "" : " collapsed")}
        style={desktop ? { width, maxWidth: width } : undefined}>
        {desktop && <ResizeHandle className="sb-resize" label="Resize the sidebar" edge="right" axis="x"
          size={width} min={MIN_SIDEBAR_WIDTH} max={MAX_SIDEBAR_WIDTH} clamp={clampSidebarWidth}
          onSize={setWidth} onCommit={saveSidebarWidth} />}
        <div className="folder-bar" title={s.cwd} onClick={() => { onOpenPicker(); onClose(); }}>
          <span className="fi"><IconFolder /></span>
          <span className="meta"><span className="lbl">Folder</span><span className="name">{basename(s.cwd)}</span></span>
          <span className="chev"><IconChevron /></span>
        </div>
        {!anyHistSupported && (
          <div className="all-section">
            <div className="sess-list">
              <div className="panel-empty">Conversation history isn't available for this agent.</div>
            </div>
          </div>
        )}
        {anyHistSupported && (
          <>
            {/* Above the tabs so searching is reachable from both of them. */}
            <div className="search">
              <input ref={searchRef} placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
              {/* Backspacing out a term is the other way back to the list, and
                  on a phone it is a dozen taps on the key that also dismisses
                  nothing. */}
              {q && (
                <button type="button" className="search-clear" title="Clear search" aria-label="Clear search"
                  onClick={() => { setQ(""); searchRef.current?.focus(); }}><IconX /></button>
              )}
            </div>
            {searchOpen && (
              <SearchFilters value={filters} agents={s.cfg.agents.map((a) => a.name)} onChange={setFilters} />
            )}
            {!searchOpen && (
              <>
                {/* The view is the reader's choice and it says which one it is
                    in words, so nothing has to be learned from an icon. */}
                <div className="sb-head">
                  <span>Sessions</span>
                  <span className="qty">{visibleRows.length}</span>
                  {/* Non-silent truncation: hiding is explicit, but a count
                      that vanishes without a trace would read as a bug.
                      Hidden folders are now managed in the folder picker. */}
                  {hiddenCount > 0 && (
                    <button type="button" className="view-btn" onClick={() => { onOpenPicker(); onClose(); }}>
                      {hiddenCount} hidden
                    </button>
                  )}
                  <span className="sp" />
                  <div className="view-wrap">
                    <button className="view-btn" aria-haspopup="menu" aria-expanded={viewMenu}
                      onClick={() => setViewMenu((v) => !v)}>
                      <span className="vlabel">{view === "folder" ? "folder" : "latest"}</span><IconChevronDown />
                    </button>
                    {viewMenu && (
                      <>
                        <div className="amenu-scrim" onClick={() => setViewMenu(false)} />
                        <div className="view-menu" role="menu">
                          <button className="view-item" role="menuitem" onClick={() => pickView("folder")}>
                            <span className="tick">{view === "folder" && <IconCheck />}</span>By folder
                          </button>
                          <button className="view-item" role="menuitem" onClick={() => pickView("latest")}>
                            <span className="tick">{view === "latest" && <IconCheck />}</span>Latest updated
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <div className="recent-tab sess-list">
                  {listEmpty && <div className="panel-empty">No recent conversations yet.</div>}
                  {!listEmpty && view === "folder" && folders.map((g) => {
                    // Open by default when you are in it or something in it is
                    // running / waiting on you; collapsed otherwise. The stored
                    // set flips that, so a folder that starts running opens on
                    // its own and one you deliberately shut stays shut.
                    const shut = (g.current || g.running || g.needsYou) === folderFlips.has(g.key);
                    return (
                      <div className="folder-group" key={g.key}>
                        <button className={"fgroup" + (shut ? " closed" : "")} title={g.cwd}
                          aria-expanded={!shut} onClick={() => toggleFolder(g.key)}>
                          <span className="tw"><IconChevronDown /></span>
                          <span className="fi"><IconFolder /></span>
                          <span className="fname">{g.label}</span>
                          <span className="fcount">{g.rows.length}</span>
                          {/* One dot for the whole folder, in the row dots' own
                              precedence: blocked on you beats working beats
                              something-to-read. A collapsed folder is the only
                              place its conversations' state can show. */}
                          {(g.needsYou || g.running || g.unread) && (
                            <span className={"run-dot" + (g.needsYou ? " awaiting" : g.running ? "" : " unread")}
                              title={g.needsYou ? "Needs input" : g.running ? "Working" : "Finished — not read yet"} />
                          )}
                          {/* New chat in this group's folder: the current one gets the
                              optimistic newSession(); any other goes through setCwd, which
                              adopts that folder and starts a fresh session there. */}
                          <span className="new" role="button" aria-label="New chat"
                            onClick={(e) => { e.stopPropagation(); if (g.current) void s.newSession(); else s.setCwd(g.cwd); onClose(); }}>
                            <IconPlus />
                          </span>
                          {/* hideFolders() always exempts the folder you're working in, so
                              a toggle here would look broken — offer it on every group but
                              this one. `.fgroup` is itself a <button>, so this is a <span
                              role="button">, same as the folder picker's `.arow .hide`. */}
                          {!g.current && (
                            <span className="hide" role="button" aria-label="Hide folder"
                              onClick={(e) => { e.stopPropagation(); s.toggleHiddenFolder(g.cwd); }}>
                              <IconHide />
                            </span>
                          )}
                        </button>
                        {!shut && <div className="fkids recent-list">{g.rows.map((r) => r.data)}</div>}
                      </div>
                    );
                  })}
                  {!listEmpty && view === "latest" && (
                    <>
                      {pinned.length > 0 && (
                        <div className="running-section recent-section">
                          <div className="listhead"><span>Pinned · Needs you · Running</span></div>
                          <div className="recent-list">{pinned.map((r) => r.data)}</div>
                          <div className="pin-div" />
                        </div>
                      )}
                      {fresh.length > 0 && (
                        <div className="recent-section">
                          <div className="listhead"><span>Last hour</span></div>
                          <div className="recent-list">{fresh.map((r) => r.data)}</div>
                        </div>
                      )}
                      {older.length > 0 && (
                        <div className="recent-section">
                          <div className="listhead"><span>Earlier</span></div>
                          <div className="recent-list">{older.map((r) => r.data)}</div>
                        </div>
                      )}
                    </>
                  )}
                  {!listEmpty && hasMoreRows && (
                    <button className="see-more" onClick={() => setShowMore((v) => !v)}>
                      {showMore ? "Show less" : "See more"}
                    </button>
                  )}
                  {err && <div className="panel-note">Couldn&apos;t load conversations.</div>}
                </div>
              </>
            )}
            {searchOpen && (
              <div className="all-section">
                <div className="sess-list">
                  {err && <div className="panel-empty">Couldn't load conversations.</div>}
                  {!err && items === null && <div className="panel-empty">Loading…</div>}
                  {/* The title filter's empty state would otherwise sit right on top of
                      the server's content hits, the two contradicting each other on screen. */}
                  {!err && items !== null && visibleItems.length === 0 && !hasServerHits && <div className="panel-empty">No conversations in this folder yet.</div>}
                  {visibleItems.map((it) => renderItem(it))}
                  {!err && items !== null && hasOlderItems && (
                    <button className="see-more" onClick={() => setShowMore((v) => !v)}>
                      {showMore ? "Show recent only" : "See more"}
                    </button>
                  )}
                  <SearchResults
                    response={searchRes}
                    loading={searching}
                    rangeExplicit={rangeExplicit}
                    onOpen={(r, index) => {
                      void s.openHistorySession({ sessionId: r.sessionId, title: r.title, agentName: r.agentName, cwd: r.cwd, atMessage: index });
                      onClose();
                    }}
                    onSearchAll={() => setFilters({ ...filters, window: "all" })}
                    onSearchOlder={() => {
                      // `searching` doubles as the re-entrancy guard: one page at a
                      // time, so a second click can't stack a duplicate scan.
                      const shown = searchRes;
                      if (!shown?.cursor || searching) return;
                      const gen = ++searchGen.current;
                      setSearching(true);
                      searchSessions(q.trim(), { ...filtersToOptions(filters, s.cwd, Date.now()), cursor: shown.cursor })
                        .then((more) => { if (gen === searchGen.current) setSearchRes({ ...more, results: [...shown.results, ...more.results] }); })
                        .catch(() => { /* keep the page already on screen */ })
                        .finally(() => { if (gen === searchGen.current) setSearching(false); });
                    }}
                  />
                </div>
              </div>
            )}
          </>
        )}
        {rowMenu && (
          <SessionRowMenu target={rowMenu} onClose={() => setRowMenu(null)}
            pinned={isPinned(rowMenu.agentName, rowMenu.sessionId)}
            onTogglePin={() => { s.togglePinnedSession(rowMenu.agentName, rowMenu.sessionId); setRowMenu(null); }}
            // Offered only when the store could actually honour it: a row under
            // another agent lives on a connection this page doesn't hold, an agent
            // that can't resume a session has nothing to open live, and there has
            // to be a real conversation on screen for it to sit beside — one that
            // isn't this same row. `name || null` because a row's `name` is "" when
            // the conversation has no title, and the short-id label the row shows
            // instead is display-only: persisting it would name the conversation
            // after its own id.
            onSideChat={rowMenu.agentName === s.agentName
              && s.cfg.agents.find((a) => a.name === rowMenu.agentName)?.sessionLoad !== false
              && !!s.activeId && !s.activeId.startsWith("pending-")
              && rowMenu.sessionId !== s.activeId
              ? () => {
                void s.openSideChat({
                  sessionId: rowMenu.sessionId, agentName: rowMenu.agentName,
                  cwd: rowMenu.cwd, title: rowMenu.name || null,
                });
                setRowMenu(null);
              }
              : undefined}
            onRename={() => { startRename(rowMenu); setRowMenu(null); }}
            // Always offered — archiving only hides the row from the default
            // list, so unlike Delete it is safe on a running conversation too,
            // and the same row is the way back out (Unarchive).
            archived={isArchived(rowMenu.agentName, rowMenu.sessionId)}
            onArchive={() => { s.toggleArchivedSession(rowMenu.agentName, rowMenu.sessionId); setRowMenu(null); }}
            // Same exemption as the folder header's hide affordance: hiding the
            // folder you're in wouldn't do anything visible (hideFolders() always
            // exempts it), so the row menu doesn't offer it there either.
            onHideFolder={folderKey(rowMenu.cwd, home) !== folderKey(s.cwd, home)
              ? () => { s.toggleHiddenFolder(rowMenu.cwd); setRowMenu(null); }
              : undefined}
            onDelete={isRunning(rowMenu.agentName, rowMenu.sessionId)
              ? undefined
              : () => { setConfirmDel(rowMenu); setRowMenu(null); }} />
        )}
        {renaming && (
          <>
            <div className="sess-confirm-scrim" onPointerDown={() => setRenaming(null)} />
            <form className="sess-confirm" role="dialog" aria-label="Rename conversation"
              onSubmit={(e) => {
                e.preventDefault();
                // Cleared on purpose is a valid save: it drops the custom title and
                // hands the name back to whatever the gateway derives. Spelled out
                // rather than spread — a target opened from the row menu also
                // carries that menu's coordinates.
                s.renameSession(draft, {
                  sessionId: renaming.sessionId, agentName: renaming.agentName, cwd: renaming.cwd,
                });
                setRenaming(null);
              }}>
              <div className="delete-title">Rename conversation</div>
              <div className="amenu-note">{rowLabel(renaming)} · {basename(renaming.cwd)}</div>
              <input className="rename-input" autoFocus value={draft} maxLength={120}
                placeholder="Conversation title" aria-label="Conversation title"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} />
              <div className="actions">
                <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
                <button type="submit" className="btn primary">Save</button>
              </div>
            </form>
          </>
        )}
        {confirmDel && (
          <>
            <div className="sess-confirm-scrim" onPointerDown={() => setConfirmDel(null)} />
            <div className="sess-confirm" role="dialog" aria-label="Delete conversation">
              <div className="delete-title">{rowLabel(confirmDel)}</div>
              <div className="amenu-note">
                Permanently deletes this conversation's transcript from the agent's own history.
                It can't be undone, and it won't be resumable from your terminal afterwards either.
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setConfirmDel(null)}>Cancel</button>
                <button className="btn danger"
                  onClick={() => { void s.deleteSession(confirmDel.sessionId); setConfirmDel(null); }}>Delete</button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
