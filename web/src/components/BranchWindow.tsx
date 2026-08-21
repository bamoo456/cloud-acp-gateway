import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store.ts";
import { Thread } from "./Thread.tsx";
import { Composer } from "./Composer.tsx";
import { IconBack, IconX } from "../lib/icons.tsx";
import { timeAgo } from "../lib/format.ts";
import { DESKTOP_SIDEBAR_QUERY, isDesktopSidebarWidth } from "../lib/sidebarWidth.ts";

// Where the card has been dragged to, in viewport pixels. Null means "still at
// the stylesheet's default corner" — drag only ever switches the card into
// pixel-tracked mode, never back.
interface DragPos { left: number; top: number; }

// The open branch (store.ts's `branch`), floating over its parent's thread. A
// card on desktop, a full-screen sheet on a phone — never resizable in this
// version, and its position is memory-only: nothing here is persisted, so a
// reload (or opening a different branch) always starts at the default corner.
export function BranchWindow() {
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

  // Renders nothing unless the branch is open, its parent is the active
  // conversation (the window follows its parent — see store.ts's `branch` doc
  // comment), and the live session behind it hasn't been evicted. Derived up
  // here, not at the early return, because the Escape listener below has to know
  // whether the window is actually on screen.
  const branch = s.branch;
  const branchSession = branch ? s.sessions[branch.sessionId] : undefined;
  const open = !!branch && s.activeId === branch.parentId && !!branchSession;

  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DragPos | null>(null);
  // Ends a drag in progress. Held in a ref so unmounting mid-drag (closing the
  // branch with the pointer still down) can run it: the listeners live on
  // `window` and the grab cursor on <body>, so neither goes away with the card,
  // and a stranded `branch-dragging` leaves the whole page unselectable.
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);
  // This component is always mounted (App.tsx) and hides by rendering null, so
  // a dragged position would otherwise survive forever — branch B would open
  // wherever branch A was last left. Reset on every new pairing; hiding and
  // showing the SAME branch (switching away from and back to its parent)
  // leaves `sessionId` unchanged, so the position survives that as intended.
  const branchSessionId = s.branch?.sessionId;
  useEffect(() => { setPos(null); }, [branchSessionId]);

  // Escape closes it, as a dialog should. On the document rather than the card
  // (the way ActionMenu does it) because the focus is usually somewhere else
  // entirely — in the parent thread, or nowhere at all right after a drag — and a
  // handler on the card would never see the key. `defaultPrevented` is the
  // handoff: the branch's own composer consumes Escape to dismiss its slash/file
  // menu (Composer's onEscape returns true, which preventDefaults), so the window
  // only takes the key nobody else wanted.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) useStore.getState().closeBranch(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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

  if (!open || !branch || !branchSession) return null;

  return (
    <div ref={cardRef} className="branch-win" role="dialog" aria-labelledby="branch-win-title"
      // Only meaningful once dragged, and only on desktop — a phone sheet is
      // always full-screen, so a stale pixel position from an earlier desktop
      // drag must never leak into it after a resize.
      style={desktop && pos ? { left: pos.left, top: pos.top, right: "auto", bottom: "auto" } : undefined}>
      <div className="branch-win-head" onPointerDown={desktop ? onHeaderPointerDown : undefined}>
        <span className="branch-win-title" id="branch-win-title" title={branchSession.title}>{branchSession.title}</span>
        <span className="branch-win-time">{timeAgo(new Date(branchSession.lastActiveAt).toISOString())}</span>
        <button type="button" className="icon-btn" onPointerDown={(e) => e.stopPropagation()}
          aria-label={desktop ? "Close branch" : "Back to the parent conversation"} onClick={() => s.closeBranch()}>
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
        <Thread session={branchSession} agentReady={s.agentReady} loading={false}
          findOpen={false} focusFind={0} onCloseFind={() => {}} />
      </main>
      {/* The window opens before the fork answers (store.ts's branchSession),
          so until the provisional id is swapped for the real one there is no
          session the agent could be prompted about — say so where the input
          would be, rather than offering a composer that would fail. */}
      {branch.sessionId.startsWith("pending-")
        ? <div className="branch-win-wait" role="status"><span className="spinner" />Creating the branch…</div>
        : <Composer sessionId={branch.sessionId} compact />}
    </div>
  );
}
