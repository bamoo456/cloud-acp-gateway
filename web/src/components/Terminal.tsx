import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { startTerminal, terminalStreamUrl, sendTerminalInput, resizeTerminal } from "../lib/terminal.ts";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { readTerminalHeight, saveTerminalHeight, clampTerminalHeight, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT } from "../lib/terminalHeight.ts";
import { IconX } from "../lib/icons.tsx";

// Bottom-docked general shell (like ttyd, DevTools-style — sidebar/chat/files
// stay visible above it). Unlike LoginTerminal, closing this view must NOT
// stop the session — the PTY on the gateway host is meant to survive a
// dropped connection so reopening picks the same shell back up (the gateway
// reaps it on its own after an idle TTL with no subscriber).
export function Terminal({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [height, setHeight] = useState(readTerminalHeight);

  useEffect(() => {
    // Re-clamp on resize: a height chosen on a tall window would otherwise
    // leave no room for the chat above it once the window shrinks.
    const sync = () => setHeight((h) => clampTerminalHeight(h));
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let es: EventSource | null = null;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#0b0f14" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const dataSub = term.onData((data) => { void sendTerminalInput(data); });

    void startTerminal(cwd).then(() => {
      if (cancelled) return;
      es = new EventSource(terminalStreamUrl());
      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          // Decode straight to bytes — xterm has its own incremental UTF-8
          // decoder, so this stays correct for multibyte output (CJK
          // filenames, box-drawing glyphs) even when a sequence straddles two
          // SSE chunks. Decoding to a JS string first (à la LoginTerminal's
          // atob-then-regex, which only ever looks for ASCII) would mangle it.
          const bin = atob(ev.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          term.write(bytes);
        } catch {
          /* keepalive / the initial non-base64 "ready" frame */
        }
      };
    }).catch((e) => {
      if (!cancelled) setErrMsg(String(e));
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      void resizeTerminal(term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      cancelled = true;
      ro.disconnect();
      dataSub.dispose();
      es?.close();
      term.dispose();
    };
  }, [cwd]);

  return (
    <div className="term-panel" role="dialog" aria-label="Terminal" style={{ height }}>
      <ResizeHandle className="term-resize" label="Resize the terminal panel" edge="top" axis="y"
        size={height} min={MIN_TERMINAL_HEIGHT} max={MAX_TERMINAL_HEIGHT} clamp={clampTerminalHeight}
        onSize={setHeight} onCommit={saveTerminalHeight} />
      <div className="term-head">
        <span>Terminal</span>
        <button className="iclose" onClick={onClose} aria-label="Close terminal"><IconX /></button>
      </div>
      {errMsg && <div className="err-line" style={{ padding: 8, fontSize: 13 }}>Failed to start: {errMsg}</div>}
      <div className="term-view" ref={hostRef} />
    </div>
  );
}
