import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { RunningTask } from "../lib/api.ts";

describe("RunningTasks", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  function cfg() {
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath":"/acp","token":"t","defaultAgent":"claude",
      "agents":[{"name":"claude","cwd":"/c"},{"name":"codex","cwd":"/p","skin":"codex"}],"fsRoot":"/"}</script>`;
  }

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    cfg();
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function render() {
    const { RunningTasks } = await import("./RunningTasks.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(RunningTasks));
    });
  }

  async function setRunning(tasks: RunningTask[], extra: Record<string, unknown> = {}) {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentName: "claude", activeId: "active-1", runningTasks: tasks, ...extra });
    return useStore;
  }

  test("renders nothing when no tasks are running", async () => {
    await setRunning([]);
    await render();
    expect(container.querySelector(".running-btn")).toBeNull();
  });

  test("ignores the session the user is already viewing", async () => {
    await setRunning([{ agentName: "claude", sessionId: "active-1", state: "active" }]);
    await render();
    expect(container.querySelector(".running-btn")).toBeNull();
  });

  test("badges the count of other running tasks and lists them on click", async () => {
    await setRunning([
      { agentName: "claude", sessionId: "active-1", state: "active" }, // the active one — excluded
      { agentName: "claude", sessionId: "other-1", state: "active" },
      { agentName: "codex", sessionId: "other-2", state: "awaiting-input" },
    ]);
    await render();

    expect(container.querySelector(".running-btn .badge")?.textContent).toBe("2");

    const btn = container.querySelector<HTMLButtonElement>(".running-btn");
    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const items = container.querySelectorAll(".running-item");
    expect(items.length).toBe(2);
    // The awaiting-input task is flagged distinctly.
    expect(container.querySelector(".running-state.awaiting-input")?.textContent).toBe("Needs input");
  });

  test("shows the gateway-reported folder for a cross-device task not in recents", async () => {
    // A task running on another device for another agent — this client has no
    // recents for it, so only the gateway's cwd can name the folder.
    await setRunning([{ agentName: "codex", sessionId: "remote-1", state: "active", cwd: "/Users/me/work/api-server" }]);
    await render();
    const btn = container.querySelector<HTMLButtonElement>(".running-btn");
    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".folder-name")?.textContent).toBe("api-server");
  });

  test("clicking a task calls jumpToTask with it", async () => {
    const jumpToTask = vi.fn();
    await setRunning([{ agentName: "codex", sessionId: "other-2", state: "active" }], { jumpToTask });
    await render();

    const btn = container.querySelector<HTMLButtonElement>(".running-btn");
    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const item = container.querySelector<HTMLButtonElement>(".running-item");
    await act(async () => { item?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(jumpToTask).toHaveBeenCalledWith({ agentName: "codex", sessionId: "other-2", state: "active" });
  });
});
