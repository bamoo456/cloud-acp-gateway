import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Markdown } from "./Markdown.tsx";

// The copy button is injected as HTML (lib/markdown.ts) and handled by the
// delegated click on .md — so the wiring only exists once something clicks it.
describe("Markdown code copy", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  const copied: string[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    copied.length = 0;
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async (t: string) => { copied.push(t); }) } });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container.remove();
  });

  test("copies the block's source and acknowledges the click", async () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(Markdown, { text: "```js\nconst a = 1;\n```" }));
    });
    const btn = container.querySelector<HTMLButtonElement>(".md-copy")!;
    expect(btn).not.toBeNull();

    // The click lands on the icon, not the button — .closest() is what makes
    // the delegated handler find it.
    await act(async () => { btn.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(copied).toEqual(["const a = 1;\n"]);
    expect(btn.classList.contains("copied")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Copied");
  });
});
