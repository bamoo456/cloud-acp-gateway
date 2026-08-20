import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { installFakeSse } from "./test/fakeSse.ts";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("App running-task polling", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getRunning: ReturnType<typeof vi.fn>;
  let getInboxPending: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token":"t","defaultAgent":"claude",
      "agents":[{"name":"claude","cwd":"/c"}],"fsRoot":"/"}</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    setVisibility("visible");
    getRunning = vi.fn().mockResolvedValue([]);
    getInboxPending = vi.fn().mockResolvedValue([]);
    vi.doMock("./lib/api.ts", () => ({
      getRunning,
      getInboxPending,
      getUsageLimits: vi.fn().mockResolvedValue(null),
      answerInbox: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue([]),
      getDiscoveredHistory: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, truncated: false }),
      renameSession: vi.fn(),
      listDir: vi.fn().mockResolvedValue({ root: "/", path: "/", parent: null, dirs: [] }),
      getPrefs: vi.fn().mockResolvedValue({ textSize: null, lock: null, recentSessions: [], recentFolders: [], hiddenFolders: [] }),
      putTextSize: vi.fn().mockResolvedValue(undefined),
      // The status bar's diffstat: the file panel reads the checkout even
      // while it is shut, so App-level renders touch this route too.
      getWorkspaceChanges: vi.fn().mockResolvedValue({ repo: null, files: [], truncated: false }),
    }));
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock("./lib/api.ts");
    document.body.innerHTML = "";
  });

  async function render() {
    const { App } = await import("./App.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
  }

  test("polls once on mount and again on each interval while visible", async () => {
    await render();
    expect(getRunning).toHaveBeenCalledTimes(1); // initial tick
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getRunning).toHaveBeenCalledTimes(2);
  });

  test("skips the poll while the tab is hidden, then refreshes when it returns", async () => {
    await render();
    expect(getRunning).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getRunning).toHaveBeenCalledTimes(1); // interval fired but the request was skipped

    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(getRunning).toHaveBeenCalledTimes(2); // immediate refresh on return to foreground
  });

  test("a failed inbox poll preserves prompt state that changed while it was in flight", async () => {
    let resolveInbox!: (value: null) => void;
    getInboxPending.mockReturnValueOnce(new Promise<null>((resolve) => { resolveInbox = resolve; }));
    await render();
    expect(getInboxPending).toHaveBeenCalledTimes(1);

    const { useStore } = await import("./store/store.ts");
    const item = {
      id: 1, type: "permission", agentName: "claude", sessionId: "S", reqId: "99",
      title: "Edit", options: [], status: "pending", createdAt: "now",
    };
    act(() => { useStore.setState({ inboxItems: [item] }); });

    await act(async () => {
      resolveInbox(null);
      await Promise.resolve();
    });

    expect(useStore.getState().inboxItems).toEqual([item]);
  });

  // Shares this block's mocks rather than standing up a second App harness.
  // Cmd-Shift-F is the cross-session search: it has to reveal the sidebar and
  // land in its box, and `key` arrives uppercased because Shift is held.
  test("Cmd-Shift-F reveals the sidebar and focuses its search box", async () => {
    await render();
    const input = () => container.querySelector<HTMLInputElement>("#panel .search input");
    expect(document.activeElement).not.toBe(input());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true, bubbles: true }));
    });

    expect(container.querySelector("#panel")?.classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(input());
    // ...and it is NOT the in-conversation find, which Cmd-F alone owns.
    expect(container.querySelector(".thread-find")).toBeNull();
  });

  // The bar's own autoFocus only fires on the press that mounts it, so a second
  // press has to put the caret back and select the old term to type over.
  test("Cmd-F focuses the find box and selects the term already in it", async () => {
    await render();
    const press = async () => {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
      });
    };
    await press();
    const input = container.querySelector<HTMLInputElement>(".thread-find input")!;
    expect(document.activeElement).toBe(input);

    await act(async () => {
      // React tracks the value itself, so a plain `input.value =` is ignored.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "deploy");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.blur();
    expect(document.activeElement).not.toBe(input);

    await press();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("deploy".length);
  });

  test("the status bar carries the diffstat", async () => {
    await render();
    const { useStore } = await import("./store/store.ts");
    act(() => {
      useStore.setState({ changeStat: { files: 7, additions: 128, deletions: 35 } });
    });

    expect(container.querySelector(".statusbar")?.textContent).toContain("7 files");
  });
});
