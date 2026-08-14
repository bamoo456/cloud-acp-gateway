import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

describe("ActionMenu config options", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  function menuRows(): string[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".amenu > .arow")]
      .map((b) => b.querySelector(".col > span:first-child")?.textContent || b.textContent || "");
  }

  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath":"/acp","token":"t","defaultAgent":"codex",
      "agents":[{"name":"codex","cwd":"/p"},{"name":"claude","cwd":"/c"}],"fsRoot":"/"}</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
    vi.doUnmock("../lib/clipboard.ts");
  });

  test("leaves the engine settings to the dock, and keeps the rest in order", async () => {
    const { ActionMenu } = await import("./ActionMenu.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "codex",
      models: [{ modelId: "legacy-model", name: "Legacy Model" }],
      modes: [{ id: "legacy-mode", name: "Legacy Mode" }],
      configOptions: [
        {
          id: "approval_policy",
          name: "Approval Preset",
          type: "select",
          category: "approval",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5.5",
          options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          category: "thought_level",
          currentValue: "xhigh",
          options: [{ value: "xhigh", name: "Xhigh" }],
        },
      ],
    });
    root = createRoot(container);
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));
    const rowNames = menuRows();

    // The dock above the composer shows and switches all three, so repeating
    // them here would be the same fact in two places (§1.4).
    expect(rowNames).not.toContain("Model");
    expect(rowNames).not.toContain("Reasoning Effort");
    expect(rowNames).not.toContain("Approval Preset");
    expect(container.textContent).not.toContain("GPT-5.5");
    // Everything the dock does NOT own stays, in the same order as before.
    expect(rowNames.slice(0, 2)).toEqual(["Auto-approve permissions", "Text size"]);
    expect(rowNames).not.toContain("Switch agent");
    expect(rowNames).not.toContain("Change model");
    expect(rowNames).not.toContain("Permission mode");
    expect(rowNames).not.toContain("New chat");
  });

  test("uses the same settings order for Claude fallback controls", async () => {
    const { ActionMenu } = await import("./ActionMenu.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude",
      configOptions: [],
      models: [{ modelId: "sonnet", name: "Claude Sonnet" }],
      modes: [{ id: "default", name: "Default" }],
    });
    root = createRoot(container);
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));
    const rowNames = menuRows();

    // An agent that reports no config options at all still has its model and
    // its permission mode in the dock, which falls back to s.models / s.modes
    // for exactly this — so neither shows up here either.
    expect(rowNames.slice(0, 3)).toEqual(["Auto-approve permissions", "Text size", "Agent identity"]);
    expect(rowNames).not.toContain("Model");
    expect(rowNames).not.toContain("Permission mode");
    expect(rowNames).not.toContain("Switch agent");
    expect(rowNames).not.toContain("Change model");
    expect(rowNames).not.toContain("New chat");
  });

  const liveSession = (id: string, title: string) => ({
    [id]: {
      id,
      title,
      items: [],
      seq: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      agentName: "codex",
      cwd: "/p",
      hasContent: true,
      working: false,
      curAssistantId: null,
      curThoughtId: null,
      toolItemId: {},
      planItemId: null, historyStart: 0, loadingOlder: false,
    },
  });

  const resumeRow = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".amenu > .arow")]
      .find((b) => b.textContent?.includes("Copy resume command"));

  test("offers a Codex resume command for a history-keeping agent, even without session/load", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "t",
      defaultAgent: "codex",
      agents: [{ name: "codex", cwd: "/p", kind: "codex", history: true, sessionLoad: false, skin: "codex" }],
      fsRoot: "/",
    });
    const copyText = vi.fn(async () => true);
    vi.doMock("../lib/clipboard.ts", () => ({ copyText }));
    const { ActionMenu } = await import("./ActionMenu.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentName: "codex", cwd: "/p", activeId: "live-codex", sessions: liveSession("live-codex", "Live Codex") });
    root = createRoot(container);
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));

    const row = resumeRow();
    expect(row).not.toBeDisabled();
    expect(row?.textContent).toContain("continue this conversation in your terminal");
    await act(async () => { row!.click(); });
    expect(copyText).toHaveBeenCalledWith("cd /p && codex resume live-codex");
  });

  const rowByText = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".amenu > .arow")]
      .find((b) => b.textContent?.includes(text));
  const setInput = (input: HTMLInputElement, value: string) => {
    input.value = value;
    Simulate.change(input, { target: { value } } as any);
  };

  test("screen lock turns on by setting a PIN and turns off by clearing it", async () => {
    const { ActionMenu } = await import("./ActionMenu.tsx");
    const { useStore } = await import("../store/store.ts");
    const { isLockEnabled, verifyLockPin, clearLock } = await import("../lib/lock.ts");
    clearLock();
    useStore.getState().refreshLockSettings();
    root = createRoot(container);
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));

    // Open the Screen lock submenu and require a PIN before enabling it.
    await act(async () => { rowByText("Screen lock")!.click(); });
    expect(rowByText("Set a PIN")).toBeTruthy();
    await act(async () => { rowByText("Set a PIN")!.click(); });
    const helper = container.querySelector(".pin-helper");
    expect(helper).not.toBeNull();
    expect(helper?.textContent).toContain("reloads or reconnects");
    expect(container.querySelector<HTMLButtonElement>(".btn.primary")).toBeDisabled();

    const inputs = [...container.querySelectorAll<HTMLInputElement>(".rename-input")];
    await act(async () => { setInput(inputs[0], "123"); });
    await act(async () => { setInput(inputs[1], "123"); });
    expect(container.querySelector<HTMLButtonElement>(".btn.primary")).toBeDisabled();
    expect(isLockEnabled()).toBe(false);
    expect(container.textContent).toContain("PIN must be at least");

    await act(async () => { setInput(inputs[0], "2468"); });
    await act(async () => { setInput(inputs[1], "1357"); });
    expect(container.querySelector<HTMLButtonElement>(".btn.primary")).toBeDisabled();
    expect(container.textContent).toContain("PINs don't match");

    await act(async () => { setInput(inputs[1], "2468"); });
    expect(container.querySelector<HTMLButtonElement>(".btn.primary")).not.toBeDisabled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".btn.primary")!.click();
      await vi.waitFor(() => expect(isLockEnabled()).toBe(true));
    });
    await vi.waitFor(() => expect(useStore.getState().lockEnabled).toBe(true));
    expect(await verifyLockPin("2468")).toBe(true);

    // Turning it off clears it.
    await act(async () => { rowByText("Turn off lock")!.click(); });
    expect(isLockEnabled()).toBe(false);
    expect(useStore.getState().lockEnabled).toBe(false);
  });

  test("deleting a conversation needs a confirm step and is blocked while it runs", async () => {
    const { ActionMenu } = await import("./ActionMenu.tsx");
    const { useStore } = await import("../store/store.ts");
    const deleteSession = vi.fn(async () => {});
    useStore.setState({
      agentName: "codex", cwd: "/p", activeId: "live-codex",
      sessions: liveSession("live-codex", "Live Codex"),
      runningTasks: [], deleteSession,
    });
    root = createRoot(container);
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));

    // The main menu only navigates — it must not delete on the first click.
    await act(async () => { rowByText("Delete conversation")!.click(); });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(container.textContent).toContain("can't be undone");
    expect(container.querySelector(".delete-title")?.textContent).toBe("Live Codex");

    await act(async () => { container.querySelector<HTMLButtonElement>(".btn.danger")!.click(); });
    expect(deleteSession).toHaveBeenCalledTimes(1);

    // A conversation with a turn in flight can't be deleted — the gateway would
    // refuse it (409), so the row is disabled rather than offering a dead confirm.
    act(() => root!.render(React.createElement(ActionMenu, { open: false, onClose: () => {} })));
    act(() => useStore.setState({ runningTasks: [{ agentName: "codex", sessionId: "live-codex", state: "active" }] }));
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));
    expect(rowByText("Delete conversation")).toBeDisabled();
    expect(rowByText("Delete conversation")?.textContent).toContain("still running");
  });

  test("disables the resume command for agents that keep no history", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "t",
      defaultAgent: "ephemeral",
      agents: [{ name: "ephemeral", cwd: "/p", history: false, sessionLoad: false }],
      fsRoot: "/",
    });
    const { ActionMenu } = await import("./ActionMenu.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentName: "ephemeral", activeId: "live-eph", sessions: liveSession("live-eph", "Live") });
    root = createRoot(container);
    act(() => root!.render(React.createElement(ActionMenu, { open: true, onClose: () => {} })));

    expect(resumeRow()).toBeDisabled();
  });
});
