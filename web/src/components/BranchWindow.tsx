import { useEffect, useRef, useState } from "react";
import { useStore, type SideWindow } from "../store/store.ts";
import { Thread } from "./Thread.tsx";
import { Composer } from "./Composer.tsx";
import { EngineDock } from "./EngineDock.tsx";
import { IconBack, IconX } from "../lib/icons.tsx";
import { timeAgo } from "../lib/format.ts";
import { DESKTOP_SIDEBAR_QUERY, isDesktopSidebarWidth } from "../lib/sidebarWidth.ts";

// Where the card has been dragged to, in viewport pixels. Null means "still at
// the stylesheet's default corner" — drag only ever switches the card into
// pixel-tracked mode, never back.
interface DragPos { left: number; top: number; }
interface CardSize { w: number; h: number; }
// Which corner is being pulled. The two letters are the edges it moves, so the
// handler derives everything from them instead of switching on four cases.
type Corner = "nw" | "ne" | "sw" | "se";
// Floors, matching the stylesheet's min-width/min-height: below this the thread
// stops being readable and the composer starts wrapping onto itself.
const MIN_W = 300, MIN_H = 240;
// How far each cascade slot offsets the default corner, so several open cards
// don't land exactly on top of each other. The stylesheet owns slot 0.
const SLOT_STEP = 22;
// The card stack sits between the side panels (25 as desktop columns, 36 as the
// mobile overlay) and the popovers and scrims at 40+ — see the .branch-win rule
// in styles.css. Three cards fit in that gap, which is MAX_SIDE_WINDOWS.
const Z_BASE = 37;

// The floating conversations (store.ts's `sideWindows`), over whatever thread is
// in the main column. Cards on desktop, full-screen sheets on a phone — where
// several stack and only the front-most is visible, which is the right answer for
// a modal sheet and is why nothing here tries to tab between them.
export function BranchWindow() {
  const wins = useStore((s) => s.sideWindows);
  // Every entry is mounted, including the one that's hidden right now (its own
  // conversation is the one on screen): a card that unmounted would come back at
  // the default corner, throwing away wherever the reader dragged it to. Keyed on
  // the branch's PARENT where there is one, because a branch's own id changes once
  // — when the provisional id is swapped for what session/fork returns — and
  // remounting there yanked a window the reader had just dragged. The "b:"/"s:"
  // prefixes keep a branch of X and a side chat on X from colliding.
  return (
    <>
      {wins.map((w, i) => (
        <BranchCard key={w.parentId ? "b:" + w.parentId : "s:" + w.sessionId} win={w} depth={i} />
      ))}
    </>
  );
}

