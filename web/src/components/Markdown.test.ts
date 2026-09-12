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

// A path in an answer becomes a link only once the gateway has placed it, and
// it is placed against the folder the answer was written from.
describe("Markdown code references", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let resolveWorkspaceRef: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp", "token": "test-token", "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    resolveWorkspaceRef = vi.fn(async (_cwd: string, p: string) =>
      p === "src/app.ts" ? { abs: "/projA/src/app.ts", path: "src/app.ts" } : null);
    vi.doMock("../lib/api.ts", () => ({ resolveWorkspaceRef }));
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    vi.doUnmock("../lib/api.ts");
  });

  async function render(text: string, cwd?: string) {
    const { Markdown } = await import("./Markdown.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Markdown, { text, cwd }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }
  const ref = (path: string) => container.querySelector<HTMLElement>(`.md-ref[data-path="${path}"]`)!;

  test("a resolved reference opens the file at its line, against the answer's own folder", async () => {
    await render("see src/app.ts:12 and e.g. missing.ts", "/projA");
    expect(resolveWorkspaceRef).toHaveBeenCalledWith("/projA", "src/app.ts");

    const hit = ref("src/app.ts");
    expect(hit.className).toBe("md-ref resolved");
    expect(hit.getAttribute("role")).toBe("link");
    expect(hit.tabIndex).toBe(0);
    expect(hit.title).toBe("src/app.ts");
    // Unresolved: the plain text it arrived as.
    const miss = ref("missing.ts");
    expect(miss.className).toBe("md-ref");
    expect(miss.hasAttribute("role")).toBe(false);
    expect(miss.hasAttribute("tabindex")).toBe(false);

    // The active conversation moves to another project; the answer does not.
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    await act(async () => {
      useStore.setState({ activeId: "s2", sessions: { s2: { id: "s2", cwd: "/projB" } as never }, openFilePreview });
    });
    await act(async () => { hit.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({
      abs: "/projA/src/app.ts", path: "src/app.ts", mode: "file", cwd: "/projA", line: 12, endLine: undefined,
    });
    // Keyboard too, since it is a link.
    await act(async () => { hit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledTimes(2);
    await act(async () => { miss.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledTimes(2);
  });

  test("without a folder to read against, references stay plain and nothing is asked", async () => {
    await render("see src/app.ts:12");
    expect(resolveWorkspaceRef).not.toHaveBeenCalled();
    expect(ref("src/app.ts").className).toBe("md-ref");
  });

  test("a stream re-rendering the same text asks once and keeps the link", async () => {
    const { Markdown } = await import("./Markdown.tsx");
    for (const text of ["see src/app", "see src/app.ts", "see src/app.ts:12 and", "see src/app.ts:12 and src/app.ts"]) {
      await act(async () => {
        root ??= createRoot(container);
        root.render(React.createElement(Markdown, { text, cwd: "/projA" }));
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(1);
    const hits = container.querySelectorAll(".md-ref.resolved[role=link]");
    expect(hits).toHaveLength(2);
  });
});
