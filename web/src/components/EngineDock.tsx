import { useEffect, useState } from "react";
import { engineOf, useStore } from "../store/store.ts";
import { EMPTY_READOUT, engineReadout } from "../lib/engine.ts";
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
// `sessionId` binds it to a conversation that ISN'T the one in the main column —
// a floating window's own dock. It then reads that session's engine lists and sets
// every control on it, so the two docks on screen can hold different models
// (which they do: the lists are per session). It also drops the agent switcher:
// the agent is the whole page's connection, not this conversation's, and
// switching it closes the windows.
export function EngineDock({ onOpenLogin, sessionId }: { onOpenLogin?: (agent: AgentRef) => void; sessionId?: string }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const bound = !!sessionId;
  const id = sessionId ?? s.activeId;
  const sess = id ? s.sessions[id] : null;
  // This conversation's own lists — the readout and the pickers both come from the
  // session, never from a store-global (see store.ts's engineOf).
  const engine = engineOf(s, sessionId);
  // The same flag the thread's own working indicator reads, so the two can't
  // disagree about whether a turn is in flight.
  const running = !!sess?.working;
  const secs = useElapsed(running);
  // Read straight from the store on every render, never cached: changing model
  // rebuilds the effort options and can clamp the mode (see src/gateway.ts's
  // note on the same), so a memo here would serve a list the agent has dropped.
  // A saved conversation only becomes this agent's session on the first reply
  // (send() calls session/load then), so until then the store's engine state
  // belongs to another session — read out nothing rather than mislabel it.
  const viewOnly = !!sess?.viewOnly;
  const { model, effort, mode } = viewOnly
    ? EMPTY_READOUT
    : engineReadout(engine.configOptions, engine.models, sess?.modelId, engine.modes, sess?.mode);

  useEffect(() => {
    if (!open && !modeOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setModeOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, modeOpen]);

  const agents = s.cfg.agents;
  return (
    <div className="dock">
      {/* How much the agent may do without asking, at the near end of the row:
          it is the setting most likely to be changed mid-conversation, and it
          qualifies every permission prompt in the thread above it. */}
      {mode && (
        <>
          <button className="mchip mchip-mode" aria-haspopup="menu" aria-expanded={modeOpen}
            title="Permission mode" onClick={() => setModeOpen((v) => !v)}>
            <span className="am">{mode.name}</span>
            <span className="chev"><IconChevronDown /></span>
          </button>
          {modeOpen && (
            <>
              <div className="amenu-scrim" onClick={() => setModeOpen(false)} />
              <div className="amenu engine-menu mode-menu" role="menu">
                {mode.option
                  ? <OptionGroup label={mode.option.name} option={mode.option}
                      onPick={(v) => { s.setConfigOption(mode.option!.id, v, sessionId); setModeOpen(false); }} />
                  : (
                    <>
                      <div className="amenu-subhead">Mode</div>
                      {engine.modes.map((m) => (
                        <button key={m.id} className={"arow" + (m.id === sess?.mode ? " on" : "")} role="menuitem"
                          onClick={() => { if (m.id !== sess?.mode) s.setMode(m.id, sessionId); setModeOpen(false); }}>
                          <span className="col"><span>{m.name}</span>{m.description && <span className="sub">{m.description}</span>}</span>
                          {m.id === sess?.mode && <span className="gt">✓</span>}
                        </button>
                      ))}
                    </>
                  )}
              </div>
            </>
          )}
        </>
      )}
      <span className="sp" />
      <button className={"mchip" + (running ? " running" : "")} aria-haspopup="menu" aria-expanded={open}
        title="Agent, model and thinking level" onClick={() => setOpen((v) => !v)}>
        {running && <span className="spin" />}
        <span className="idot" />
        {/* The model, not the agent: the composer right below says "Reply to
            <agent>", so the name was the same fact twice (§1.4) and it was
            spending width the model name had nowhere else to get. The name is
            still the fallback for an agent that reports no model at all —
            without it that chip would be a lone chevron. */}
        {model ? <span className="am">{model.name}</span> : <span className="wm">{s.agentName}</span>}
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
            {!bound && agents.length > 1 && (
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
            {!bound && agents.length === 1 && agents[0].kind && LOGIN_CAPABLE_KINDS.has(agents[0].kind) && (
              <button className="arow" role="menuitem"
                onClick={() => { setOpen(false); onOpenLogin?.(agents[0]); }}>
                <IconLogin /><span className="col"><span>Re-login to {agents[0].name}</span></span>
              </button>
            )}
            {model?.option
              ? <OptionGroup label={model.option.name} option={model.option} onPick={(v) => { s.setConfigOption(model.option!.id, v, sessionId); setOpen(false); }} />
              : !viewOnly && engine.models.length > 0 && (
                <>
                  <div className="amenu-subhead">Model</div>
                  {engine.models.map((m) => (
                    <button key={m.modelId} className={"arow" + (m.modelId === sess?.modelId ? " on" : "")} role="menuitem"
                      onClick={() => { if (m.modelId !== sess?.modelId) s.setModel(m.modelId, sessionId); setOpen(false); }}>
                      <span className="col"><span>{m.name}</span>{m.description && <span className="sub">{m.description}</span>}</span>
                      {m.modelId === sess?.modelId && <span className="gt">✓</span>}
                    </button>
                  ))}
                </>
              )}
            {effort && (
              <OptionGroup label={effort.option.name} option={effort.option}
                onPick={(v) => { s.setConfigOption(effort.option.id, v, sessionId); setOpen(false); }} />
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
