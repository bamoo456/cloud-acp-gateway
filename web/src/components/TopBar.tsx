import { useState } from "react";
import { useStore } from "../store/store.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { PendingPermissions } from "./PendingPermissions.tsx";
import { basename, dirname } from "../lib/format.ts";
import { isDesktopSidebarWidth } from "../lib/sidebarWidth.ts";
import { IconClock, IconPlus, IconDots, IconPanel, IconSearch, IconShare } from "../lib/icons.tsx";

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

// Identity and the engine settings live in the dock above the composer now, so
// the crumb carries neither the agent pill nor its re-login button (§1.4).
export function TopBar({ onPanel, onPicker, findOpen, onFind }: {
  onPanel: () => void; onPicker: () => void; findOpen?: boolean; onFind?: () => void;
}) {
  const s = useStore();
  const sess = s.activeId ? s.sessions[s.activeId] : null;
  const [menu, setMenu] = useState(false);
  // Branching is a first-class move on the conversation, not a setting, so it
  // lives out here rather than three rows down a menu. Hidden — not disabled —
  // for agents that never advertised `sessionCapabilities.fork`: a permanently
  // dead button teaches nothing. Refused (with the reason on hover) for a
  // conversation the agent has never seen, one mid-turn (that reply is not in
  // the transcript yet, so the fork would silently drop it), and while a branch
  // window is already open, since one parent tracks one branch at a time.
  const canFork = s.cfg.agents.find((a) => a.name === s.agentName)?.sessionFork === true;
  const branchable = !!s.activeId && !s.activeId.startsWith("pending-");
  const running = s.runningTasks.some((t) => t.agentName === s.agentName && t.sessionId === s.activeId);
  const branchOpen = !!s.branch && s.branch.parentId === s.activeId;
  const branchWhy = !branchable ? "Send a message first"
    : running ? "Wait for this turn to finish"
    : branchOpen ? "A branch of this conversation is already open"
    : "Branch conversation — forks it into a floating window";
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
      {/* The cross-agent RUNNING badge is gone: the sessions list pins running
          conversations above the fold now (P4), and jumping to one is all that
          badge ever did. The PENDING badge stays, deliberately against the
          plan's §3 P2 note — the list pins waiting prompts too, but pinning
          only makes them visible, and this popup is the only place a prompt on
          an agent this client has no live connection to can be ANSWERED
          without first switching sessions. */}
      <PendingPermissions />
      <button className={"icon-btn" + (findOpen ? " on" : "")} title="Find in conversation"
        aria-pressed={findOpen} onClick={onFind}><IconSearch /></button>
      {canFork && (
        <button className={"icon-btn" + (branchOpen ? " on" : "")} title={branchWhy}
          aria-label="Branch conversation" disabled={!branchable || running || branchOpen}
          onClick={() => { void s.branchSession(); }}><IconShare /></button>
      )}
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
