import { useEffect, useState } from "react";
import { useStore } from "./store/store.ts";
import { getRunning, getInboxPending, getUsageLimits } from "./lib/api.ts";
import { TopBar } from "./components/TopBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { FilePanel } from "./components/FilePanel.tsx";
import { Thread } from "./components/Thread.tsx";
import { Composer } from "./components/Composer.tsx";
import { EngineDock } from "./components/EngineDock.tsx";
import { FolderPicker } from "./components/FolderPicker.tsx";
import { LockScreen } from "./components/LockScreen.tsx";
import { LoginTerminal } from "./components/LoginTerminal.tsx";
// Static on purpose. Code-splitting this component — via React.lazy() or via a
// plain dynamic import() into state — makes it throw "Invalid hook call" on
// mount in this project's Vite build. Verified: it reproduces with a one-hook
// stub in place of the real component (so it is not xterm, ResizeHandle, or
// anything else here), it survives removing StrictMode, and the emitted chunk
// imports React from the main chunk rather than bundling its own copy. Whatever
// the cause, code splitting is broken here, so don't reintroduce it without
// re-testing in a browser — the type checker and the jsdom suite both pass
// either way.
//
// Cost of going static: xterm (~86 kB gzipped) lands in the main bundle even
// when ACPG_TERMINAL is off, and the jsdom tests log a harmless
// "HTMLCanvasElement.getContext not implemented" warning (xterm degrades
// gracefully; no test fails).
import { Terminal } from "./components/Terminal.tsx";
import { UsageStrip } from "./components/UsageStrip.tsx";
import { IconTerminal, IconChat, IconBranch, IconClock } from "./lib/icons.tsx";
import type { AgentRef } from "./types.ts";

// The phone's four panes. A bottom tab bar rather than the desktop's three
// columns squeezed narrow (§3 P5) — one pane at a time is what a 392px screen
// can actually show.
type MobileTab = "chat" | "changes" | "sessions" | "term";
const TABS: Array<{ id: MobileTab; label: string; icon: () => JSX.Element }> = [
  { id: "chat", label: "Chat", icon: () => <IconChat /> },
  { id: "changes", label: "Changes", icon: () => <IconBranch /> },
  { id: "sessions", label: "Sessions", icon: () => <IconClock /> },
  { id: "term", label: "Term", icon: () => <IconTerminal /> },
];

