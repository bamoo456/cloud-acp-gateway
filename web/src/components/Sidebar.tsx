import { useEffect, useRef, useState } from "react";
import { getHistory, getDiscoveredHistory, searchSessions, type HistorySession, type DiscoveredHistorySession, type RunningTask, type SearchResponse } from "../lib/api.ts";
import type { RecentSession } from "../lib/recentSessions.ts";
import { resolveRunningTask, runningView } from "../lib/runningTask.ts";
import { useStore } from "../store/store.ts";
import { AgentMark } from "./AgentPill.tsx";
import { SearchResults } from "./SearchResults.tsx";
import { SearchFilters, DEFAULT_FILTERS, filtersToOptions, type FilterState } from "./SearchFilters.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import {
  clampSidebarWidth, readSidebarWidth, saveSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH,
  DESKTOP_SIDEBAR_QUERY, isDesktopSidebarWidth,
} from "../lib/sidebarWidth.ts";
import { IconFolder, IconChevron, WorkingDots } from "../lib/icons.tsx";
import { basename, timeAgo } from "../lib/format.ts";
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
export function Sidebar({ open, onClose, onOpenPicker }: { open: boolean; onClose: () => void; onOpenPicker: () => void }) {
  const s = useStore();
  const [items, setItems] = useState<TaggedHistory[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [showMoreRecent, setShowMoreRecent] = useState(false);
  const [discovered, setDiscovered] = useState<TaggedDiscoveredHistory[] | null>(null);
  const [tab, setTab] = useState<"recent" | "conversations">("recent");
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
    });
  }
  useEffect(() => { loadHistory(true); loadDiscovered(true); }, [open, s.cwd, histAgentsKey, discoverAgentsKey]);
  // The panel always opens on Recent so cross-folder switching is one tap away,
  // collapsed back to the first few recents. The search filters reset with it:
  // they're deliberately unpersisted, and the panel stays mounted while closed
  // (desktop keeps it as a column), so nothing else would ever drop them.
  useEffect(() => { if (open) { setTab("recent"); setShowMoreRecent(false); setQ(""); setFilters(DEFAULT_FILTERS); } }, [open]);
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
  const runDot = (agentName: string, id: string) => {
    const state = runningById.get(agentName + "\n" + id);
    if (!state) return null;
    // Awaiting input isn't "working", so keep it as a static attention dot;
    // the spinner is reserved for actively-running sessions.
    if (state === "awaiting-input")
      return <span className="run-dot awaiting" title="Needs input" />;
    return <span className="run-working" title="Working"><WorkingDots /></span>;
  };
  // Per-row agent mark — only worth showing once more than one agent is configured.
  const mark = (agentName: string) => (multiAgent ? <AgentMark agent={agentByName.get(agentName)} /> : null);

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
  const mergedRecentItems = [
    ...allRecentItems.map((it) => ({ kind: "recent" as const, it, when: it.lastActiveAt })),
    ...discoveredExtras.map((it) => ({ kind: "discovered" as const, it, when: it.updatedAt })),
  ].sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());
  const recentItems = showMoreRecent ? mergedRecentItems : mergedRecentItems.slice(0, RECENT_LIMIT);
  const hasMoreRecent = mergedRecentItems.length > RECENT_LIMIT;
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
  const renderItem = (it: TaggedHistory, variant: "recent" | "all" = "all") => {
    const active = !!s.sessions[it.sessionId] && !s.sessions[it.sessionId].viewOnly;
    return (
      <button className={"sess-item" + (active ? " active" : "") + (variant === "recent" ? " recent" : "")} key={variant + ":" + it.agentName + ":" + it.sessionId}
        onClick={() => { s.openHistorySession({ sessionId: it.sessionId, title: it.title, agentName: it.agentName, cwd: s.cwd }); onClose(); }}>
        {runDot(it.agentName, it.sessionId)}
        {mark(it.agentName)}
        <span className="name">{it.title || it.sessionId.slice(0, 8)}</span>
        <span className="when">{it.updatedAt ? timeAgo(it.updatedAt) : ""}</span>
      </button>
    );
  };
  // coolingAt set → the task finished within the grace window: a muted "recently
  // active" dot and a relative time instead of the live spinner/state label.
  const renderRunningItem = (t: RunningTask, coolingAt?: number) => {
    // Title/folder come from the shared resolver (gateway cwd first, recents/live as
    // fallback) — the same one jumpToTask uses, so the label can't drift from where
    // the click lands. jumpToTask resolves the agent/folder and opens it.
    const { title, cwd } = resolveRunningTask(t, s);
    const active = s.agentName === t.agentName && s.activeId === t.sessionId;
    return (
      <button className={"sess-item recent with-folder" + (active ? " active" : "")} key={"running:" + t.agentName + ":" + t.sessionId}
        onClick={() => { s.jumpToTask(t); onClose(); }}>
        {coolingAt === undefined
          ? runDot(t.agentName, t.sessionId)
          : <span className="run-dot cooling" title="Recently active" />}
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
      </button>
    );
  };
  const renderRecentItem = (it: RecentSession) => {
    const active = s.cwd === it.cwd && s.agentName === it.agentName && !!s.sessions[it.sessionId] && !s.sessions[it.sessionId].viewOnly;
    // Present in a freshly-fetched list → defer to the gateway title (matching
    // renderItem's fallback exactly, including null); otherwise the cached snapshot.
    const histKey = it.agentName + "\n" + it.sessionId;
    const title = (historyTitleById.has(histKey) ? historyTitleById.get(histKey) : it.title)
      || it.sessionId.slice(0, 8);
    return (
      <button className={"sess-item recent with-folder" + (active ? " active" : "")} key={"recent:" + it.agentName + ":" + it.cwd + ":" + it.sessionId}
        onClick={() => { void s.openRecentSession(it); onClose(); }}>
        {runDot(it.agentName, it.sessionId)}
        {mark(it.agentName)}
        <span className="sess-main">
          <span className="name">{title}</span>
          <span className="folder-name">{basename(it.cwd)}</span>
        </span>
        <span className="when">{it.lastActiveAt ? timeAgo(it.lastActiveAt) : ""}</span>
      </button>
    );
  };
  const renderDiscoveredItem = (it: TaggedDiscoveredHistory) => {
    const active = s.cwd === it.cwd && s.agentName === it.agentName && !!s.sessions[it.sessionId] && !s.sessions[it.sessionId].viewOnly;
    return (
      <button className={"sess-item recent with-folder" + (active ? " active" : "")} key={"discovered:" + it.agentName + ":" + it.cwd + ":" + it.sessionId}
        onClick={() => { void s.openHistorySession({ sessionId: it.sessionId, title: it.title, agentName: it.agentName, cwd: it.cwd }); onClose(); }}>
        {runDot(it.agentName, it.sessionId)}
        {mark(it.agentName)}
        <span className="sess-main">
          <span className="name">{it.title || it.sessionId.slice(0, 8)}</span>
          <span className="folder-name">{basename(it.cwd)}</span>
        </span>
        <span className="when">{it.updatedAt ? timeAgo(it.updatedAt) : ""}</span>
      </button>
    );
  };
  const renderCurrentItem = (it: typeof currentItems[number]) => {
    const active = s.activeId === it.id;
    return (
      <button className={"sess-item recent" + (active ? " active" : "")} key={"current:" + it.id}
        onClick={() => { s.selectSession(it.id); onClose(); }}>
        {runDot(s.agentName, it.id)}
        {mark(s.agentName)}
        <span className="name">{sessionTitle(it.id, it.title)}</span>
        <span className="when">{timeAgo(new Date(it.createdAt).toISOString())}</span>
      </button>
    );
  };
  return (
    <>
      <div id="scrim" className={open ? "open" : ""} onClick={onClose} />
      <div id="panel" className={(open ? "open" : "") + (s.sidebarOpen ? "" : " collapsed")}
        style={desktop ? { width, maxWidth: width } : undefined}>
        {desktop && <ResizeHandle className="sb-resize" label="Resize the sidebar" edge="right"
          width={width} min={MIN_SIDEBAR_WIDTH} max={MAX_SIDEBAR_WIDTH} clamp={clampSidebarWidth}
          onWidth={setWidth} onCommit={saveSidebarWidth} />}
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
              <input placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {searchOpen && (
              <SearchFilters value={filters} agents={s.cfg.agents.map((a) => a.name)} onChange={setFilters} />
            )}
            {!searchOpen && (
              <div className="sidebar-tabs" role="tablist">
                <button className={"sidebar-tab" + (tab === "recent" ? " active" : "")}
                  data-tab="recent" role="tab" aria-selected={tab === "recent"}
                  onClick={() => setTab("recent")}>Recent</button>
                <button className={"sidebar-tab" + (tab === "conversations" ? " active" : "")}
                  data-tab="conversations" role="tab" aria-selected={tab === "conversations"}
                  onClick={() => setTab("conversations")}>Conversations</button>
              </div>
            )}
            {!searchOpen && tab === "recent" && (
              <div className="recent-tab">
                {(activeTasks.length > 0 || coolingTasks.length > 0) && (
                  <div className="running-section recent-section">
                    <div className="listhead"><span>Running</span></div>
                    <div className="recent-list">
                      {activeTasks.map((t) => renderRunningItem(t))}
                      {coolingTasks.map((c) => renderRunningItem(c.task, c.at))}
                    </div>
                  </div>
                )}
                {recentItems.length > 0 && (
                  <div className="recent-section">
                    <div className="recent-list">
                      {recentItems.map((row) => row.kind === "recent" ? renderRecentItem(row.it) : renderDiscoveredItem(row.it))}
                    </div>
                    {hasMoreRecent && (
                      <button className="see-more" onClick={() => setShowMoreRecent((v) => !v)}>
                        {showMoreRecent ? "Show less" : "See more"}
                      </button>
                    )}
                  </div>
                )}
                {currentItems.length > 0 && (
                  <div className="current-section recent-section">
                    <div className="listhead"><span>Current</span></div>
                    <div className="recent-list">
                      {currentItems.map((it) => renderCurrentItem(it))}
                    </div>
                  </div>
                )}
                {recentItems.length === 0 && currentItems.length === 0 && activeTasks.length === 0 && coolingTasks.length === 0 && (
                  <div className="panel-empty">No recent conversations yet.</div>
                )}
              </div>
            )}
            {(searchOpen || tab === "conversations") && (
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
      </div>
    </>
  );
}
