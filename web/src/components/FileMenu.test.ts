import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FileMenu, useRowMenu, type FileMenuTarget } from "./FileMenu.tsx";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

// jsdom has no PointerEvent, and React reads pointerType off the native event to
// tell a finger from a mouse — so the tests have to supply it.
function pointer(type: string, init: { pointerType?: string; clientX?: number; clientY?: number } = {}) {
  const e = new MouseEvent(type, { bubbles: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
  Object.defineProperty(e, "pointerType", { value: init.pointerType ?? "touch" });
  return e;
}

const TARGET: FileMenuTarget = {
  abs: "/repo/web/src/FileTree.tsx", name: "FileTree.tsx", dir: "web/src", isDir: false, x: 40, y: 60,
};

describe("useRowMenu", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let onOpen: ReturnType<typeof vi.fn>;
  let onClick: ReturnType<typeof vi.fn>;

  // A row exactly as the panel builds one: its own click opens the file, the
  // hook's handlers are spread on top.
  function Row() {
    const menu = useRowMenu((x, y) => onOpen(x, y));
    return React.createElement("button", { className: "wf-row", onClick, ...menu }, "FileTree.tsx");
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    onOpen = vi.fn();
    onClick = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Row));
    });
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    container.remove();
    vi.useRealTimers();
  });

  const row = () => container.querySelector("button")!;

  test("a long press opens the menu where the finger was", async () => {
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { clientX: 120, clientY: 240 })); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(onOpen).toHaveBeenCalledWith(120, 240);
  });

  test("a tap opens the file instead — the press has to last", async () => {
    await act(async () => { row().dispatchEvent(pointer("pointerdown")); });
    await act(async () => { vi.advanceTimersByTime(120); });
    await act(async () => { row().dispatchEvent(pointer("pointerup")); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("scrolling the list is not a long press", async () => {
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { clientX: 100, clientY: 200 })); });
    // A finger that has travelled 40px is scrolling, not holding.
    await act(async () => { row().dispatchEvent(pointer("pointermove", { clientX: 100, clientY: 240 })); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("a finger that only trembles still counts as holding", async () => {
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { clientX: 100, clientY: 200 })); });
    await act(async () => { row().dispatchEvent(pointer("pointermove", { clientX: 103, clientY: 204 })); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(onOpen).toHaveBeenCalled();
  });

  test("the click that ends a long press does not also open the file", async () => {
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 20 })); });
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => { row().dispatchEvent(pointer("pointerup")); });
    await act(async () => { row().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    // …and the next, ordinary click still does.
    await act(async () => { row().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a dismissed menu doesn't leave the row needing two taps", async () => {
    // The click that ends a long press lands on the menu's scrim, not on the
    // row — so the row never sees the click that would clear its suppression.
    // The next tap has to open the file, not be swallowed as that one's tail.
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 20 })); });
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => { row().dispatchEvent(pointer("pointerup")); });
    expect(onOpen).toHaveBeenCalledTimes(1);

    // …the menu is dismissed somewhere else, and the row is tapped again.
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 20 })); });
    await act(async () => { row().dispatchEvent(pointer("pointerup")); });
    await act(async () => { row().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("holding a mouse button down selects text — only its right button opens the menu", async () => {
    await act(async () => { row().dispatchEvent(pointer("pointerdown", { pointerType: "mouse" })); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(onOpen).not.toHaveBeenCalled();

    await act(async () => { row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 15, clientY: 25 })); });
    expect(onOpen).toHaveBeenCalledWith(15, 25);
  });
});

describe("FileMenu", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    container.remove();
  });

  async function render(props: Partial<Parameters<typeof FileMenu>[0]> = {}) {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(FileMenu, {
        target: TARGET, canAttach: true,
        onAttach: vi.fn(), onOpen: vi.fn(), onCopyPath: vi.fn(), onClose: vi.fn(),
        ...props,
      }));
    });
    await act(async () => { await flush(); });
  }

  const labels = () => [...container.querySelectorAll(".wf-menu-row")].map((b) => b.textContent);

  test("names the file it is about, and what can be done with it", async () => {
    await render();
    expect(container.querySelector(".wf-menu-head .nm")?.textContent).toBe("FileTree.tsx");
    expect(container.querySelector(".wf-menu-head .dir")?.textContent).toBe("web/src");
    expect(labels()).toEqual(["Add to chat", "Open", "Copy path"]);
  });

  test("picking an action runs it and closes the menu", async () => {
    const onAttach = vi.fn();
    const onClose = vi.fn();
    await render({ onAttach, onClose });
    await act(async () => {
      container.querySelector<HTMLElement>(".wf-menu-row")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onAttach).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test("no 'Add to chat' when the agent takes no file references", async () => {
    // Offering it would produce a chip the send path silently drops.
    await render({ canAttach: false });
    expect(labels()).toEqual(["Open", "Copy path"]);
  });

  test("a folder is a path to copy, not a file to attach or open", async () => {
    await render({ target: { ...TARGET, name: "components", isDir: true }, onOpen: undefined });
    expect(labels()).toEqual(["Copy path"]);
  });

  test("Escape closes it", async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalled();
  });
});
