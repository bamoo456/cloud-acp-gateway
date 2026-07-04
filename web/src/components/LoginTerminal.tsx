import { useEffect, useRef, useState } from "react";
import { startLogin, loginStreamUrl, sendLoginInput, stopLogin } from "../lib/login.ts";
import { useStore } from "../store/store.ts";
import { displayName } from "../lib/format.ts";
import type { AgentRef } from "../types.ts";

const URL_RE = /https:\/\/[^\s\x1b\x07]+/;
const STRIP_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
// codex device codes are two alphanumeric groups joined by a hyphen, e.g.
// "C0Q4-NOO0M" — the first group can lead with a digit, so an all-[A-Z] prefix
// would never match. Require the hyphen to avoid matching version strings.
const DEVICE_CODE_RE = /\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/;

function pickUrl(buf: string): string | null {
  const clean = buf.replace(STRIP_RE, "");
  const m = clean.match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,)\]]+$/, "");
}

function pickDeviceCode(buf: string): string | null {
  const clean = buf.replace(STRIP_RE, "");
  const m = clean.match(DEVICE_CODE_RE);
  return m ? m[0] : null;
}

export function LoginTerminal({ agent, onClose }: { agent: AgentRef; onClose: () => void }) {
  const agentName = agent.name;
  const setTip = useStore((s) => s.setTip);
  // Accumulate streamed PTY bytes so a URL or device code split across two SSE
  // chunks is still matched (each chunk alone may not contain a full match).
  const bufRef = useRef("");
  const [url, setUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [val, setVal] = useState("");
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"" | "sending" | "ok" | "err">("");
  const [phase, setPhase] = useState<"starting" | "awaiting-code" | "done">("starting");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    bufRef.current = "";
    setUrl(null);
    setDeviceCode(null);
    setVal("");
    setStatus("");
    setPhase("starting");
    setErrMsg(null);

    void startLogin(agentName).then(() => {
      if (cancelled) return;
      es = new EventSource(loginStreamUrl(agentName));
      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          // Match against the running buffer, not just this chunk, so a URL or
          // code straddling two SSE frames is still detected. Cap it so a chatty
          // stream can't grow it without bound.
          const buf = (bufRef.current = (bufRef.current + atob(ev.data)).slice(-64 * 1024));
          setUrl((prev) => {
            if (prev !== null) return prev;
            const found = pickUrl(buf);
            if (found) { setPhase("awaiting-code"); return found; }
            return prev;
          });
          setDeviceCode((prev) => prev ?? pickDeviceCode(buf));
        } catch {
          /* keepalive / non-data frame */
        }
      };
      es.onerror = () => {
        if (cancelled) return;
        setPhase((p) => (p === "awaiting-code" ? "done" : p));
      };
    }).catch((e) => {
      if (cancelled) return;
      setErrMsg(String(e));
    });

    return () => {
      cancelled = true;
      es?.close();
      void stopLogin(agentName);
    };
  }, [agentName]);

  // Device-auth flows (codex) complete on their own: the user enters the code
  // in the browser and the CLI polls to finish — there is nothing to paste back.
  // The paste-back flow (claude) prints a URL and waits for a code on stdin.
  // Key off the agent's backing CLI (kind), not its name or a regex side-effect,
  // so a renamed codex agent still gets the device-auth UI and a stray code-like
  // token in a claude stream can't hide the paste field.
  const deviceAuth = agent.kind === "codex";

  const onSend = () => {
    const text = val.trim();
    if (!text) return;
    setStatus("sending");
    void sendLoginInput(agentName, text + "\n");
    setVal("");
    setStatus("ok");
    setTimeout(() => setStatus(""), 1200);
  };

  return (
    <>
      <div className="amenu-scrim open" onClick={onClose} />
      <div className="amenu login-term" role="dialog" aria-label="Agent login">
        <div className="ahead">
          <span className="col">
            <span>Re-login to {displayName(agentName)}</span>
            <span className="sub">
              {deviceAuth
                ? "open the link, enter the code in your browser — it finishes automatically"
                : "open the link in any browser, paste the code back"}
            </span>
          </span>
          <button
            className="btn"
            onClick={() => {
              void stopLogin(agentName);
              onClose();
            }}
          >
            Close
          </button>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, background: "#0b0f14" }}>
          {errMsg ? (
            <div className="err-line" style={{ fontSize: 13 }}>Login failed to start: {errMsg}</div>
          ) : phase === "starting" ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>Starting {displayName(agentName)} login…</div>
          ) : null}

          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                padding: "10px 12px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--accent)",
                fontSize: 12,
                wordBreak: "break-all",
                textDecoration: "none",
                lineHeight: 1.4,
              }}
            >
              {url}
            </a>
          )}

          {deviceCode && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
            >
              <span style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 18, fontWeight: 600, letterSpacing: 2, color: "var(--fg)" }}>
                {deviceCode}
              </span>
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(deviceCode);
                  setCopied(true);
                  setTip("Device code copied");
                  setTimeout(() => setCopied(false), 1500);
                }}
                style={{ fontSize: 12, padding: "6px 10px" }}
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
          )}

          {!deviceAuth && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ flex: 1, minWidth: 0, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-2)", color: "var(--fg)", fontSize: 14, WebkitAppearance: "none" }}
                type="text"
                inputMode="text"
                enterKeyHint="send"
                placeholder="Paste authorization code here…"
                value={val}
                onChange={(e) => setVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={phase !== "awaiting-code"}
              />
              <button className="btn" onClick={onSend} disabled={!val.trim() || phase !== "awaiting-code"}>
                {status === "sending" ? "…" : status === "ok" ? "✓" : "Send"}
              </button>
            </div>
          )}

          {phase === "done" && (
            <div style={{ color: "var(--ok)", fontSize: 13 }}>Login successful — reloading agent…</div>
          )}
        </div>
      </div>
    </>
  );
}
