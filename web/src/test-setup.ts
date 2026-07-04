import "@testing-library/jest-dom";

const emptyRects = () => [] as unknown as DOMRectList;
const emptyRect = () => (
  typeof DOMRect === "function"
    ? new DOMRect(0, 0, 0, 0)
    : {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect
);

// CodeMirror measures text with Range APIs that jsdom does not implement.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", { value: emptyRects });
}
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { value: emptyRect });
}
