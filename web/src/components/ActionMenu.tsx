import { useState, useEffect } from "react";
import { TEXT_SIZE_OPTIONS, useStore } from "../store/store.ts";
import { resumeCommand } from "../lib/config.ts";
import { copyText } from "../lib/clipboard.ts";
import { setLockPin, clearLock, MIN_PIN_LENGTH } from "../lib/lock.ts";
import { IDENTITY_OPTIONS, applyIdentity, readIdentity, type Identity } from "../lib/identity.ts";
import { toolIcon, IconModel, IconShield, IconBolt, IconBack, IconChevron, IconCircle, IconPencil, IconTrash, IconType, IconLock, IconX } from "../lib/icons.tsx";
import type { ConfigOption } from "../types.ts";

function configRank(option: ConfigOption): number {
  const key = `${option.category || ""} ${option.id} ${option.name}`.toLowerCase();
  if (key.includes("model")) return 10;
  if (key.includes("reason") || key.includes("thought")) return 20;
  if (key.includes("approval") || key.includes("permission") || key.includes("sandbox")) return 30;
  return 40;
}

function configIcon(option: ConfigOption) {
  const key = `${option.category || ""} ${option.id} ${option.name}`.toLowerCase();
  if (key.includes("model")) return IconModel;
  if (key.includes("approval") || key.includes("permission") || key.includes("sandbox")) return IconShield;
  return IconBolt;
}

