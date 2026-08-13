import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import { engineReadout } from "../lib/engine.ts";
import { IconChevronDown, IconLogin } from "../lib/icons.tsx";
import type { AgentRef } from "../types.ts";

const LOGIN_CAPABLE_KINDS = new Set(["claude", "codex"]);

// Elapsed seconds since the turn in flight started. Restarted by the key the
// caller passes, so it counts this turn and not the last one; the store keeps
// no turn timestamp and adding one would be a store-shape change (§2).
function useElapsed(running: boolean): number {
  const [t0, setT0] = useState(() => Date.now());
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) { setSecs(0); return; }
    setT0(Date.now());
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running, t0]);
  return secs;
}

// The engine readout: who is answering, on what model, at what thinking level —
// and the control that changes all three. Docked bottom-right of the message
// pane, outside the input, so it never competes with the session title in the
// crumb and never moves as the textarea grows (§3 P3).
export function EngineDock({ onOpenLogin }: { onOpenLogin?: (agent: AgentRef) => void }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const sess = s.activeId ? s.sessions[s.activeId] : null;
  // The same flag the thread's own working indicator reads, so the two can't
  // disagree about whether a turn is in flight.
  const running = !!sess?.working;
  const secs = useElapsed(running);
  // Read straight from the store on every render, never cached: changing model
  // rebuilds the effort options and can clamp the mode (see src/gateway.ts's
  // note on the same), so a memo here would serve a list the agent has dropped.
  const { model, effort } = engineReadout(s.configOptions, s.models, sess?.modelId);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const agents = s.cfg.agents;
  return (
    <div className="dock">
      <span className="sp" />
      <button className={"mchip" + (running ? " running" : "")} aria-haspopup="menu" aria-expanded={open}
        title="Agent, model and thinking level" onClick={() => setOpen((v) => !v)}>
        {running && <span className="spin" />}
        <span className="idot" />
        <span className="wm">{s.agentName}</span>
        {model && <><span className="sep">·</span><span className="am">{model.name}</span></>}
        {/* Not every agent has a thinking level — opencode reports none, so the
            whole segment disappears rather than leaving a placeholder. */}
        {effort && <><span className="sep">·</span><span className="eff">{effort.name}</span></>}
        {running && <span className="el">{secs}s</span>}
        <span className="chev"><IconChevronDown /></span>
      </button>
      {open && (
        <>
          <div className="amenu-scrim" onClick={() => setOpen(false)} />
          <div className="amenu engine-menu" role="menu">
            {agents.length > 1 && (
              <>
                <div className="amenu-subhead">Agent</div>
                {agents.map((a) => (
                  <div key={a.name} className="agent-opt-row">
                    <button className={"arow" + (a.name === s.agentName ? " on" : "")} role="menuitem"
                      onClick={() => { if (a.name !== s.agentName) s.setAgent(a.name); setOpen(false); }}>
                      <span className="col"><span>{a.name}</span><span className="sub">{a.cwd}</span></span>
                      {a.name === s.agentName && <span className="gt">✓</span>}
                    </button>
                    {a.kind && LOGIN_CAPABLE_KINDS.has(a.kind) && (
                      <button className="agent-login-btn" title={`Re-login to ${a.name}`}
                        onClick={() => { setOpen(false); onOpenLogin?.(a); }}><IconLogin /></button>
                    )}
                  </div>
                ))}
              </>
            )}
            {agents.length === 1 && agents[0].kind && LOGIN_CAPABLE_KINDS.has(agents[0].kind) && (
              <button className="arow" role="menuitem"
                onClick={() => { setOpen(false); onOpenLogin?.(agents[0]); }}>
                <IconLogin /><span className="col"><span>Re-login to {agents[0].name}</span></span>
              </button>
            )}
            {model?.option
              ? <OptionGroup label={model.option.name} option={model.option} onPick={(v) => { s.setConfigOption(model.option!.id, v); setOpen(false); }} />
              : s.models.length > 0 && (
                <>
                  <div className="amenu-subhead">Model</div>
                  {s.models.map((m) => (
                    <button key={m.modelId} className={"arow" + (m.modelId === sess?.modelId ? " on" : "")} role="menuitem"
                      onClick={() => { if (m.modelId !== sess?.modelId) s.setModel(m.modelId); setOpen(false); }}>
                      <span className="col"><span>{m.name}</span>{m.description && <span className="sub">{m.description}</span>}</span>
                      {m.modelId === sess?.modelId && <span className="gt">✓</span>}
                    </button>
                  ))}
                </>
              )}
            {effort && (
              <OptionGroup label={effort.option.name} option={effort.option}
                onPick={(v) => { s.setConfigOption(effort.option.id, v); setOpen(false); }} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function OptionGroup({ label, option, onPick }: {
  label: string; option: { currentValue: string; options: Array<{ value: string; name: string; description?: string }> };
  onPick: (value: string) => void;
}) {
  return (
    <>
      <div className="amenu-subhead">{label}</div>
      {option.options.map((x) => (
        <button key={x.value} className={"arow" + (x.value === option.currentValue ? " on" : "")} role="menuitem"
          onClick={() => { if (x.value !== option.currentValue) onPick(x.value); }}>
          <span className="col"><span>{x.name}</span>{x.description && <span className="sub">{x.description}</span>}</span>
          {x.value === option.currentValue && <span className="gt">✓</span>}
        </button>
      ))}
    </>
  );
}
