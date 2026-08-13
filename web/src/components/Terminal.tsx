import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  newTerminalId, listTerminals, startTerminal, terminalStreamUrl,
  sendTerminalInput, resizeTerminal, stopTerminal,
} from "../lib/terminal.ts";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { readTerminalHeight, saveTerminalHeight, clampTerminalHeight, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT } from "../lib/terminalHeight.ts";
import { IconPlus, IconX } from "../lib/icons.tsx";

// One tab: an xterm bound to one gateway shell. Every tab stays mounted while
// the panel is open — switching hides the inactive ones rather than tearing
// them down, so scrollback and the running program survive a switch.
function TermTab({ id, cwd, active, onExit }: {
  id: string; cwd?: string; active: boolean; onExit: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Read inside the ResizeObserver, which is created once and would otherwise
  // close over the first `active`.
  const activeRef = useRef(active);
  activeRef.current = active;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => { void sendTerminalInput(id, data); });

    void startTerminal(id, cwd).then(() => {
      if (cancelled) return;
      es = new EventSource(terminalStreamUrl(id));
      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          // Decode straight to bytes — xterm has its own incremental UTF-8
          // decoder, so this stays correct for multibyte output (CJK
          // filenames, box-drawing glyphs) even when a sequence straddles two
          // SSE chunks. Decoding to a JS string first would mangle it.
          const bin = atob(ev.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          term.write(bytes);
        } catch {
          /* keepalive frame */
        }
      };
      // The shell exited (ctrl-D, `exit`, a kill). A closed stream on its own
      // is ambiguous — EventSource retries dropped connections — so the
      // gateway says so explicitly and the tab goes away.
      es.addEventListener("exit", () => {
        if (!cancelled) onExitRef.current(id);
      });
    });

    const ro = new ResizeObserver(() => {
      // A hidden tab measures 0 and would fit() to nonsense, resizing the
      // shell behind it.
      if (!activeRef.current || !host.clientHeight) return;
      fit.fit();
      void resizeTerminal(id, term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      cancelled = true;
      ro.disconnect();
      dataSub.dispose();
      es?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id, cwd]);

  // Becoming visible: the terminal was laid out at zero size while hidden, so
  // it has to re-measure before it renders anything sane.
  useEffect(() => {
    if (!active || !hostRef.current?.clientHeight) return;
    fitRef.current?.fit();
    termRef.current?.focus();
    const t = termRef.current;
    if (t) void resizeTerminal(id, t.cols, t.rows);
  }, [active, id]);

  return <div className="term-view" ref={hostRef} style={active ? undefined : { display: "none" }} />;
}

// Bottom-docked general shell (like ttyd, DevTools-style — sidebar/chat/files
// stay visible above it), with one tab per shell.
//
// No title bar of its own: the always-visible status strip above it (see
// App.tsx) names it and owns the open/close toggle. `onEmpty` fires when the
// last tab's shell exits, so the panel can close itself.
export function Terminal({ cwd, onEmpty }: { cwd?: string; onEmpty: () => void }) {
  const [height, setHeight] = useState(readTerminalHeight);
  // null while we ask the gateway which shells already exist — rendering a tab
  // before that would spawn a duplicate of one we're about to adopt.
  const [tabs, setTabs] = useState<string[] | null>(null);
  const [active, setActive] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listTerminals().then((ids) => {
      if (cancelled) return;
      const initial = ids.length ? ids : [newTerminalId()];
      setTabs(initial);
      setActive(initial[0]);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Re-clamp on resize: a height chosen on a tall window would otherwise
    // leave no room for the chat above it once the window shrinks.
    const sync = () => setHeight((h) => clampTerminalHeight(h));
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // Shared by "the shell exited" and "the user clicked ×": drop the tab, move
  // focus to a neighbour, and close the whole panel once none are left.
  const dropTab = (id: string) => {
    setTabs((prev) => {
      if (!prev) return prev;
      const next = prev.filter((t) => t !== id);
      if (!next.length) onEmpty();
      setActive((cur) => (cur === id ? next[Math.max(0, prev.indexOf(id) - 1)] ?? "" : cur));
      return next;
    });
  };

  const addTab = () => {
    const id = newTerminalId();
    setTabs((prev) => [...(prev ?? []), id]);
    setActive(id);
  };

  return (
    <div className="term-panel" role="region" aria-label="Terminal" style={{ height }}>
      <ResizeHandle className="term-resize" label="Resize the terminal panel" edge="top" axis="y"
        size={height} min={MIN_TERMINAL_HEIGHT} max={MAX_TERMINAL_HEIGHT} clamp={clampTerminalHeight}
        onSize={setHeight} onCommit={saveTerminalHeight} />
      <div className="term-tabs" role="tablist">
        {(tabs ?? []).map((id, i) => (
          <span key={id} className={"term-tab" + (id === active ? " on" : "")}>
            <button role="tab" aria-selected={id === active} onClick={() => setActive(id)}>
              {i + 1}
            </button>
            <button className="term-tab-x" aria-label={`Close terminal ${i + 1}`}
              onClick={() => { void stopTerminal(id); dropTab(id); }}><IconX /></button>
          </span>
        ))}
        <button className="term-newtab" aria-label="New terminal" onClick={addTab}><IconPlus /></button>
      </div>
      {(tabs ?? []).map((id) => (
        <TermTab key={id} id={id} cwd={cwd} active={id === active} onExit={dropTab} />
      ))}
    </div>
  );
}