export function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const ensureConnected = useStore((s) => s.ensureConnected);
  const sess = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const agentReady = useStore((s) => s.agentReady);
  const joining = useStore((s) => s.joining);
  const locked = useStore((s) => s.locked);
  const cwd = useStore((s) => s.cwd);
  const terminalEnabled = useStore((s) => s.cfg.terminalEnabled);
  const conn = useStore((s) => s.conn);
  const filesOpen = useStore((s) => s.filesOpen);
  const toggleFiles = useStore((s) => s.toggleFiles);
  // Cross-agent prompts waiting on an answer. The mobile Sessions tab carries
  // the count the crumb used to (§3 P5) — the sessions list itself pins them.
  const pendingCount = useStore((s) =>
    s.inboxItems.filter((it) => it.reqId != null && it.sessionId !== s.activeId).length);
  // Machine-layer facts, in one row along the bottom edge (§1.4): the
  // transport, the folder's diffstat, the context window, the account's quota
  // and the terminal. Not the agent — the crumb and the dock already name it.
  const changeStat = useStore((s) => s.changeStat);
  const [panel, setPanel] = useState(false);
  const [picker, setPicker] = useState(false);
  const [loginAgent, setLoginAgent] = useState<AgentRef | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => { bootstrap(); }, [bootstrap]);
  // Derived, never stored: whichever sheet is open IS the current tab.
  const mobileTab: MobileTab = terminalOpen ? "term" : filesOpen ? "changes" : panel ? "sessions" : "chat";
  const pickTab = (t: MobileTab) => {
    setPanel(t === "sessions");
    if ((t === "changes") !== filesOpen) toggleFiles();
    setTerminalOpen(t === "term");
  };
  // Ctrl-` toggles the terminal, the shortcut the strip advertises. Capture
  // phase and stopPropagation because xterm listens on its own textarea: once
  // the panel has focus, a bubbling handler would reach us only after the
  // shell had already been sent the keystroke.
  useEffect(() => {
    if (!terminalEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== "`") return;
      e.preventDefault();
      e.stopPropagation();
      setTerminalOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [terminalEnabled]);
  // Poll the gateway for tasks running anywhere (any agent, any device) so the
  // TopBar can surface and jump to them. Independent of the active SSE connection.
  // Skip the request while the tab is hidden — a backgrounded tab has nothing to
  // render and shouldn't wake the gateway every 5s (battery/radio on mobile/PWA);
  // refresh immediately when it returns to the foreground so it isn't stale.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (useStore.getState().locked) return; // don't poll the gateway while locked
      void getRunning().then((tasks) => { if (alive) useStore.getState().ingestRunningTasks(tasks); });
      // Durable, cross-agent pending permissions — survives reload and surfaces
      // prompts on agents this client has no live SSE connection to.
      const promptRevision = useStore.getState().promptStateRevision;
      void getInboxPending().then((items) => {
        if (alive && items !== null) {
          useStore.getState().ingestInboxItems(items, promptRevision);
        }
      });
    };
    tick();
    const id = setInterval(tick, 5000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  // Poll this account's Claude quota. Separate from the /running poll and much
  // slower: the gateway caches for 5 minutes, so a tighter loop would only ask
  // the same cached answer more often. Keyed on agentName because the route is
  // Claude-specific — switching agents clears the windows, and coming back to a
  // Claude agent refetches immediately rather than waiting out the interval.
  // The kind test is the same one discoverable() uses (Sidebar.tsx:53): `kind`
  // is absent on agents configured before it existed.
  const claudeActive = useStore((s) => {
    const a = s.cfg.agents.find((x) => x.name === s.agentName);
    return a?.kind === "claude" || (!a?.kind && a?.name === "claude");
  });
  useEffect(() => {
    if (!claudeActive) return;
    let alive = true;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (useStore.getState().locked) return;
      void getUsageLimits().then((windows) => {
        if (alive && windows) useStore.getState().ingestUsageLimits(windows);
      });
    };
    tick();
    const id = setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [claudeActive]);
  // Reconnect the SSE stream when the tab returns to the foreground (or a bfcache
  // restore). A backgrounded mobile tab can have its stream dropped with the
  // onclose-driven reconnect frozen; ensureConnected() reopens a dead socket — and,
  // when the screen lock is on, engages the lock instead (re-auth before
  // reconnecting). pageshow also covers a bfcache restore, where no
  // visibilitychange fires.
  useEffect(() => {
    const resume = () => ensureConnected();
    const onVisibility = () => { if (document.visibilityState === "visible") resume(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", resume);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", resume);
    };
  }, [ensureConnected]);
  return (
    <>
      <div className="app-row">
        <Sidebar open={panel} onClose={() => setPanel(false)} onOpenPicker={() => setPicker(true)} />
        <div className="content">
          <TopBar onPanel={() => setPanel((p) => !p)} onPicker={() => setPicker(true)} />
          <main id="main"><Thread session={sess} agentReady={agentReady} loading={joining} /></main>
          {/* Between the thread and the input, right-aligned: what is answering
              and on what, plus the control that changes it (§3 P3). */}
          <EngineDock onOpenLogin={(a) => setLoginAgent(a)} />
          <Composer />
        </div>
        {/* Right of the chat column on desktop, an overlay on mobile. Always
            mounted: it holds the fetched change list across open/close so
            reopening it is instant rather than a fresh `git status`. */}
        <FilePanel />
      </div>
      {picker && <FolderPicker onClose={() => setPicker(false)} />}
      {loginAgent && <LoginTerminal agent={loginAgent} onClose={() => setLoginAgent(null)} />}
      {/* loginAgent carries the full AgentRef so LoginTerminal can key device-auth on kind */}
      {/* Status strip + terminal are siblings of .app-row, not inside it — they
          dock full-width below the sidebar/chat/files row (like DevTools), so
          they have to be direct #root flex children to stack under that row
          instead of becoming a 4th column inside it. Unlike before, the strip
          is always present: it is the app's bottom edge and it owns the
          home-indicator inset, and the connection is a fact it always has. */}
      <div className="statusbar">
        {/* Silent when healthy (§1.1): muted text, no green dot; only a broken
            connection speaks up. */}
        <span className={"sb-seg conn" + (conn === "offline" ? " off" : "")}>
          {conn === "connected" ? "connected" : conn === "offline" ? "offline" : "connecting"}
        </span>
        {changeStat && changeStat.files > 0 && (
          <span className="sb-seg" title={`${changeStat.files} changed file${changeStat.files === 1 ? "" : "s"} in this folder`}>
            {changeStat.files} file{changeStat.files === 1 ? "" : "s"}
            {changeStat.additions > 0 && <b className="add">+{changeStat.additions}</b>}
            {changeStat.deletions > 0 && <b className="del">−{changeStat.deletions}</b>}
          </span>
        )}
        <span className="sb-sp" />
        <UsageStrip />
        {terminalEnabled && (
          <button className={"sb-seg sb-term" + (terminalOpen ? " on" : "")} aria-pressed={terminalOpen}
            title="Toggle the terminal" onClick={() => setTerminalOpen((v) => !v)}>
            <IconTerminal />term <kbd>⌃`</kbd>
          </button>
        )}
      </div>
      {terminalEnabled && terminalOpen && <Terminal cwd={cwd} onEmpty={() => setTerminalOpen(false)} />}
      {/* Phone only (CSS). Below the desktop breakpoint the sidebar and the file
          panel are sheets over the chat, which is the same "one pane at a time"
          the tab bar makes explicit — so the tab is DERIVED from the state those
          sheets already use rather than being a fourth source of truth that
          could disagree with them. */}
      <nav className="tabbar">
        {TABS.map((t) => {
          if (t.id === "term" && !terminalEnabled) return null;
          const on = mobileTab === t.id;
          const n = t.id === "changes" ? changeStat?.files ?? 0 : t.id === "sessions" ? pendingCount : 0;
          return (
            <button key={t.id} className={on ? "on" : ""} aria-pressed={on} data-t={t.id}
              onClick={() => pickTab(t.id)}>
              {t.icon()}{t.label}
              {n > 0 && <span className="n">{n}</span>}
            </button>
          );
        })}
      </nav>
      {locked && <LockScreen />}
    </>
  );
}
