import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import { Robot, CodexMark, OpencodeMark, IconChevronDown, IconLogin, WorkingDots } from "../lib/icons.tsx";
import { displayName } from "../lib/format.ts";
import type { AgentRef } from "../types.ts";

export function agentColor(agent?: AgentRef): string {
  if (agent?.skin === "codex") return "var(--agent-codex)";
  if (agent?.kind === "opencode") return "var(--agent-opencode)";
  if (agent?.name === "claude") return "var(--agent-claude)";
  return "var(--accent)";
}

export function AgentMark({ agent }: { agent?: AgentRef }) {
  if (agent?.skin === "codex") return <span className="mark codex"><CodexMark /></span>;
  if (agent?.kind === "opencode") return <span className="mark opencode"><OpencodeMark /></span>;
  if (agent?.name === "claude") return <span className="mark claude"><Robot /></span>;
  return <span className="mark mono">{(agent?.name?.[0] ?? "?").toUpperCase()}</span>;
}

const LOGIN_CAPABLE_KINDS = new Set(["claude", "codex"]);

export function AgentPill({ onOpenLogin }: { onOpenLogin?: (agent: AgentRef) => void }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const agent = s.cfg.agents.find((a) => a.name === s.agentName);
  const multi = s.cfg.agents.length >= 2;
  const running = !!(s.activeId && s.busySessionIds[s.activeId]);
  const style = { "--an": agentColor(agent) } as React.CSSProperties;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const inner = (
    <>
      <AgentMark agent={agent} />
      <span className="nm">{displayName(s.agentName)}</span>
      {running && <WorkingDots />}
      {multi && <span className="chev"><IconChevronDown /></span>}
    </>
  );

  if (!multi) {
    // No agent switcher to host the per-agent login button, so place it inline
    // next to the label — otherwise single-agent setups (the common case) would
    // have no way to re-authenticate when credentials expire.
    const loginable = agent?.kind && LOGIN_CAPABLE_KINDS.has(agent.kind);
    return (
      <span className="agent-solo">
        <span className={"agent-pill label" + (running ? " running" : "")} style={style} title={s.agentName}>
          {inner}
        </span>
        {loginable && agent && (
          <button className="agent-login-btn" title={`Re-login to ${agent.name}`}
            onClick={() => onOpenLogin?.(agent)}>
            <IconLogin />
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="agent-pill-wrap">
      <button className={"agent-pill" + (running ? " running" : "")} style={style}
        disabled={!s.agentReady} aria-haspopup="menu" aria-expanded={open}
        title="Switch agent" onClick={() => setOpen((v) => !v)}>
        {inner}
      </button>
      {open && (
        <>
          <div className="agent-scrim" onClick={() => setOpen(false)} />
          <div className="agent-menu" role="menu">
            {s.cfg.agents.map((a) => (
              <div key={a.name} className="agent-opt-row">
                <button className="agent-opt" role="menuitem"
                  onClick={() => { if (a.name !== s.agentName) s.setAgent(a.name); setOpen(false); }}>
                  <AgentMark agent={a} />
                  <span className="col"><span>{displayName(a.name)}</span><span className="sub">{a.cwd}</span></span>
                  {a.name === s.agentName && <span className="gt">✓</span>}
                </button>
                {a.kind && LOGIN_CAPABLE_KINDS.has(a.kind) && (
                  <button className="agent-login-btn" title={`Re-login to ${a.name}`}
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenLogin?.(a); }}>
                    <IconLogin />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
