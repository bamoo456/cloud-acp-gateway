import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  newTerminalId, listTerminals, startTerminal, terminalStreamUrl,
  sendTerminalInput, resizeTerminal, stopTerminal, renameTerminal, type TerminalTab,
} from "../lib/terminal.ts";
import { useRowMenu } from "./FileMenu.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { readTerminalHeight, saveTerminalHeight, clampTerminalHeight, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT } from "../lib/terminalHeight.ts";
import { IconPlus, IconX } from "../lib/icons.tsx";

// Matches the gateway's own cap (src/terminal.ts), so the box stops taking
// characters the server would only trim off again.
const MAX_TAB_NAME = 40;

// One tab's chip in the tab row: its label, and the × that kills its shell.
//
// Renaming is reached the way every other "do something to this row" in the
// console is — right-click on a desktop, long press on a phone, via the shared
// useRowMenu gestures — plus double-click, which is what a tab strip trains you
// to try. useRowMenu wants a menu position; a rename box opens in place, so the
// coordinates go unused.
function TabChip({ tab, index, active, editing, draft, onPick, onRenameStart, onDraft, onCommit, onCancel, onClose }: {
  tab: TerminalTab; index: number; active: boolean; editing: boolean; draft: string;
  onPick: () => void; onRenameStart: () => void; onDraft: (v: string) => void;
  onCommit: () => void; onCancel: () => void; onClose: () => void;
}) {
  const menu = useRowMenu(onRenameStart);
  // Falls back to the position, so an unnamed tab still has something to click.
  const label = tab.name || String(index + 1);

  return (
    <span className={"term-tab" + (active ? " on" : "")}>
      {editing ? (
        <input className="term-tab-edit" autoFocus value={draft} maxLength={MAX_TAB_NAME}
          aria-label={`Rename terminal ${label}`}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            // Keep both out of the shell underneath, which is still mounted.
            e.stopPropagation();
            if (e.key === "Enter") onCommit();
            else if (e.key === "Escape") onCancel();
          }} />
      ) : (
        <>
          <button role="tab" aria-selected={active} title={`${label} — right-click or double-click to rename`}
            onClick={onPick} onDoubleClick={onRenameStart} {...menu}>
            {label}
          </button>
          <button className="term-tab-x" aria-label={`Close terminal ${label}`} onClick={onClose}><IconX /></button>
        </>
      )}
    </span>
  );
}

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
      // The app's --mono, spelled out: xterm measures glyphs on a canvas and
      // builds a `ctx.font` string, where a var() would not resolve. Consolas is
      // the one addition — a terminal on Windows wants a terminal face.
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#0b0f14" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => sendTerminalInput(id, data));

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
  const [tabs, setTabs] = useState<TerminalTab[] | null>(null);
  const [active, setActive] = useState("");
  // The tab being renamed, and the text in its box. Null is the ordinary state.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listTerminals().then((found) => {
      if (cancelled) return;
      const initial = found.length ? found : [{ id: newTerminalId(), name: "" }];
      setTabs(initial);
      setActive(initial[0].id);
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
      const at = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (!next.length) onEmpty();
      setActive((cur) => (cur === id ? next[Math.max(0, at - 1)]?.id ?? "" : cur));
      return next;
    });
  };

  const addTab = () => {
    const id = newTerminalId();
    setTabs((prev) => [...(prev ?? []), { id, name: "" }]);
    setActive(id);
  };

  const commitRename = () => {
    if (!editing) return;
    const name = draft.trim().slice(0, MAX_TAB_NAME);
    setTabs((prev) => prev?.map((t) => (t.id === editing ? { ...t, name } : t)) ?? prev);
    void renameTerminal(editing, name);
    setEditing(null);
  };

  return (
    <div className="term-panel" role="region" aria-label="Terminal" style={{ height }}>
      <ResizeHandle className="term-resize" label="Resize the terminal panel" edge="top" axis="y"
        size={height} min={MIN_TERMINAL_HEIGHT} max={MAX_TERMINAL_HEIGHT} clamp={clampTerminalHeight}
        onSize={setHeight} onCommit={saveTerminalHeight} />
      <div className="term-tabs" role="tablist">
        {(tabs ?? []).map((t, i) => (
          <TabChip key={t.id} tab={t} index={i} active={t.id === active}
            editing={editing === t.id} draft={draft}
            onPick={() => setActive(t.id)}
            onRenameStart={() => { setEditing(t.id); setDraft(t.name); }}
            onDraft={setDraft} onCommit={commitRename} onCancel={() => setEditing(null)}
            onClose={() => { void stopTerminal(t.id); dropTab(t.id); }} />
        ))}
        <button className="term-newtab" aria-label="New terminal" onClick={addTab}><IconPlus /></button>
      </div>
      {(tabs ?? []).map((t) => (
        <TermTab key={t.id} id={t.id} cwd={cwd} active={t.id === active} onExit={dropTab} />
      ))}
    </div>
  );
}
