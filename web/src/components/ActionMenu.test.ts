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

  test("groups agent and model settings first without duplicating New chat", async () => {
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

    expect(rowNames.slice(0, 3)).toEqual(["Model", "Reasoning Effort", "Approval Preset"]);
    expect(rowNames).not.toContain("Switch agent");
    expect(rowNames).not.toContain("Change model");
    expect(rowNames).not.toContain("Permission mode");
    expect(rowNames).not.toContain("New chat");
    expect(container.textContent).toContain("GPT-5.5");
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

    expect(rowNames.slice(0, 3)).toEqual(["Model", "Permission mode", "Auto-approve permissions"]);
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
      planItemId: null,
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
