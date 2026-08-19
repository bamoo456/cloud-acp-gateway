import { useEffect, useRef, useState } from "react";
import { IconAddToChat, IconFile, IconFolder, IconCopy } from "../lib/icons.tsx";

// The file panel's context menu: what you can do with a row other than open it.
//
// Right-click is the gesture this is named after, but the console is driven from
// a phone as often as from a desktop, so a long press has to reach the same
// menu — and on a phone the menu arrives as a bottom sheet, the way .amenu
// already switches. Same component, one positioning branch.
//
// The row's own click is untouched: tapping a file still opens it. Only the
// second gesture is new.

// How long a press has to last to be a press rather than a tap. 500ms is the
// platform default (iOS's own callout, Android's long-click) — shorter and an
// ordinary tap on a slow finger opens the menu instead of the file.
const LONG_PRESS_MS = 500;
// A finger never holds perfectly still. Anything beyond this is a scroll, and
// scrolling the tree must not end in a menu.
const MOVE_SLOP_PX = 10;

export interface FileMenuTarget {
  abs: string;
  name: string;   // what the menu calls the file
  dir: string;    // the folder line under it, may be empty
  // The folder `dir` reads against, and the one the gateway must resolve the
  // file under — not always the conversation's own, since the Project tab can
  // browse another checkout. Unset means the conversation's folder.
  base?: string;
  isDir: boolean;
  x: number;
  y: number;
}

// The gestures that open the menu, as props for one row. Returned as an object
// to spread, because every row that has a menu needs all five and forgetting the
// cancels leaves a menu that opens after you have scrolled away.
export function useRowMenu(open: (x: number, y: number) => void) {
  const timer = useRef(0);
  const from = useRef({ x: 0, y: 0 });
  // A long press that fired must not also count as a click, or the row opens
  // the file behind the menu it just opened.
  const fired = useRef(false);
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = 0; } };
  useEffect(() => cancel, []);

  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancel();
      open(e.clientX, e.clientY);
    },
    onPointerDown: (e: React.PointerEvent) => {
      // A new gesture, however the last one ended. The click that would
      // otherwise clear this flag lands on the menu's scrim, not on the row —
      // so without resetting here, a dismissed menu leaves the row needing two
      // taps to open its file.
      fired.current = false;
      // A mouse already has a right button; a long left-press with one is how
      // you select text, not how you ask for a menu.
      if (e.pointerType === "mouse") return;
      from.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = 0;
        fired.current = true;
        open(from.current.x, from.current.y);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!timer.current) return;
      if (Math.abs(e.clientX - from.current.x) > MOVE_SLOP_PX
        || Math.abs(e.clientY - from.current.y) > MOVE_SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

// Roughly what the menu measures, for keeping it on screen. Exact enough: the
// menu has a fixed width and three rows at most, and being a few pixels out
// only matters within a few pixels of an edge.
const MENU_W = 214;
const MENU_H = 220;
const SHEET_QUERY = "(max-width: 640px)"; // matches .amenu's own sheet breakpoint

export function FileMenu({ target, canAttach, onAttach, onOpen, onCopyPath, onClose }: {
  target: FileMenuTarget;
  // False when the agent takes no file references at all — the same capability
  // the composer's "@" button is gated on. Attaching a chip the send path would
  // silently drop is worse than not offering it.
  canAttach: boolean;
  onAttach: () => void;
  // Absent for a folder: expanding one is the row's own click, and this menu
  // has no way to reach into the level that owns that state.
  onOpen?: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}) {
  // Read once, on open: the menu lives for a few seconds and a device does not
  // cross the breakpoint inside them.
  const [sheet] = useState(() => !!window.matchMedia?.(SHEET_QUERY).matches);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (run: () => void) => () => { run(); onClose(); };
  // Inline positioning only in the dropdown case: as a sheet the stylesheet
  // owns the geometry, and a left/top here would override it.
  const style = sheet ? undefined : {
    left: Math.max(8, Math.min(target.x, window.innerWidth - MENU_W - 8)),
    top: Math.max(8, Math.min(target.y, window.innerHeight - MENU_H - 8)),
  };

  return (
    <>
      <div className="wf-menu-scrim" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={"wf-menu" + (sheet ? " sheet" : "")} style={style} role="menu"
        aria-label={target.name}>
        <div className="wf-menu-head">
          <div className="nm">{target.name}</div>
          {target.dir && <div className="dir">{target.dir}</div>}
        </div>
        {/* A folder has no "add to chat": the agent can walk the tree itself,
            and what you actually want attached is a file inside it. */}
        {canAttach && !target.isDir && (
          <button className="wf-menu-row accent" role="menuitem" onClick={pick(onAttach)}>
            <IconAddToChat /><span>Add to chat</span>
          </button>
        )}
        {onOpen && (
          <button className="wf-menu-row" role="menuitem" onClick={pick(onOpen)}>
            {target.isDir ? <IconFolder /> : <IconFile />}<span>Open</span>
          </button>
        )}
        <button className="wf-menu-row" role="menuitem" onClick={pick(onCopyPath)}>
          <IconCopy /><span>Copy path</span>
        </button>
      </div>
    </>
  );
}
