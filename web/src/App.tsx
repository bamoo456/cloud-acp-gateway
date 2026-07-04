import { useEffect, useState } from "react";
import { useStore } from "./store/store.ts";
import { getRunning, getInboxPending } from "./lib/api.ts";
import { TopBar } from "./components/TopBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Thread } from "./components/Thread.tsx";
import { Composer } from "./components/Composer.tsx";
import { FolderPicker } from "./components/FolderPicker.tsx";
import { LockScreen } from "./components/LockScreen.tsx";
import { LoginTerminal } from "./components/LoginTerminal.tsx";
import type { AgentRef } from "./types.ts";

export function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const ensureConnected = useStore((s) => s.ensureConnected);
  const sess = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const agentReady = useStore((s) => s.agentReady);
  const joining = useStore((s) => s.joining);
  const locked = useStore((s) => s.locked);
  const [panel, setPanel] = useState(false);
  const [picker, setPicker] = useState(false);
  const [loginAgent, setLoginAgent] = useState<AgentRef | null>(null);
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
      void getRunning().then((tasks) => { if (alive) useStore.setState({ runningTasks: tasks }); });
      // Durable, cross-agent pending permissions — survives reload and surfaces
      // prompts on agents this client has no live SSE connection to.
      void getInboxPending().then((items) => { if (alive) useStore.setState({ inboxItems: items }); });
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
      <Sidebar open={panel} onClose={() => setPanel(false)} onOpenPicker={() => setPicker(true)} />
      <div className="content">
        <TopBar onPanel={() => setPanel((p) => !p)} onPicker={() => setPicker(true)} onOpenLogin={(a) => setLoginAgent(a)} />
        <main id="main"><Thread session={sess} agentReady={agentReady} loading={joining} /></main>
        <Composer />
      </div>
      {picker && <FolderPicker onClose={() => setPicker(false)} />}
      {loginAgent && <LoginTerminal agent={loginAgent} onClose={() => setLoginAgent(null)} />}
      {/* loginAgent carries the full AgentRef so LoginTerminal can key device-auth on kind */}
      {locked && <LockScreen />}
    </>
  );
}
