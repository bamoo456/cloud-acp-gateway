import { useState } from "react";
import { useStore } from "../store/store.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { AgentPill } from "./AgentPill.tsx";
import { PendingPermissions } from "./PendingPermissions.tsx";
import { RunningTasks } from "./RunningTasks.tsx";
import { basename } from "../lib/format.ts";
import { IconClock, IconPlus, IconDots, IconFolder, IconChevronDown } from "../lib/icons.tsx";
import type { AgentRef } from "../types.ts";
export function TopBar({ onPanel, onPicker, onOpenLogin }: { onPanel: () => void; onPicker: () => void; onOpenLogin?: (agent: AgentRef) => void }) {
  const s = useStore();
  const sess = s.activeId ? s.sessions[s.activeId] : null;
  const connClass = s.conn === "connected" ? "conn on" : s.conn === "offline" ? "conn off" : "conn";
  const connText = s.conn === "connected" ? "connected" : s.conn === "offline" ? "offline" : "connecting";
  const [menu, setMenu] = useState(false);
  return (
    <header>
      <button className="icon-btn sessions-btn" title="Sessions" onClick={onPanel}><IconClock /></button>
      <span className="title">{sess ? sess.title : "Untitled"}</span>
      {/* mobile-only (CSS): the title gives way to the folder switcher */}
      <button className="folder-chip" title={s.cwd} onClick={onPicker}>
        <IconFolder /><span className="nm">{basename(s.cwd)}</span><span className="chev"><IconChevronDown /></span>
      </button>
      <AgentPill onOpenLogin={onOpenLogin} />
      <span className={connClass}><span className="dot" />{connText}</span>
      <RunningTasks />
      <PendingPermissions />
      <button className="icon-btn" title="Conversation menu" onClick={() => setMenu((v) => !v)}><IconDots /></button>
      <button className="icon-btn" title="New chat" onClick={() => { if (s.agentReady) s.newSession(); }}><IconPlus /></button>
      <ActionMenu open={menu} onClose={() => setMenu(false)} />
    </header>
  );
}
