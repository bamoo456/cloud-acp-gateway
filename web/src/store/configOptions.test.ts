import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, applyModelsModes } from "./reducers.ts";
import type { NewSessionResult } from "../types.ts";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";

describe("applyModelsModes - configOptions", () => {
  test("surfaces configOptions from the result", () => {
    const res: NewSessionResult = {
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5.5",
          options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
        },
      ],
    };
    const { configOptions, models, modes } = applyModelsModes(makeSession("s1", 0), res);
    expect(configOptions).toHaveLength(1);
    expect(configOptions![0].currentValue).toBe("gpt-5.5");
    expect(models).toBeNull();
    expect(modes).toBeNull();
  });

  test("a Claude-shaped result yields null configOptions and intact models", () => {
    const res: NewSessionResult = {
      sessionId: "s1",
      models: { availableModels: [{ modelId: "default", name: "Default" }], currentModelId: "default" },
    };
    const { configOptions, models } = applyModelsModes(makeSession("s1", 0), res);
    expect(configOptions).toBeNull();
    expect(models).toEqual([{ modelId: "default", name: "Default" }]);
  });
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

async function bootstrapAndWaitForSse(useStore: { getState: () => { bootstrap: () => void } }) {
  useStore.getState().bootstrap();
  await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
  return FakeSse.instances.at(-1)!;
}

async function bootCodex() {
  document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
    token: "t",
    defaultAgent: "codex",
    agents: [{ name: "codex", cwd: "/p", history: true, skin: "codex" }, { name: "claude", cwd: "/c" }],
    fsRoot: "/",
  });
  const { useStore } = await import("./store.ts");
  const ws = await bootstrapAndWaitForSse(useStore);
  ws.open();
  await flush();
  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  await flush();
  const sess = JSON.parse(ws.sent[1]);
  ws.recv({
    jsonrpc: "2.0",
    id: sess.id,
    result: {
      sessionId: "cx",
      configOptions: [
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          category: "thought_level",
          currentValue: "xhigh",
          options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Xhigh" }],
        },
      ],
    },
  });
  await flush();
  return { useStore, ws };
}

describe("store configOptions", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{}</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
    document.documentElement.removeAttribute("data-agent-skin");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("captures configOptions from session/new and applies the codex skin", async () => {
    const { useStore } = await bootCodex();
    expect(useStore.getState().configOptions).toHaveLength(1);
    expect(useStore.getState().configOptions[0].currentValue).toBe("xhigh");
    expect(document.documentElement.dataset.agentSkin).toBe("codex");
  });

  test("switching agents clears configOptions and the skin", async () => {
    const { useStore } = await bootCodex();
    useStore.getState().setAgent("claude");
    expect(useStore.getState().configOptions).toEqual([]);
    expect(document.documentElement.dataset.agentSkin ?? "").toBe("");
  });

  test("switching to a Codex-skinned agent applies the skin before configOptions load", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "t",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/c", history: true, sessionLoad: true },
        { name: "work", cwd: "/p", history: true, sessionLoad: false, skin: "codex" },
      ],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");
    expect(useStore.getState().configOptions).toEqual([]);
    expect(document.documentElement.dataset.agentSkin ?? "").toBe("");

    useStore.getState().setAgent("work");

    expect(useStore.getState().agentName).toBe("work");
    expect(useStore.getState().configOptions).toEqual([]);
    expect(document.documentElement.dataset.agentSkin).toBe("codex");
  });

  test("setConfigOption sends {configId,value} and applies the response", async () => {
    const { useStore, ws } = await bootCodex();
    useStore.getState().setConfigOption("reasoning_effort", "high");
    const req = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(req).toMatchObject({
      method: "session/set_config_option",
      params: { configId: "reasoning_effort", value: "high" },
    });
    expect(useStore.getState().configOptions[0].currentValue).toBe("high");
    ws.recv({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        configOptions: [
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            type: "select",
            category: "thought_level",
            currentValue: "high",
            options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Xhigh" }],
          },
        ],
      },
    });
    await flush();
    expect(useStore.getState().configOptions[0].currentValue).toBe("high");
  });

  test("setConfigOption reverts and tips on rejection", async () => {
    const { useStore, ws } = await bootCodex();
    useStore.getState().setConfigOption("reasoning_effort", "high");
    const req = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.recv({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "nope" } });
    await flush();
    expect(useStore.getState().configOptions[0].currentValue).toBe("xhigh");
    expect(useStore.getState().tip).toContain("Reasoning Effort");
  });

  test("config_option_update notification replaces configOptions", async () => {
    const { useStore, ws } = await bootCodex();
    ws.recv({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "cx",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              category: "thought_level",
              currentValue: "medium",
              options: [{ value: "medium", name: "Medium" }],
            },
          ],
        },
      },
    });
    await flush();
    expect(useStore.getState().configOptions[0].currentValue).toBe("medium");
  });
});
