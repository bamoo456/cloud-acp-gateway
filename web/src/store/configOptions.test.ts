import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession, applyModelsModes } from "./reducers.ts";
import type { NewSessionResult } from "../types.ts";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";
import { engineOf } from "./store.ts";

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
    const { engine } = applyModelsModes(makeSession("s1", 0), res);
    expect(engine.configOptions).toHaveLength(1);
    expect(engine.configOptions[0].currentValue).toBe("gpt-5.5");
    expect(engine.models).toEqual([]);
    expect(engine.modes).toEqual([]);
  });

  test("a Claude-shaped result yields null configOptions and intact models", () => {
    const res: NewSessionResult = {
      sessionId: "s1",
      models: { availableModels: [{ modelId: "default", name: "Default" }], currentModelId: "default" },
    };
    const { engine } = applyModelsModes(makeSession("s1", 0), res);
    expect(engine.configOptions).toEqual([]);
    expect(engine.models).toEqual([{ modelId: "default", name: "Default" }]);
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
    expect(engineOf(useStore.getState()).configOptions).toHaveLength(1);
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("xhigh");
    expect(document.documentElement.dataset.agentSkin).toBe("codex");
  });

  test("switching agents drops the skin, and the readout stays with the conversation", async () => {
    const { useStore } = await bootCodex();
    const before = engineOf(useStore.getState()).configOptions;
    expect(before.length).toBeGreaterThan(0);

    useStore.getState().setAgent("claude");

    // The skin is the agent's, so it goes immediately. The options are the
    // CONVERSATION's, and setAgent keeps sessions and activeId — so the codex
    // conversation is still the one on screen, and reading out anything else
    // (it used to blank, then restore from a per-agent stash) would describe a
    // conversation that isn't there. Claude's own session/new replaces it.
    expect(document.documentElement.dataset.agentSkin ?? "").toBe("");
    expect(engineOf(useStore.getState()).configOptions).toEqual(before);
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
    expect(engineOf(useStore.getState()).configOptions).toEqual([]);
    expect(document.documentElement.dataset.agentSkin ?? "").toBe("");

    useStore.getState().setAgent("work");

    expect(useStore.getState().agentName).toBe("work");
    expect(engineOf(useStore.getState()).configOptions).toEqual([]);
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
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("high");
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
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("high");
  });

  // The three symptoms of the store-global engine lists this file's fixtures used
  // to set. Each is a conversation reading out, or being set to, values that
  // belong to another one.
  test("switching between two live conversations reads out each one's own engine", async () => {
    const { useStore } = await bootCodex();
    const { makeSession, EMPTY_ENGINE } = await import("./reducers.ts");
    // A second live conversation of the same agent, on its own effort level.
    useStore.setState((st) => ({
      sessions: { ...st.sessions, other: {
        ...makeSession("other", Date.now(), { agentName: "codex", cwd: "/p" }),
        hasContent: true,
        engine: { ...EMPTY_ENGINE, configOptions: [{
          id: "reasoning_effort", name: "Reasoning Effort", type: "select", category: "thought_level",
          currentValue: "high", options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Xhigh" }],
        }] },
      } },
    }));

    // selectSession takes the activateLive path — a pointer swap with no
    // session/new or session/load, so nothing refills a global. The readout used
    // to keep showing the conversation it was switched AWAY from, and picking a
    // row in that menu set this session from the other one's list.
    useStore.getState().selectSession("other");
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("high");
    useStore.getState().selectSession("cx");
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("xhigh");
  });

  test("an available_commands_update lands on the session it names", async () => {
    const { useStore, ws } = await bootCodex();
    const { makeSession } = await import("./reducers.ts");
    useStore.setState((st) => ({
      sessions: { ...st.sessions, other: makeSession("other", Date.now(), { agentName: "codex", cwd: "/p" }) },
    }));

    ws.recv({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "other", update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "init", description: "Initialize" }],
      } },
    });
    await flush();

    // The background conversation got them; the one on screen still has none.
    expect(useStore.getState().sessions.other.engine.commands).toHaveLength(1);
    expect(engineOf(useStore.getState()).commands).toEqual([]);
  });

  // The adapter answers session/new with an empty availableCommands and emits the
  // real list a millisecond later, naming the REAL session id — which a "+"
  // conversation does not have yet, because it lives under a provisional id until
  // the round trip returns. The update used to be dropped for naming an unknown
  // session, and nothing ever re-sent it, so the conversation was left with an
  // empty slash menu permanently.
  test("a command list that arrives before its session is adopted still lands", async () => {
    const { useStore, ws } = await bootCodex();
    const sentBefore = ws.sent.length;
    void useStore.getState().newSession();
    await flush();

    // The "+" conversation is on screen under a provisional id.
    expect(useStore.getState().activeId).toMatch(/^pending-/);
    const req = JSON.parse(ws.sent[sentBefore]);
    expect(req.method).toBe("session/new");

    // The list arrives first, naming a session the store has never seen.
    ws.recv({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "ns-1", update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "handoff", description: "Hand off" }, { name: "recall", description: "Recall" }],
      } },
    });
    await flush();

    // Only now does session/new resolve — with the empty list the adapter really sends.
    ws.recv({ jsonrpc: "2.0", id: req.id, result: { sessionId: "ns-1", availableCommands: [] } });
    await flush();

    expect(useStore.getState().activeId).toBe("ns-1");
    expect(engineOf(useStore.getState()).commands.map((c) => c.name)).toEqual(["handoff", "recall"]);
  });

  test("a command list arriving after adoption still lands (the non-racing order)", async () => {
    const { useStore, ws } = await bootCodex();
    const sentBefore = ws.sent.length;
    void useStore.getState().newSession();
    await flush();
    const req = JSON.parse(ws.sent[sentBefore]);

    ws.recv({ jsonrpc: "2.0", id: req.id, result: { sessionId: "ns-2", availableCommands: [] } });
    await flush();
    ws.recv({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "ns-2", update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "handoff", description: "Hand off" }],
      } },
    });
    await flush();

    expect(engineOf(useStore.getState()).commands.map((c) => c.name)).toEqual(["handoff"]);
  });

  test("setConfigOption reverts and tips on rejection", async () => {
    const { useStore, ws } = await bootCodex();
    useStore.getState().setConfigOption("reasoning_effort", "high");
    const req = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.recv({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "nope" } });
    await flush();
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("xhigh");
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
    expect(engineOf(useStore.getState()).configOptions[0].currentValue).toBe("medium");
  });
});
