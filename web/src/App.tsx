import { useEffect, useState } from "react";
import { useStore } from "./store/store.ts";
import { getRunning, getInboxPending } from "./lib/api.ts";
import { TopBar } from "./components/TopBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { FilePanel } from "./components/FilePanel.tsx";
import { Thread } from "./components/Thread.tsx";
import { Composer } from "./components/Composer.tsx";
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
  const [panel, setPanel] = useState(false);
  const [picker, setPicker] = useState(false);
  const [loginAgent, setLoginAgent] = useState<AgentRef | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => { bootstrap(); }, [bootstrap]);
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
          <TopBar onPanel={() => setPanel((p) => !p)} onPicker={() => setPicker(true)} onOpenLogin={(a) => setLoginAgent(a)} />
          <main id="main"><Thread session={sess} agentReady={agentReady} loading={joining} /></main>
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
          instead of becoming a 4th column inside it. The strip is always
          present when the gateway offers a terminal: it is the only affordance
          that opens the panel, and it doubles as the panel's title bar. */}
      {terminalEnabled && (
        <div className="statusbar">
          <button className={"sb-chip" + (terminalOpen ? " on" : "")} aria-pressed={terminalOpen}
            onClick={() => setTerminalOpen((v) => !v)}>
            <IconTerminal />Terminal
          </button>
        </div>
      )}
      {terminalEnabled && terminalOpen && <Terminal cwd={cwd} onEmpty={() => setTerminalOpen(false)} />}
      {locked && <LockScreen />}
    </>
  );
}
