import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import type { RunningTask } from "../lib/api.ts";
import { resolveRunningTask } from "../lib/runningTask.ts";
import { basename } from "../lib/format.ts";
import { IconBolt } from "../lib/icons.tsx";
import { AgentMark } from "./AgentPill.tsx";

// Always-visible TopBar control surfacing prompts running anywhere — across
// agents and other devices, polled from the gateway's /running. The active
// session is left out (the AgentPill already shows its running dot); this is for
// the tasks you can't currently see. Click one to jump straight to it.
export function RunningTasks() {
  const s = useStore();
  const [open, setOpen] = useState(false);

  // Hide the task the user is already looking at.
  const others = s.runningTasks.filter(
    (t) => !(t.agentName === s.agentName && t.sessionId === s.activeId),
  );

  // Resolve each task's agent to its config entry so the row can show the same
  // glyph the Conversations list uses (Codex bloom / Claude robot / monogram).
  // Only worth showing once more than one agent is configured.
  const agentByName = new Map(s.cfg.agents.map((a) => [a.name, a] as const));
  const multiAgent = s.cfg.agents.length >= 2;

  useEffect(() => {
    if (!others.length) setOpen(false);
  }, [others.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!others.length) return null;

  // Folder + title come from the shared resolver (gateway cwd first, recents/live
  // as fallback) — the same one jumpToTask uses, so the label can't drift from
  // where the click actually lands. The id is the last-resort display label.
  const describe = (t: RunningTask) => {
    const { title, cwd } = resolveRunningTask(t, s);
    return {
      title: title || t.sessionId.slice(0, 8),
      folder: cwd ? basename(cwd) : null,
    };
  };

  const jump = (t: RunningTask) => { s.jumpToTask(t); setOpen(false); };

  return (
    <>
      <button className="icon-btn running-btn" title="Running tasks" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <IconBolt />
        <span className="badge">{others.length}</span>
      </button>
      {open && (
        <>
          <div className="pending-scrim" onClick={() => setOpen(false)} />
          <div className="running-menu pending-menu" role="dialog" aria-label="Running tasks">
            <div className="pending-head"><IconBolt />Running tasks</div>
            {others.map((t) => {
              const d = describe(t);
              return (
                <button className="running-item" key={t.agentName + ":" + t.sessionId} onClick={() => jump(t)}>
                  {multiAgent && <AgentMark agent={agentByName.get(t.agentName)} />}
                  <span className="running-main">
                    <span className="name">{d.title}</span>
                    <span className="sub">
                      {d.folder && <span className="folder-name">{d.folder}</span>}
                    </span>
                  </span>
                  <span className={"running-state " + t.state}>
                    {t.state === "awaiting-input" ? "Needs input" : "Working"}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
