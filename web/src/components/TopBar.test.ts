import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

describe("TopBar pending permissions", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

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
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
  });

  test("opens an action panel for a permission waiting in another session", async () => {
    const { TopBar } = await import("./TopBar.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    const answerInboxItem = vi.fn();

    useStore.setState({
      conn: "connected",
      agentReady: true,
      activeId: "active-session",
      sessions: {
        "active-session": { ...makeSession("active-session"), title: "Active chat" },
        "waiting-session": { ...makeSession("waiting-session"), title: "Waiting chat" },
      },
      inboxItems: [{
        id: 1,
        type: "permission",
        reqId: "88",
        sessionId: "waiting-session",
        agentName: "claude",
        title: "Edit first session file",
        options: [
          { optionId: "deny", kind: "reject_once", name: "Deny" },
          { optionId: "allow", kind: "allow_once", name: "Allow" },
        ],
        status: "pending",
        createdAt: "2026-06-10T00:00:00.000Z",
      }],
      answerInboxItem,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(TopBar, { onPanel: vi.fn(), onPicker: vi.fn() }));
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[title="Pending permissions"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("1");

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Waiting chat");
    expect(container.textContent).toContain("Edit first session file");

    const deny = [...container.querySelectorAll("button")].find((button) => button.textContent === "Deny");
    expect(deny).toBeDefined();
    await act(async () => {
      deny?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(answerInboxItem).toHaveBeenCalledWith("claude", "88", "deny");
  });

  test("the + button starts a new chat when the agent is ready", async () => {
    const { TopBar } = await import("./TopBar.tsx");
    const { useStore } = await import("../store/store.ts");
    const newSession = vi.fn();
    useStore.setState({ conn: "connected", agentReady: true, newSession });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(TopBar, { onPanel: vi.fn(), onPicker: vi.fn() }));
    });

    const plus = container.querySelector<HTMLButtonElement>('button[title="New chat"]');
    expect(plus).not.toBeNull();
    await act(async () => { plus?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  test("the + button does nothing until the agent is ready", async () => {
    const { TopBar } = await import("./TopBar.tsx");
    const { useStore } = await import("../store/store.ts");
    const newSession = vi.fn();
    useStore.setState({ conn: "connecting", agentReady: false, newSession });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(TopBar, { onPanel: vi.fn(), onPicker: vi.fn() }));
    });

    const plus = container.querySelector<HTMLButtonElement>('button[title="New chat"]');
    await act(async () => { plus?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(newSession).not.toHaveBeenCalled();
  });

  test("folder chip shows the cwd basename and opens the picker", async () => {
    const { TopBar } = await import("./TopBar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ conn: "connected", cwd: "/repo" });
    const onPicker = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(TopBar, { onPanel: vi.fn(), onPicker }));
    });

    const chip = container.querySelector<HTMLButtonElement>("button.folder-chip");
    expect(chip?.textContent).toContain("repo");
    await act(async () => { chip?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onPicker).toHaveBeenCalled();
  });
});
