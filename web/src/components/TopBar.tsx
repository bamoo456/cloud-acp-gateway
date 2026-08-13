import { useState } from "react";
import { useStore } from "../store/store.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { AgentPill } from "./AgentPill.tsx";
import { PendingPermissions } from "./PendingPermissions.tsx";
import { RunningTasks } from "./RunningTasks.tsx";
import { basename, dirname } from "../lib/format.ts";
import { isDesktopSidebarWidth } from "../lib/sidebarWidth.ts";
import { IconClock, IconPlus, IconDots, IconPanel } from "../lib/icons.tsx";
import type { AgentRef } from "../types.ts";

// The crumb answers one question — where are you — and nothing else (§1.4).
// The folder's parents are muted, its own name is ink, the session title trails
// it after a "›". Tapping it opens the folder switcher, which is what the
// separate mobile folder chip used to be for.
function Crumb({ cwd, title, onPicker }: { cwd: string; title: string; onPicker: () => void }) {
  const parent = dirname(cwd).replace(/^\/Users\/[^/]+/, "~").replace(/\/$/, "");
  return (
    <button className="crumb-path" title={cwd} onClick={onPicker}>
      {parent && <span className="up">{parent}/</span>}
      <b>{basename(cwd)}</b>
      <span className="sep"> › </span>
      <span className="ttl">{title}</span>
    </button>
  );
}

export function TopBar({ onPanel, onPicker, onOpenLogin }: { onPanel: () => void; onPicker: () => void; onOpenLogin?: (agent: AgentRef) => void }) {
  const s = useStore();
  const sess = s.activeId ? s.sessions[s.activeId] : null;
  const [menu, setMenu] = useState(false);
  return (
    <header>
      {/* One button, two doors: on desktop it collapses/expands the sidebar
          column (store state); below 860px it opens the overlay sheet (App
          state), which keeps the sheet's open-reset behavior intact. */}
      <button className={"icon-btn sessions-btn" + (s.sidebarOpen ? " on" : "")} title="Sessions"
        aria-pressed={s.sidebarOpen}
        onClick={() => { if (isDesktopSidebarWidth()) s.toggleSidebar(); else onPanel(); }}><IconClock /></button>
      <Crumb cwd={s.cwd} title={sess ? sess.title : "Untitled"} onPicker={onPicker} />
      <span className="sp" />
      <AgentPill onOpenLogin={onOpenLogin} />
      <RunningTasks />
      <PendingPermissions />
      <button className="icon-btn" title="Conversation menu" onClick={() => setMenu((v) => !v)}><IconDots /></button>
      <button className="icon-btn" title="New chat" onClick={() => { if (s.agentReady) s.newSession(); }}><IconPlus /></button>
      {/* Last, against the edge the panel it opens slides out from — the same
          place every editor puts its right-panel toggle, and the glyph is that
          toggle's own. */}
      <button className={"icon-btn files-btn" + (s.filesOpen ? " on" : "")} title="Files and changes"
        aria-pressed={s.filesOpen} onClick={s.toggleFiles}><IconPanel /></button>
      <ActionMenu open={menu} onClose={() => setMenu(false)} />
    </header>
  );
}
