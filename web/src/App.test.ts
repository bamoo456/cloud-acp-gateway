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
    vi.doMock("./lib/api.ts", () => ({
      getRunning,
      getInboxPending: vi.fn().mockResolvedValue([]),
      answerInbox: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, truncated: false }),
      renameSession: vi.fn(),
      listDir: vi.fn().mockResolvedValue({ root: "/", path: "/", parent: null, dirs: [] }),
      getPrefs: vi.fn().mockResolvedValue({ textSize: null, lock: null, recentSessions: [], recentFolders: [] }),
      putTextSize: vi.fn().mockResolvedValue(undefined),
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
});
