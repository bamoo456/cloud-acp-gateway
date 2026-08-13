import { useRef } from "react";

// Drag a panel's edge to set its size. A separator rather than a bare div: it
// is focusable and answers the arrow keys, so the panel is resizable without a
// pointer. `edge` names which of the panel's edges the handle sits on — for a
// right-anchored panel that's its left edge, so the border moving left is the
// panel growing; a left-anchored (or, on the `"y"` axis, bottom-anchored)
// panel grows the other way. `axis` picks which pointer coordinate and arrow
// keys drive the drag: `"x"` for a width handle (the original use), `"y"` for
// a height handle (e.g. a bottom-docked panel resized from its top edge).
export function ResizeHandle({ className, label, edge, axis, size, min, max, clamp, onSize, onCommit }: {
  className: string; label: string; edge: "left" | "right" | "top"; axis: "x" | "y";
  size: number; min: number; max: number;
  clamp: (px: number) => number;
  onSize: (px: number) => void; onCommit: (px: number) => void;
}) {
  const latest = useRef(size);
  latest.current = size;
  const sign = edge === "left" || edge === "top" ? -1 : 1;
  const resizingClass = axis === "y" ? "resizing-v" : "resizing";

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = axis === "y" ? e.clientY : e.clientX;
    const startSize = size;
    // Dragging over the chat would otherwise select its text, and the cursor
    // would flicker back to a caret the moment it left the 6px handle.
    document.body.classList.add(resizingClass);
    const move = (ev: PointerEvent) => {
      const pos = axis === "y" ? ev.clientY : ev.clientX;
      const next = clamp(startSize + sign * (pos - start));
      latest.current = next;
      onSize(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove(resizingClass);
      onCommit(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 12;
    // The arrow that points away from the panel grows it. On the y axis, Up
    // plays the role Left plays on x (both are the negative-coordinate
    // direction), so it takes the same -sign coefficient.
    const [decKey, incKey] = axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    const delta = e.key === decKey ? -sign * step : e.key === incKey ? sign * step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = clamp(size + delta);
    onSize(next);
    onCommit(next);
  };

  return (
    <div className={className} role="separator" aria-orientation={axis === "y" ? "horizontal" : "vertical"} tabIndex={0}
      aria-label={label} aria-valuenow={size}
      aria-valuemin={min} aria-valuemax={max}
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
  );
}
