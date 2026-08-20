import { useEffect, useState } from "react";
import { useStore, agentQuotaKind } from "./store/store.ts";
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
import { IconTerminal } from "./lib/icons.tsx";
import type { AgentRef } from "./types.ts";

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
  // Machine-layer facts, in one row along the bottom edge (§1.4): the
  // transport, the folder's diffstat, the context window, the account's quota
  // and the terminal. Not the agent — the crumb and the dock already name it.
  const changeStat = useStore((s) => s.changeStat);
  const [panel, setPanel] = useState(false);
  const [picker, setPicker] = useState(false);
  const [loginAgent, setLoginAgent] = useState<AgentRef | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Find-in-conversation lives here because two children share it: the TopBar
  // button that opens it and the Thread that owns the search itself.
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => { bootstrap(); }, [bootstrap]);
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
  // Cmd/Ctrl-F opens the conversation search. Taking the browser's own
  // find-in-page is deliberate: it only ever searches the mounted window, which
  // is the last handful of messages, and silently reports nothing for the rest.
  // Escape closes it from the input (Thread), not from here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setFindOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
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
  // Poll every configured provider's quota (Claude, Codex), independent of
  // which agent is currently active — the bottom bar shows every provider on
  // hover/click, not just the one on screen, so all of them need to stay
  // fresh in the background. Separate from the /running poll and much
  // slower: the gateway caches for 5 minutes, so a tighter loop would only
  // ask the same cached answer more often. Joined into one string because a
  // new array/Set every render would restart the interval on every render.
  const quotaKinds = useStore((s) => {
    const kinds = new Set<string>();
    for (const a of s.cfg.agents) {
      const kind = agentQuotaKind(a);
      if (kind) kinds.add(kind);
    }
    return [...kinds].sort().join(",");
  });
  useEffect(() => {
    if (!quotaKinds) return;
    const kinds = quotaKinds.split(",") as Array<"claude" | "codex">;
    let alive = true;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (useStore.getState().locked) return;
      for (const kind of kinds) {
        void getUsageLimits(kind).then((result) => {
          if (alive && result) {
            useStore.getState().ingestUsageLimits(kind, result.windows, result.unlimited, result.unavailable);
          }
        });
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [quotaKinds]);
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
          <TopBar onPanel={() => setPanel((p) => !p)} onPicker={() => setPicker(true)}
            findOpen={findOpen} onFind={() => setFindOpen((v) => !v)} />
          <main id="main">
            <Thread session={sess} agentReady={agentReady} loading={joining}
              findOpen={findOpen} onCloseFind={() => setFindOpen(false)} />
          </main>
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
            connection speaks up. `ok` marks the healthy state so the phone
            layout can take that silence all the way and drop the word. */}
        <span className={"sb-seg conn" + (conn === "connected" ? " ok" : conn === "offline" ? " off" : "")}>
          {conn === "connected" ? "connected" : conn === "offline" ? "offline" : "connecting"}
        </span>
        {changeStat && changeStat.files > 0 && (
          <span className="sb-seg sb-diff" title={`${changeStat.files} changed file${changeStat.files === 1 ? "" : "s"} in this folder`}>
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
      {locked && <LockScreen />}
    </>
  );
}
