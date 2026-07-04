import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

describe("CopyButton", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.restoreAllMocks();
    vi.useRealTimers();
    container.remove();
  });

  test("copies the given text and flips to a 'Copied' state", async () => {
    vi.useFakeTimers();
    const copyText = vi.fn(async () => true);
    vi.doMock("../lib/clipboard.ts", () => ({ copyText }));
    const { CopyButton } = await import("./CopyButton.tsx");

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(CopyButton, { text: "hello world", label: "Copy message" }));
    });

    const btn = container.querySelector("button.msg-copy") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("Copy");

    await act(async () => { btn.click(); });
    expect(copyText).toHaveBeenCalledWith("hello world");
    expect(btn.classList.contains("copied")).toBe(true);
    expect(btn.textContent).toContain("Copied");

    // reverts after the acknowledgement window
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(btn.classList.contains("copied")).toBe(false);
    expect(btn.textContent).toContain("Copy");
  });

  test("stays in the default state when the copy fails", async () => {
    const copyText = vi.fn(async () => false);
    vi.doMock("../lib/clipboard.ts", () => ({ copyText }));
    const { CopyButton } = await import("./CopyButton.tsx");

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(CopyButton, { text: "x", label: "Copy reply" }));
    });

    const btn = container.querySelector("button.msg-copy") as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(btn.classList.contains("copied")).toBe(false);
  });
});
