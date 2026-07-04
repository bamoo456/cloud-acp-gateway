import { useState } from "react";
import { useStore } from "../store/store.ts";
import { verifyLockPin } from "../lib/lock.ts";
import { IconLock } from "../lib/icons.tsx";

// Full-screen unlock gate shown when the screen lock is engaged. The agent
// connection is already severed (store.lock()); entering the correct PIN calls
// store.unlock(), which reopens the WebSocket and resyncs. This is the only way
// back into the app while locked — it sits above everything (see .lockscreen).
export function LockScreen() {
  const unlock = useStore((s) => s.unlock);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin || checking) return;
    setChecking(true);
    const ok = await verifyLockPin(pin);
    setChecking(false);
    if (ok) { setPin(""); setError(false); unlock(); }
    else { setError(true); setPin(""); }
  }

  return (
    <div className="lockscreen" role="dialog" aria-modal="true" aria-label="Locked">
      <form className="lock-card" onSubmit={submit}>
        <div className="lock-icon"><IconLock /></div>
        <div className="lock-title">Locked</div>
        <div className="lock-sub">Enter your PIN to reconnect</div>
        <input
          className={"lock-input" + (error ? " error" : "")}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          aria-label="PIN"
          onChange={(e) => { setPin(e.target.value); setError(false); }}
        />
        {error && <div className="lock-error">Wrong PIN — try again</div>}
        <button type="submit" className="btn primary" disabled={!pin || checking}>
          {checking ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
