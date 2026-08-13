import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConfigOption } from "../types";

const MODEL: ConfigOption = {
  id: "model", name: "Model", category: "model", type: "select", currentValue: "opus",
  options: [{ value: "opus", name: "Opus 4.8" }, { value: "sonnet", name: "Sonnet 4.8" }],
};
const EFFORT: ConfigOption = {
  id: "reasoningEffort", name: "Thinking", category: "reasoning", type: "select", currentValue: "high",
  options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }],
};

describe("engineReadout", () => {
  test("reads the names the agent reported, never a string of our own", async () => {
    const { engineReadout } = await import("../lib/engine.ts");
    const r = engineReadout([MODEL, EFFORT], [], null);

    expect(r.model?.name).toBe("Opus 4.8");
    expect(r.effort?.name).toBe("High");
  });

  test("an agent with no reasoning option has no thinking level at all", async () => {
    const { engineReadout } = await import("../lib/engine.ts");

    expect(engineReadout([MODEL], [], null).effort).toBeNull();
  });

  test("falls back to availableModels when the agent exposes no model option", async () => {
    const { engineReadout } = await import("../lib/engine.ts");
    const r = engineReadout([], [{ modelId: "m1", name: "GPT-5 Codex" }], "m1");

    expect(r.model?.name).toBe("GPT-5 Codex");
    expect(r.model?.option).toBeNull();
  });

  test("a currentValue the option no longer lists still reads as something", async () => {
    // Changing model rebuilds the effort options and can clamp the mode, so a
    // stale currentValue is a real state, not a hypothetical one.
    const { engineReadout } = await import("../lib/engine.ts");
    const r = engineReadout([{ ...EFFORT, currentValue: "xhigh" }], [], null);

    expect(r.effort?.name).toBe("xhigh");
  });
});

describe("EngineDock", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token": "t", "defaultAgent": "claude", "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount(configOptions: ConfigOption[], working = false) {
    const { EngineDock } = await import("./EngineDock.tsx");
    const { useStore } = await import("../store/store.ts");
    const s0 = useStore.getState();
    useStore.setState({
      agentName: "claude", activeId: "S", configOptions,
      sessions: { S: { ...s0.sessions.S, id: "S", title: "t", agentName: "claude", working } as never },
    });
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(EngineDock, {}));
    });
    return useStore;
  }

  test("shows agent · model · thinking level, and no clock while idle", async () => {
    await mount([MODEL, EFFORT]);
    const chip = container.querySelector(".mchip")!;

    expect(chip.querySelector(".wm")?.textContent).toBe("claude");
    expect(chip.querySelector(".am")?.textContent).toBe("Opus 4.8");
    expect(chip.querySelector(".eff")?.textContent).toBe("High");
    expect(chip.querySelector(".el")).toBeNull();
    expect(chip.querySelector(".spin")).toBeNull();
  });

  test("an agent with no thinking level renders no placeholder for it", async () => {
    await mount([MODEL]);

    expect(container.querySelector(".mchip .eff")).toBeNull();
    expect(container.querySelector(".mchip")?.textContent).not.toContain("—");
  });

  test("a turn in flight adds the spinner and the clock", async () => {
    await mount([MODEL, EFFORT], true);

    expect(container.querySelector(".mchip .spin")).not.toBeNull();
    expect(container.querySelector(".mchip .el")).not.toBeNull();
  });

  test("the menu offers exactly the choices the agent currently reports", async () => {
    const useStore = await mount([MODEL, EFFORT]);
    await act(async () => { container.querySelector<HTMLButtonElement>(".mchip")!.click(); });

    const labels = [...container.querySelectorAll(".engine-menu .arow .col > span:first-child")].map((e) => e.textContent);
    expect(labels).toEqual(["Opus 4.8", "Sonnet 4.8", "Off", "High"]);

    // Switching model rebuilds the effort list; the menu must re-read it rather
    // than serve options the agent has dropped.
    await act(async () => {
      useStore.setState({ configOptions: [MODEL, { ...EFFORT, options: [{ value: "off", name: "Off" }], currentValue: "off" }] });
    });
    const after = [...container.querySelectorAll(".engine-menu .arow .col > span:first-child")].map((e) => e.textContent);
    expect(after).toEqual(["Opus 4.8", "Sonnet 4.8", "Off"]);
  });
});
