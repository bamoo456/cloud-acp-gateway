import { useEffect, useState } from "react";
import { getHistory, getDiscoveredHistory, type HistorySession, type DiscoveredHistorySession, type RunningTask } from "../lib/api.ts";
import type { RecentSession } from "../lib/recentSessions.ts";
import { resolveRunningTask } from "../lib/runningTask.ts";
import { useStore } from "../store/store.ts";
import { AgentMark } from "./AgentPill.tsx";
import { IconFolder, IconChevron, WorkingDots } from "../lib/icons.tsx";
import { basename, timeAgo } from "../lib/format.ts";
import type { AgentRef } from "../types.ts";

const RECENT_LIMIT = 5;
const CONVERSATION_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
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
    .filter((a) => a.history !== false && (a.kind === "claude" || (!a.kind && a.name === "claude")))
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
  // collapsed back to the first few recents.
  useEffect(() => { if (open) { setTab("recent"); setShowMoreRecent(false); } }, [open]);
  // refresh the list in place (no loading flash) when something renames a session
  useEffect(() => {
    if (s.historyNonce === 0) return;
    loadHistory(false);
    loadDiscovered(false);
  }, [s.historyNonce]);

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
  // Conversations only ever lists the current folder, so the one place a session
  // can show up in both lists is the current folder. Recent caches its own title
  // in localStorage (derived client-side), which drifts from the gateway's title
  // (renames, agent thread names, JSONL-derived). Mirror the gateway title here so
  // the same session never wears two different labels across the two lists. Keyed
  // by agent + id so a cross-agent id collision can't borrow the wrong title.
  const historyTitleById = new Map(allItems.map((it) => [it.agentName + "\n" + it.sessionId, it.title] as const));
  // Running tasks (polled from the gateway across agents/devices) get their own
  // pinned section at the top of Recent, in stable start order — the /running array
  // order is the gateway task-map insertion order (≈ when each task started) and
  // does NOT re-sort on activity. Keeping running sessions OUT of the recency-sorted
  // list below is what stops that list from flapping while several sessions stream
  // frames at once (each frame bumps its recents lastActiveAt).
  const runningKeys = new Set(s.runningTasks.map((t) => t.agentName + "\n" + t.sessionId));
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
  const renderRunningItem = (t: RunningTask) => {
    // Title/folder come from the shared resolver (gateway cwd first, recents/live as
    // fallback) — the same one jumpToTask uses, so the label can't drift from where
    // the click lands. jumpToTask resolves the agent/folder and opens it.
    const { title, cwd } = resolveRunningTask(t, s);
    const active = s.agentName === t.agentName && s.activeId === t.sessionId;
    return (
      <button className={"sess-item recent with-folder" + (active ? " active" : "")} key={"running:" + t.agentName + ":" + t.sessionId}
        onClick={() => { s.jumpToTask(t); onClose(); }}>
        {runDot(t.agentName, t.sessionId)}
        {mark(t.agentName)}
        <span className="sess-main">
          <span className="name">{title || t.sessionId.slice(0, 8)}</span>
          {cwd && <span className="folder-name">{basename(cwd)}</span>}
        </span>
        <span className="when">{t.state === "awaiting-input" ? "Needs input" : "Working"}</span>
      </button>
    );
  };
  const renderRecentItem = (it: RecentSession) => {
    const active = s.cwd === it.cwd && s.agentName === it.agentName && !!s.sessions[it.sessionId] && !s.sessions[it.sessionId].viewOnly;
    // Same folder + same agent + present in the freshly-fetched history → defer to
    // the gateway title (matching renderItem's fallback exactly, including null).
    const histKey = it.agentName + "\n" + it.sessionId;
    const title = it.cwd === s.cwd && historyTitleById.has(histKey)
      ? historyTitleById.get(histKey) || it.sessionId.slice(0, 8)
      : it.title || it.sessionId.slice(0, 8);
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
      <div id="panel" className={open ? "open" : ""}>
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
            <div className="sidebar-tabs" role="tablist">
              <button className={"sidebar-tab" + (tab === "recent" ? " active" : "")}
                data-tab="recent" role="tab" aria-selected={tab === "recent"}
                onClick={() => setTab("recent")}>Recent</button>
              <button className={"sidebar-tab" + (tab === "conversations" ? " active" : "")}
                data-tab="conversations" role="tab" aria-selected={tab === "conversations"}
                onClick={() => setTab("conversations")}>Conversations</button>
            </div>
            {tab === "recent" && (
              <div className="recent-tab">
                {s.runningTasks.length > 0 && (
                  <div className="running-section recent-section">
                    <div className="listhead"><span>Running</span></div>
                    <div className="recent-list">
                      {s.runningTasks.map((t) => renderRunningItem(t))}
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
                {recentItems.length === 0 && currentItems.length === 0 && s.runningTasks.length === 0 && (
                  <div className="panel-empty">No recent conversations yet.</div>
                )}
              </div>
            )}
            {tab === "conversations" && (
              <div className="all-section">
                <div className="search">
                  <input placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <div className="sess-list">
                  {err && <div className="panel-empty">Couldn't load conversations.</div>}
                  {!err && items === null && <div className="panel-empty">Loading…</div>}
                  {!err && items !== null && visibleItems.length === 0 && <div className="panel-empty">No conversations in this folder yet.</div>}
                  {visibleItems.map((it) => renderItem(it))}
                  {!err && items !== null && hasOlderItems && (
                    <button className="see-more" onClick={() => setShowMore((v) => !v)}>
                      {showMore ? "Show recent only" : "See more"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