// One card. Its own component so its drag position, size and desktop/sheet mode
// are its own state — the container re-renders on every raise, and shared state
// would mean one card's drag moving all of them.
function BranchCard({ win, depth }: { win: SideWindow; depth: number }) {
  const s = useStore();

  // Desktop vs phone is a fork this component has to know about, not just the
  // stylesheet's problem: dragging only makes sense for the floating card, and
  // the close button reads differently in each. Reactive, like FilePanel's own
  // `desktop` state, so resizing across the breakpoint mid-session doesn't
  // strand the card in the wrong mode until a remount.
  const [desktop, setDesktop] = useState(isDesktopSidebarWidth);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP_SIDEBAR_QUERY);
    if (!mq) return;
    const sync = () => setDesktop(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Hidden, not closed, while its own conversation is the one in the main column:
  // the same thread twice reads as a duplicate, and switching away brings the
  // window back exactly as it was. Also hidden when the live session behind it has
  // been evicted, which leaves it nothing to render. Derived up here, not at the
  // early return, because the Escape listener below has to know whether the window
  // is actually on screen.
  const session = s.sessions[win.sessionId];
  const open = !!session && s.activeId !== win.sessionId;

  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DragPos | null>(null);
  const [size, setSize] = useState<CardSize | null>(null);
  // Ends a drag in progress. Held in a ref so unmounting mid-drag (closing the
  // window with the pointer still down) can run it: the listeners live on
  // `window` and the grab cursor on <body>, so neither goes away with the card,
  // and a stranded `branch-dragging` leaves the whole page unselectable.
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  // Escape closes the front-most window, as a dialog should. On the document
  // rather than the card (the way ActionMenu does it) because the focus is usually
  // somewhere else entirely — in the main thread, or nowhere at all right after a
  // drag — and a handler on the card would never see the key. `defaultPrevented`
  // is the handoff: the window's own composer consumes Escape to dismiss its
  // slash/file menu (Composer's onEscape returns true, which preventDefaults), so
  // it only takes the key nobody else wanted. Every mounted card listens, and each
  // ignores the key unless it is the last one on screen — that one is the card the
  // reader means.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const st = useStore.getState();
      const front = st.sideWindows.filter((w) => st.sessions[w.sessionId] && st.activeId !== w.sessionId).at(-1);
      if (front?.sessionId === win.sessionId) st.closeSideWindow(win.sessionId);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, win.sessionId]);

  // Pull a corner. Every corner is the same arithmetic once the card is switched
  // to left/top anchoring on pointerdown: the two edges the corner does NOT touch
  // stay put, which is the whole expectation behind dragging a corner. (The
  // stylesheet anchors the card by right/bottom, so without that switch a
  // south-east pull would move the left edge instead of the right one.)
  const onCornerPointerDown = (corner: Corner) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // a corner is not the header: never start a move as well
    const card = cardRef.current;
    if (!card) return;
    const r = card.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const west = corner === "nw" || corner === "sw";
    const north = corner === "nw" || corner === "ne";
    document.body.classList.add("branch-dragging");
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let w = Math.max(MIN_W, west ? r.width - dx : r.width + dx);
      let h = Math.max(MIN_H, north ? r.height - dy : r.height + dy);
      // Pin the opposite edges, then give back whatever ran off the viewport, so
      // a corner pulled past the screen stops instead of hiding half the card.
      let left = west ? r.right - w : r.left;
      let top = north ? r.bottom - h : r.top;
      if (left < 0) { w += left; left = 0; }
      if (top < 0) { h += top; top = 0; }
      setPos({ left, top });
      setSize({
        w: Math.max(MIN_W, Math.min(w, window.innerWidth - left)),
        h: Math.max(MIN_H, Math.min(h, window.innerHeight - top)),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("branch-dragging");
      endDrag.current = null;
    };
    endDrag.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top;
    document.body.classList.add("branch-dragging");
    const move = (ev: PointerEvent) => {
      // left/top are offsets inside the card's offset parent (the conversation
      // column — see the .branch-win desktop rule), so the pointer delta has to
      // be converted out of viewport space before it can be clamped. Both boxes
      // are re-read each frame rather than cached at drag-start, so a window
      // resized (or a panel opened) mid-drag still can't strand the card outside
      // its column.
      const host = (card.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      const originX = host?.left ?? 0, originY = host?.top ?? 0;
      const maxLeft = Math.max(0, (host?.width ?? window.innerWidth) - rect.width);
      const maxTop = Math.max(0, (host?.height ?? window.innerHeight) - rect.height);
      setPos({
        left: Math.min(Math.max(0, startLeft - originX + (ev.clientX - startX)), maxLeft),
        top: Math.min(Math.max(0, startTop - originY + (ev.clientY - startY)), maxTop),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("branch-dragging");
      endDrag.current = null;
    };
    endDrag.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!open || !session) return null;

  // Cascade the default corner by the card's slot so two windows opened back to
  // back are both grabbable, and shorten the height cap by the same step so the
  // offset can't push a full-height card off the top of the screen. Dropped the
  // moment the card is dragged: from then on it is pixel-tracked. `depth` is the
  // card's place in the list, which is the z-order — raising one is a reorder, so
  // this has to come from the list rather than from the slot.
  const style = desktop
    ? {
        zIndex: Z_BASE + depth,
        ...(pos
          ? { left: pos.left, top: pos.top, right: "auto" as const, bottom: "auto" as const }
          : {
              right: 20 + win.slot * SLOT_STEP,
              bottom: 108 + win.slot * SLOT_STEP,
              maxHeight: `calc(100vh - ${140 + win.slot * SLOT_STEP}px)`,
            }),
        ...(size ? { width: size.w, height: size.h } : {}),
      }
    : { zIndex: Z_BASE + depth };

  return (
    <div ref={cardRef} className="branch-win" role="dialog" aria-labelledby={"branch-win-title-" + win.sessionId}
      // Whatever is being touched belongs on top — cascaded cards overlap by
      // design. Capture, so it fires before the header's own drag handler and
      // before the composer swallows the event.
      onPointerDownCapture={() => s.raiseSideWindow(win.sessionId)}
      style={style}>
      <div className="branch-win-head" onPointerDown={desktop ? onHeaderPointerDown : undefined}>
        <span className="branch-win-title" id={"branch-win-title-" + win.sessionId} title={session.title}>{session.title}</span>
        <span className="branch-win-time">{timeAgo(new Date(session.lastActiveAt).toISOString())}</span>
        <button type="button" className="icon-btn" onPointerDown={(e) => e.stopPropagation()}
          aria-label={desktop ? "Close this conversation's window" : "Back to the main conversation"}
          onClick={() => s.closeSideWindow(win.sessionId)}>
          {desktop ? <IconX /> : <IconBack />}
        </button>
      </div>
      {/* A real <main>, not a styled <div>: see the .branch-win-body comment in
          styles.css — Thread walks up to the nearest <main> to find its own
          scroll container, and nothing else here stands in for one. `role=group`
          because the tag is load-bearing for that lookup but the landmark isn't:
          App's own <main> is the page's one main region, and a second one would
          make "jump to main content" ambiguous. */}
      <main className="branch-win-body" role="group">
        <Thread session={session} agentReady={s.agentReady} loading={false}
          findOpen={false} focusFind={0} onCloseFind={() => {}} />
      </main>
      {/* The window opens before the fork answers (store.ts's branchSession),
          so until the provisional id is swapped for the real one there is no
          session the agent could be prompted about — say so where the input
          would be, rather than offering a composer that would fail. */}
      {win.sessionId.startsWith("pending-")
        ? <div className="branch-win-wait" role="status"><span className="spinner" />Creating the branch…</div>
        : (
          <>
            {/* This conversation's own engine readout and pickers, bound to it —
                a side chat runs on its own model and mode, and without a dock of
                its own the card could only be read, never re-aimed. */}
            <EngineDock sessionId={win.sessionId} />
            <Composer sessionId={win.sessionId} compact />
          </>
        )}
      {/* One grip per corner, rather than the browser's own `resize`, which only
          ever draws the south-east one. Sheet mode gets none: a full-screen sheet
          has no corner to pull. */}
      {desktop && (["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
        <div key={c} className={"branch-win-grip " + c} onPointerDown={onCornerPointerDown(c)} aria-hidden="true" />
      ))}
    </div>
  );
}
