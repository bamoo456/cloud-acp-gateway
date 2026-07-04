import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { FsResult } from "../lib/api.ts";

const FS: Record<string, FsResult> = {
  "/": { root: "/", path: "/", parent: null, dirs: [{ name: "repo", git: true }, { name: "scratch", git: false }] },
  "/repo": { root: "/", path: "/repo", parent: "/", dirs: [{ name: "web", git: false }, { name: "src", git: false }] },
  "/repo/web": { root: "/", path: "/repo/web", parent: "/repo", dirs: [] },
  "/scratch": { root: "/", path: "/scratch", parent: "/", dirs: [{ name: "kata", git: true }, { name: "tmp", git: false }] },
};

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("FolderBrowser drill-down", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let listDir: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp",
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    listDir = vi.fn((p: string) => FS[p] ? Promise.resolve(FS[p]) : Promise.reject(new Error("nope")));
    vi.doMock("../lib/api.ts", () => ({
      listDir,
      getHistory: vi.fn(),
      getMessages: vi.fn(),
      renameSession: vi.fn(),
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
  });

  async function render(props: { onUse?: (p: string) => void; onBack?: () => void; onClose?: () => void } = {}) {
    const { FolderBrowser } = await import("./FolderBrowser.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(FolderBrowser, {
        onUse: props.onUse ?? vi.fn(),
        onBack: props.onBack ?? vi.fn(),
        onClose: props.onClose ?? vi.fn(),
      }));
      await flush();
    });
  }

  test("opens with the stack seeded at the current cwd", async () => {
    await render();
    expect(container.querySelector(".fb-title")?.textContent).toBe("repo");
    expect(container.querySelector(".fb-back .lbl")?.textContent).toBe("/");
    expect(container.textContent).toContain("web");
    expect(container.textContent).toContain("src");
  });

  test("pushes into a folder and pops back", async () => {
    await render();
    const web = [...container.querySelectorAll("button.dir")].find((b) => b.textContent?.includes("web"));
    await act(async () => { web?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(container.querySelector(".fb-title")?.textContent).toBe("web");
    expect(container.textContent).toContain("No subfolders");

    const back = container.querySelector<HTMLButtonElement>(".fb-back");
    await act(async () => { back?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(container.querySelector(".fb-title")?.textContent).toBe("repo");
  });

  test("back at the root level calls onBack", async () => {
    const onBack = vi.fn();
    await render({ onBack });
    const back = container.querySelector<HTMLButtonElement>(".fb-back");
    // pop from /repo to /
    await act(async () => { back?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(container.querySelector(".fb-title")?.textContent).toBe("/");
    await act(async () => { back?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(onBack).toHaveBeenCalled();
  });

  test("filters the current page client-side", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".fb-filter input")!;
    await act(async () => {
      // go through the native setter so React's value tracker sees the change
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "we");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("web");
    expect(container.textContent).not.toContain("src");
  });

  test("'Use this folder' reports the top of the stack", async () => {
    const onUse = vi.fn();
    await render({ onUse });
    const use = [...container.querySelectorAll("button")].find((b) => b.textContent === "Use this folder");
    await act(async () => { use?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onUse).toHaveBeenCalledWith("/repo");
  });

  test("falls back to the root when cwd is outside fsRoot (prefix collision)", async () => {
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp",
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repos-other/foo" }],
      "fsRoot": "/repo"
    }</script>`;
    document.body.appendChild(container);
    listDir.mockImplementation((p: string) => p === "/repo"
      ? Promise.resolve({ root: "/repo", path: "/repo", parent: null, dirs: [{ name: "web", git: false }] })
      : Promise.reject(new Error("nope")));
    await render();
    expect(container.querySelector(".fb-title")?.textContent).toBe("repo");
    expect(container.querySelector(".fb-back .lbl")?.textContent).toBe("Folders");
  });

  test("shows an error page when listDir fails without trapping the user", async () => {
    listDir.mockImplementation((p: string) => p === "/scratch" ? Promise.reject(new Error("x")) : Promise.resolve(FS[p]));
    await render();
    // pop to root, push into the failing folder
    const back = container.querySelector<HTMLButtonElement>(".fb-back");
    await act(async () => { back?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    const scratch = [...container.querySelectorAll("button.dir")].find((b) => b.textContent?.includes("scratch"));
    await act(async () => { scratch?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(container.textContent).toContain("Couldn't list folder.");
    await act(async () => { back?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(container.querySelector(".fb-title")?.textContent).toBe("/");
  });
});