// The conversation menu — a bottom action sheet on mobile, a dropdown on desktop
// (CSS-driven; see .amenu in styles.css). Holds agent/session settings and
// conversation utilities so the composer stays minimal.
export function ActionMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useStore();
  const [view, setView] = useState<string>("main");
  const [renameText, setRenameText] = useState("");
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinErr, setPinErr] = useState("");
  // Per-screen taste, kept out of the store because it is neither shared across
  // devices nor read by anything but <html> (see lib/identity.ts).
  const [identity, setIdentity] = useState<Identity>(readIdentity);
  const sess = s.activeId ? s.sessions[s.activeId] : null;
  const resumableId = s.activeId && !s.activeId.startsWith("pending-") ? s.activeId : null;
  const curModel = s.models.find((m) => m.modelId === sess?.modelId)?.name || "";
  const curMode = s.modes.find((m) => m.id === sess?.mode)?.name || "";
  const curTextSize = TEXT_SIZE_OPTIONS.find((o) => o.id === s.textSize)?.label || "Default";
  const curIdentity = IDENTITY_OPTIONS.find((o) => o.id === identity)?.label || "Wordmark";
  const hasConfigOptions = s.configOptions.length > 0;
  const agentRef = s.cfg.agents.find((a) => a.name === s.agentName);
  const hasHistory = agentRef?.history !== false;
  // The gateway refuses to delete a conversation with a turn in flight (it would
  // unlink a transcript the agent is still writing), so disable it here too
  // rather than letting the user click into a confirm that can only fail.
  const isRunning = s.runningTasks.some((t) => t.agentName === s.agentName && t.sessionId === resumableId);
  const pinTitle = s.lockEnabled ? "Change PIN" : "Set a PIN";
  const pinError = pin1.length > 0 && pin1.length < MIN_PIN_LENGTH
    ? `PIN must be at least ${MIN_PIN_LENGTH} digits`
    : pin2.length > 0 && pin1 !== pin2
      ? "PINs don't match"
      : pinErr;
  const canSavePin = pin1.length >= MIN_PIN_LENGTH && pin1 === pin2 && !pinError;
  // CLI resume reads the on-disk transcript directly (claude --resume / codex
  // resume / opencode --session), independent of ACP session/load — so it works
  // whenever the agent persists history. The CLIs differ only in command syntax.
  const canResume = !!resumableId && hasHistory;
  const resumeHint = hasHistory
    ? "continue this conversation in your terminal"
    : "this agent's conversations can't be resumed";
  const configOptions = s.configOptions
    .map((option, index) => ({ option, index }))
    .sort((a, b) => configRank(a.option) - configRank(b.option) || a.index - b.index)
    .map(({ option }) => option);

  useEffect(() => { if (open) setView("main"); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  async function copyResume() {
    if (!canResume) return;
    const cmd = resumeCommand(resumableId!, s.cwd, agentRef?.kind);
    const ok = await copyText(cmd);
    s.setTip(ok ? "Resume command copied — paste in your terminal on the host running the gateway." : cmd);
    onClose();
  }

  function openSetPin() {
    setPin1(""); setPin2(""); setPinErr("");
    setView("setPin");
  }

  async function savePin(e: React.FormEvent) {
    e.preventDefault();
    if (!canSavePin) { setPinErr(pinError || "Confirm your PIN"); return; }
    await setLockPin(pin1);
    s.refreshLockSettings();
    setPin1(""); setPin2(""); setPinErr("");
    setView("lock");
  }

  function turnOffLock() {
    clearLock();
    s.refreshLockSettings();
    setView("main");
  }

  return (
    <>
      <div className="amenu-scrim open" onClick={onClose} />
      <div className="amenu" role="menu">
        {view === "main" && (
          <>
            <div className="ahead ahead-main">Settings<button className="iclose" onClick={onClose} aria-label="Close settings"><IconX /></button></div>
            {configOptions.map((o) => {
              const cur = o.options.find((x) => x.value === o.currentValue);
              const Ic = configIcon(o);
              return (
                <button key={o.id} className="arow cfgrow" onClick={() => setView("cfg:" + o.id)}>
                  <Ic /><span className="col"><span>{o.name}</span>{o.description && <span className="sub">{o.description}</span>}</span>
                  <span className="gt">{cur?.name || o.currentValue} <IconChevron /></span>
                </button>
              );
            })}
            {!hasConfigOptions && (
              <>
                <button className="arow" onClick={() => setView("model")} disabled={!s.models.length}>
                  <IconModel /><span className="col"><span>Model</span></span><span className="gt">{curModel} <IconChevron /></span>
                </button>
                <button className="arow" onClick={() => setView("mode")} disabled={!s.modes.length}>
                  <IconShield /><span className="col"><span>Permission mode</span></span><span className="gt">{curMode} <IconChevron /></span>
                </button>
              </>
            )}
            <button className={"arow" + (s.autoApprove ? " on" : "")} onClick={() => s.toggleAuto()}>
              <IconBolt /><span className="col"><span>Auto-approve permissions</span><span className="sub">skip the approval prompt for tool calls</span></span>
              <span className={"toggle" + (s.autoApprove ? " on" : "")} aria-hidden><span className="knob" /></span>
            </button>
            <div className="amenu-sep" />
            <button className="arow" onClick={() => setView("textSize")}>
              <IconType /><span className="col"><span>Text size</span><span className="sub">adjust chat readability</span></span>
              <span className="gt">{curTextSize} <IconChevron /></span>
            </button>
            <button className="arow" onClick={() => setView("identity")}>
              <IconCircle /><span className="col"><span>Agent identity</span><span className="sub">how much of the agent's colour to show</span></span>
              <span className="gt">{curIdentity} <IconChevron /></span>
            </button>
            <button className="arow" onClick={() => setView("lock")}>
              <IconLock /><span className="col"><span>Screen lock</span><span className="sub">require a PIN on reload or reconnect</span></span>
              <span className="gt">{s.lockEnabled ? "On" : "Off"} <IconChevron /></span>
            </button>
            <button className="arow" onClick={copyResume} disabled={!canResume}>
              {toolIcon("execute")}<span className="col"><span>Copy resume command</span><span className="sub">{resumeHint}</span></span>
            </button>
            <button className="arow" onClick={() => { setRenameText(sess && sess.title !== "Untitled" ? sess.title : ""); setView("rename"); }} disabled={!resumableId}>
              <IconPencil />Rename
            </button>
            <button className="arow danger" onClick={() => setView("delete")} disabled={!resumableId || isRunning}>
              <IconTrash /><span className="col"><span>Delete conversation</span>{isRunning && <span className="sub">still running — stop it first</span>}</span>
            </button>
          </>
        )}
        {view === "model" && (
          <>
            <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>Model</div>
            {s.models.map((m) => (
              <button key={m.modelId} className="arow" onClick={() => { if (m.modelId !== sess?.modelId) s.setModel(m.modelId); onClose(); }}>
                <span className="col"><span>{m.name}</span>{m.description && <span className="sub">{m.description}</span>}</span>
                {m.modelId === sess?.modelId && <span className="gt">✓</span>}
              </button>
            ))}
            {!s.models.length && <div className="panel-empty">No models available.</div>}
          </>
        )}
        {view === "mode" && (
          <>
            <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>Permission mode</div>
            {s.modes.map((m) => (
              <button key={m.id} className="arow" onClick={() => { if (m.id !== sess?.mode) s.setMode(m.id); onClose(); }}>
                <span className="col"><span>{m.name}</span>{m.description && <span className="sub">{m.description}</span>}</span>
                {m.id === sess?.mode && <span className="gt">✓</span>}
              </button>
            ))}
            {!s.modes.length && <div className="panel-empty">No modes available.</div>}
          </>
        )}
        {view === "textSize" && (
          <>
            <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>Text size</div>
            {TEXT_SIZE_OPTIONS.map((opt) => (
              <button key={opt.id} className={"arow text-size-option" + (s.textSize === opt.id ? " on" : "")}
                onClick={() => s.setTextSize(opt.id)}>
                <span className="col"><span>{opt.label}</span><span className="sub">{opt.description}</span></span>
                <span className="gt"><span className={"sample sample-" + opt.id}>Aa</span>{s.textSize === opt.id && "✓"}</span>
              </button>
            ))}
          </>
        )}
        {view === "identity" && (
          <>
            <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>Agent identity</div>
            <div className="amenu-note">The agent is a wordmark, not a colour — so amber can mean "needs you" and green can mean "added line" without competing with a brand. Turn the colour back on here if you prefer it.</div>
            {IDENTITY_OPTIONS.map((opt) => (
              <button key={opt.id} className={"arow" + (identity === opt.id ? " on" : "")}
                onClick={() => { applyIdentity(opt.id); setIdentity(opt.id); }}>
                <span className="col"><span>{opt.label}</span><span className="sub">{opt.description}</span></span>
                {identity === opt.id && <span className="gt">✓</span>}
              </button>
            ))}
          </>
        )}
        {view === "lock" && (
          <>
            <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>Screen lock</div>
            <div className="amenu-note">Locks this app on reload and whenever the agent connection has to be reopened, severing the connection until you unlock with your PIN — so a phone left on a table or lost can't keep driving the agent.</div>
            {!s.lockEnabled && (
              <button className="arow" onClick={openSetPin}>
                <IconLock /><span className="col"><span>Set a PIN</span><span className="sub">turn on the screen lock</span></span>
              </button>
            )}
            {s.lockEnabled && (
              <>
                <button className="arow" onClick={openSetPin}><IconPencil /><span className="col"><span>Change PIN</span></span></button>
                <button className="arow danger" onClick={turnOffLock}><span className="col"><span>Turn off lock</span><span className="sub">remove the PIN</span></span></button>
              </>
            )}
          </>
        )}
        {view === "setPin" && (
          <form className="pin-form" onSubmit={savePin}>
            <div className="ahead"><button type="button" className="iback" onClick={() => setView("lock")}><IconBack /></button>{pinTitle}</div>
            <div className="pin-body">
              <div className="pin-helper">Used when this app reloads or reconnects.</div>
              <label className="pin-field">
                <span>PIN</span>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input className="rename-input" autoFocus type="password" inputMode="numeric" autoComplete="off"
                  placeholder={`At least ${MIN_PIN_LENGTH} digits`} value={pin1}
                  aria-invalid={pinError ? true : undefined}
                  onChange={(e) => { setPin1(e.target.value); setPinErr(""); }} />
              </label>
              <label className="pin-field">
                <span>Confirm PIN</span>
                <input className="rename-input" type="password" inputMode="numeric" autoComplete="off"
                  placeholder="Re-enter PIN" value={pin2}
                  aria-invalid={pinError ? true : undefined}
                  onChange={(e) => { setPin2(e.target.value); setPinErr(""); }} />
              </label>
              {pinError && <div className="lock-error">{pinError}</div>}
              <button type="submit" className="btn primary pin-save" disabled={!canSavePin}>Save PIN</button>
            </div>
          </form>
        )}
        {view === "rename" && (
          <form className="rename-form" onSubmit={(e) => { e.preventDefault(); s.renameSession(renameText); onClose(); }}>
            <div className="ahead"><button type="button" className="iback" onClick={() => setView("main")}><IconBack /></button>Rename conversation</div>
            <div className="rename-body">
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input className="rename-input" autoFocus value={renameText} maxLength={120}
                placeholder="Conversation title" onChange={(e) => setRenameText(e.target.value)} />
              <button type="submit" className="btn primary">Save</button>
            </div>
          </form>
        )}
        {view === "delete" && (
          <>
            <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>Delete conversation</div>
            <div className="delete-body">
              <div className="delete-title">{sess && sess.title !== "Untitled" ? sess.title : resumableId?.slice(0, 8)}</div>
              <div className="amenu-note">
                Permanently deletes this conversation's transcript from the agent's own history.
                It can't be undone, and it won't be resumable from your terminal afterwards either.
              </div>
              <button className="btn danger" onClick={() => { void s.deleteSession(); onClose(); }}>Delete</button>
            </div>
          </>
        )}
        {view.startsWith("cfg:") && (() => {
          const opt = s.configOptions.find((o) => "cfg:" + o.id === view);
          if (!opt) return null;
          return (
            <>
              <div className="ahead"><button className="iback" onClick={() => setView("main")}><IconBack /></button>{opt.name}</div>
              {opt.options.map((x) => (
                <button key={x.value} className="arow"
                  onClick={() => { if (x.value !== opt.currentValue) s.setConfigOption(opt.id, x.value); onClose(); }}>
                  <span className="col"><span>{x.name}</span>{x.description && <span className="sub">{x.description}</span>}</span>
                  {x.value === opt.currentValue && <span className="gt">✓</span>}
                </button>
              ))}
            </>
          );
        })()}
      </div>
    </>
  );
}
