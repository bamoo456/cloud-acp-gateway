import { useRef } from "react";

// Drag a panel's edge to set its width. A separator rather than a bare div: it
// is focusable and answers the arrow keys, so the panel is resizable without a
// pointer. `edge` names which of the panel's edges the handle sits on — for a
// right-anchored panel that's its left edge, so the border moving left is the
// panel growing; a left-anchored panel grows the other way.
export function ResizeHandle({ className, label, edge, width, min, max, clamp, onWidth, onCommit }: {
  className: string; label: string; edge: "left" | "right";
  width: number; min: number; max: number;
  clamp: (px: number) => number;
  onWidth: (px: number) => void; onCommit: (px: number) => void;
}) {
  const latest = useRef(width);
  latest.current = width;
  const sign = edge === "left" ? -1 : 1;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    // Dragging over the chat would otherwise select its text, and the cursor
    // would flicker back to a caret the moment it left the 6px handle.
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const next = clamp(startW + sign * (ev.clientX - startX));
      latest.current = next;
      onWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      onCommit(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 12;
    // The arrow that points away from the panel widens it.
    const delta = e.key === "ArrowLeft" ? -sign * step : e.key === "ArrowRight" ? sign * step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = clamp(width + delta);
    onWidth(next);
    onCommit(next);
  };

  return (
    <div className={className} role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={label} aria-valuenow={width}
      aria-valuemin={min} aria-valuemax={max}
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
  );
}
