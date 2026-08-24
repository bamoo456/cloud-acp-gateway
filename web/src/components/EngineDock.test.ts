import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConfigOption, Model } from "../types";

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

  test("takes the permission mode from a config option, or from session modes", async () => {
    const { engineReadout } = await import("../lib/engine.ts");
    const APPROVAL: ConfigOption = {
      id: "approval_policy", name: "Approval Preset", category: "approval", type: "select",
      currentValue: "on-request", options: [{ value: "on-request", name: "On request" }],
    };

    expect(engineReadout([APPROVAL], [], null).mode?.name).toBe("On request");
    // Claude spells the same setting as an option simply named "Mode" — and
    // "Model" contains those four letters, so a loose match would show the
    // model as the permission mode and lose the real one entirely.
    const MODE: ConfigOption = {
      id: "mode", name: "Mode", category: "", type: "select",
      currentValue: "auto", options: [{ value: "auto", name: "Auto" }],
    };
    const both = engineReadout([MODEL, MODE], [], null);
    expect(both.mode?.name).toBe("Auto");
    expect(both.model?.name).toBe("Opus 4.8");
    expect(engineReadout([MODEL], [], null).mode).toBeNull();
    // Claude reports no such option — the mode is a session mode instead, and
    // the dock has to read it from there rather than showing nothing.
    const fromModes = engineReadout([], [], null, [{ id: "plan", name: "Plan Mode" }], "plan");
    expect(fromModes.mode?.name).toBe("Plan Mode");
    expect(fromModes.mode?.option).toBeNull();
    expect(engineReadout([MODEL], [], null).mode).toBeNull();
  });

  test("a currentValue the option no longer lists still reads as something", async () => {
    // Changing model rebuilds the effort options and can clamp the mode, so a
    // stale currentValue is a real state, not a hypothetical one.
    const { engineReadout } = await import("../lib/engine.ts");
    const r = engineReadout([{ ...EFFORT, currentValue: "xhigh" }], [], null);

    expect(r.effort?.name).toBe("xhigh");
  });
});

describe("lastRanOn", () => {
  test("names the model and thinking level a saved conversation used, whatever the agent calls them", async () => {
    const { lastRanOn } = await import("../lib/engine.ts");

    expect(lastRanOn({ model: "opus[1m]", effort: "high", mode: "auto" })).toBe("last ran on opus[1m] · high");
    // codex spells the same two differently, and `mode` is never part of the line.
    expect(lastRanOn({ mode: "plan", reasoning_effort: "xhigh", model: "gpt-5.5" })).toBe("last ran on gpt-5.5 · xhigh");
    expect(lastRanOn({ model: "sonnet" })).toBe("last ran on sonnet");
  });

  test("says nothing when there is nothing recorded", async () => {
    const { lastRanOn } = await import("../lib/engine.ts");

    // A conversation older than the tracking, or a gateway too old to report it:
    // the note must read as it always did rather than trail off after a dash.
    expect(lastRanOn({})).toBe("");
    expect(lastRanOn(undefined)).toBe("");
    expect(lastRanOn({ mode: "plan" })).toBe("");
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

  // The lists go on the conversation (types.ts's SessionEngine), which is what
  // the dock reads through engineOf — there is no store-global to set.
  async function mount(configOptions: ConfigOption[], working = false, viewOnly = false, models: Model[] = []) {
    const { EngineDock } = await import("./EngineDock.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession, EMPTY_ENGINE } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "claude", activeId: "S",
      sessions: { S: {
        ...makeSession("S"), title: "t", agentName: "claude", working, viewOnly,
        engine: { ...EMPTY_ENGINE, configOptions, models },
      } },
    });
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(EngineDock, {}));
    });
    return useStore;
  }

  test("shows model · thinking level, and no clock while idle", async () => {
    await mount([MODEL, EFFORT]);
    const chip = container.querySelector(".mchip")!;

    // Not the agent name — the composer's "Reply to <agent>" already carries it,
    // and the width it cost was the width the model name needed on a phone.
    expect(chip.querySelector(".wm")).toBeNull();
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

  test("an agent that reports no model falls back to its name, not a bare chevron", async () => {
    await mount([]);

    expect(container.querySelector(".mchip .am")).toBeNull();
    expect(container.querySelector(".mchip .wm")?.textContent).toBe("claude");
  });

  test("a saved conversation the agent hasn't resumed reads out no engine at all", async () => {
    // configOptions/models/modes are store-global and still describe the last
    // live session: attributing them to this one labels it with another
    // session's model and offers switches the agent rejects ("Session not
    // found") until the first reply resumes it.
    const MODE: ConfigOption = {
      id: "mode", name: "Mode", category: "", type: "select",
      currentValue: "auto", options: [{ value: "auto", name: "Auto" }],
    };
    // The lists ride along on the session even while it is view-only, so this
    // seeds them and expects the readout to refuse them anyway.
    await mount([MODEL, EFFORT, MODE], false, true, [{ modelId: "m1", name: "Legacy Model" }]);

    expect(container.querySelector(".mchip-mode")).toBeNull();
    expect(container.querySelector(".mchip .am")).toBeNull();
    expect(container.querySelector(".mchip .wm")?.textContent).toBe("claude");
    expect(container.querySelector(".mchip .eff")).toBeNull();

    await act(async () => { container.querySelector<HTMLButtonElement>(".mchip")!.click(); });
    expect(container.querySelector(".engine-menu")!.textContent).not.toContain("Legacy Model");
    expect(container.querySelectorAll(".engine-menu .arow")).toHaveLength(0);
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
      useStore.setState((st) => ({ sessions: { S: { ...st.sessions.S, engine: {
        ...st.sessions.S.engine,
        configOptions: [MODEL, { ...EFFORT, options: [{ value: "off", name: "Off" }], currentValue: "off" }],
      } } } }));
    });
    const after = [...container.querySelectorAll(".engine-menu .arow .col > span:first-child")].map((e) => e.textContent);
    expect(after).toEqual(["Opus 4.8", "Sonnet 4.8", "Off"]);
  });

  // Bound to a floating window's session (store.ts's `sideWindows`) instead of to
  // the conversation on screen: the two docks read the two sessions' own lists and
  // set different sessions, which is the whole point of a side chat's own dock.
  test("bound to a session, it reads that conversation's engine and sets it there", async () => {
    const { EngineDock } = await import("./EngineDock.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession, EMPTY_ENGINE } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "claude", activeId: "S", agentReady: true,
      sessions: {
        // The main column is on Opus…
        S: { ...makeSession("S"), engine: { ...EMPTY_ENGINE, configOptions: [MODEL, EFFORT] } },
        // …and the windowed conversation on Sonnet, with no thinking level.
        W: { ...makeSession("W"), engine: { ...EMPTY_ENGINE, configOptions: [{ ...MODEL, currentValue: "sonnet" }] } },
      },
      sideWindows: [{ parentId: null, sessionId: "W", slot: 0 }],
    });
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(EngineDock, { sessionId: "W" }));
    });

    expect(container.querySelector(".mchip .am")?.textContent).toBe("Sonnet 4.8");
    expect(container.querySelector(".mchip .eff")).toBeNull();

    await act(async () => { container.querySelector<HTMLButtonElement>(".mchip")!.click(); });
    // No agent switcher in a bound dock: the agent is the page's connection.
    expect(container.querySelector(".engine-menu")!.textContent).not.toContain("/repo");
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".engine-menu .arow")];
    expect(rows.map((r) => r.querySelector(".col > span")!.textContent)).toEqual(["Opus 4.8", "Sonnet 4.8"]);

    // The pick is addressed to the window's session, not to the open
    // conversation — where it lands is covered in store/sideChat.test.ts.
    const setConfigOption = vi.fn();
    await act(async () => { useStore.setState({ setConfigOption }); });
    await act(async () => { rows[0].click(); });
    expect(setConfigOption).toHaveBeenCalledWith("model", "opus", "W");
    // …and the conversation on screen keeps its own list, untouched.
    expect(useStore.getState().sessions.S.engine.configOptions).toEqual([MODEL, EFFORT]);
  });
});
