import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse, setHistoryFetch } from "../test/fakeSse.ts";
import { engineOf } from "./store.ts";

// Same drain the other store tests use: a pushed frame crosses several awaits
// (fetch → stream → parser) before it reaches the store.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
// openSideChat crosses more awaits than a fork does (session/load → the history
// API → the rebuild), so the shorter drain lands before the thread is filled.
const flushHistory = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

// Bootstrap one connected Claude session in /repo. `loadSession: true` is the
// capability that matters here — a side chat is an existing conversation resumed
// live, so an agent that can't load one is refused before anything is sent.
async function bootstrap(opts: { loadSession?: boolean } = {}) {
  const { useStore } = await import("./store.ts");
  useStore.getState().bootstrap();
  await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
  const ws = FakeSse.instances.at(-1)!;
  ws.open();
  await flush();

  const init = JSON.parse(ws.sent[0]);
  ws.recv({
    jsonrpc: "2.0", id: init.id,
    result: {
      protocolVersion: 1, authMethods: [],
      agentCapabilities: { loadSession: opts.loadSession !== false },
    },
  });
  await flush();

  const sess = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: sess.id, result: { sessionId: "open-session" } });
  await flush();
  expect(useStore.getState().activeId).toBe("open-session");
  return { useStore, ws };
}

// The last upstream frame for a method, so a test doesn't depend on how many
// frames the bootstrap itself sent.
function lastSent(ws: FakeSse, method: string) {
  const hits = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.method === method);
  return hits.at(-1);
}

// Put engine lists on one conversation. They live on the session now
// (types.ts's SessionEngine), so a fixture seeds them there.
function seedEngine(useStore: any, sessionId: string, engine: Record<string, unknown>) {
  useStore.setState((st: any) => ({
    sessions: { ...st.sessions, [sessionId]: {
      ...st.sessions[sessionId],
      engine: { models: [], modes: [], commands: [], configOptions: [], ...engine },
    } },
  }));
}

// The row the menu was opened on: another conversation, in another folder.
const ROW = { sessionId: "side-session", agentName: "claude", cwd: "/other", title: "The other thread" };

describe("side chat", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    setHistoryFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "what the side chat said" }] }],
        total: 1, start: 0, truncated: false,
      }),
    }));
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("openSideChat loads the row's conversation beside the open one, in the row's folder", async () => {
    const { useStore, ws } = await bootstrap();

    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    const load = lastSent(ws, "session/load");
    // The row's OWN folder is what the agent is asked about — the folder on
    // screen must not move for a conversation that lives elsewhere.
    expect(load.params).toMatchObject({ sessionId: "side-session", cwd: "/other" });

    ws.recv({ jsonrpc: "2.0", id: load.id, result: {} });
    await opening;
    await flushHistory();

    const st = useStore.getState();
    expect(st.sideWindows).toMatchObject([{ parentId: null, sessionId: "side-session", slot: 0 }]);
    expect(st.activeId).toBe("open-session");
    expect(st.cwd).toBe("/repo");
    expect(st.sessions["side-session"].items[0]).toMatchObject({ kind: "user", text: "what the side chat said" });
    expect(st.sessions["side-session"].viewOnly).toBeFalsy();
    expect(st.sessions["side-session"].cwd).toBe("/other");
    expect(st.sessions["side-session"].title).toBe("The other thread");
  });

  test("the side chat's models and modes do not repaint the open conversation's pickers", async () => {
    const { useStore, ws } = await bootstrap();
    seedEngine(useStore, "open-session", {
      models: [{ modelId: "sonnet", name: "Sonnet" }],
      modes: [{ id: "normal", name: "Normal" }],
    });

    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({
      jsonrpc: "2.0", id: lastSent(ws, "session/load").id,
      result: {
        models: { availableModels: [{ modelId: "haiku", name: "Haiku" }], currentModelId: "haiku" },
        modes: { availableModes: [{ id: "plan", name: "Plan" }], currentModeId: "plan" },
      },
    });
    await opening;
    await flushHistory();

    // Each conversation's lists describe itself: the side chat came back on
    // Haiku/Plan, the one in the main column is still on Sonnet/Normal.
    const st = useStore.getState();
    expect(st.sessions["side-session"].engine.models.map((m) => m.modelId)).toEqual(["haiku"]);
    expect(st.sessions["open-session"].engine.models.map((m) => m.modelId)).toEqual(["sonnet"]);
    expect(st.sessions["open-session"].engine.modes.map((m) => m.id)).toEqual(["normal"]);
  });

  test("a failed load leaves no half-open window behind", async () => {
    const { useStore, ws } = await bootstrap();

    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({
      jsonrpc: "2.0", id: lastSent(ws, "session/load").id,
      error: { code: -32603, message: "no such session" },
    });
    await opening;
    await flushHistory();

    const st = useStore.getState();
    expect(st.sessions["side-session"]).toBeUndefined();
    expect(st.sideWindows).toEqual([]);
    expect(st.activeId).toBe("open-session");
    expect(st.tip).toMatch(/Couldn't open side chat/);
  });

  test("a row belonging to another agent is refused without a round trip", async () => {
    const { useStore, ws } = await bootstrap();
    const before = ws.sent.length;

    await useStore.getState().openSideChat({ ...ROW, agentName: "codex" });
    await flushHistory();

    expect(lastSent(ws, "session/load")).toBeUndefined();
    expect(ws.sent.length).toBe(before);
    expect(useStore.getState().sideWindows).toEqual([]);
  });

  // Open one side chat end to end: the request out, the load answered, the
  // history filled in behind it.
  async function open(useStore: any, ws: FakeSse, sessionId: string) {
    const opening = useStore.getState().openSideChat({ ...ROW, sessionId });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/load").id, result: {} });
    await opening;
    await flushHistory();
  }

  test("several side chats can be open at once, each in its own default slot", async () => {
    const { useStore, ws } = await bootstrap();
    await open(useStore, ws, "side-a");
    await open(useStore, ws, "side-b");

    // Both windows, both live, both promptable — and the slots differ so the
    // cards cascade instead of landing on top of each other.
    expect(useStore.getState().sideWindows).toMatchObject([
      { parentId: null, sessionId: "side-a", slot: 0 },
      { parentId: null, sessionId: "side-b", slot: 1 },
    ]);
    expect(useStore.getState().sessions["side-a"].viewOnly).toBeFalsy();
    expect(useStore.getState().sessions["side-b"].viewOnly).toBeFalsy();
    expect(useStore.getState().activeId).toBe("open-session");
  });

  test("one past the cap is refused rather than opened, because every window pins a session", async () => {
    const { useStore, ws } = await bootstrap();
    await open(useStore, ws, "side-a");
    await open(useStore, ws, "side-b");
    await open(useStore, ws, "side-c");
    const before = ws.sent.length;

    await useStore.getState().openSideChat({ ...ROW, sessionId: "side-d" });
    await flushHistory();

    expect(ws.sent.length).toBe(before); // no round trip for the one that can't fit
    expect(useStore.getState().sideWindows.map((w) => w.sessionId)).toEqual(["side-a", "side-b", "side-c"]);
    expect(useStore.getState().sessions["side-d"]).toBeUndefined();
    expect(useStore.getState().tip).toMatch(/Close a floating conversation/);
  });

  test("reopening an already-open side chat raises it instead of opening a second card", async () => {
    const { useStore, ws } = await bootstrap();
    await open(useStore, ws, "side-a");
    await open(useStore, ws, "side-b");
    const before = ws.sent.length;

    await useStore.getState().openSideChat({ ...ROW, sessionId: "side-a" });
    await flushHistory();

    expect(ws.sent.length).toBe(before); // nothing to reload — it is already live
    // Same two windows, "side-a" now last, which is front-most.
    expect(useStore.getState().sideWindows.map((w) => w.sessionId)).toEqual(["side-b", "side-a"]);
    // …and its slot is unchanged: raising is a z-order change, not a move.
    expect(useStore.getState().sideWindows.find((w) => w.sessionId === "side-a")!.slot).toBe(0);
  });

  test("a side chat whose session was evicted is reloaded, keeping its window's place", async () => {
    const { useStore, ws } = await bootstrap();
    await open(useStore, ws, "side-a");
    await open(useStore, ws, "side-b");
    // What an eviction (or a _gateway/reload trim) leaves behind: the entry with
    // no session under it. Reopening from the sidebar has to fill it back in
    // rather than no-op on the entry that is already there.
    useStore.setState((st: any) => {
      const sessions = { ...st.sessions };
      delete sessions["side-a"];
      return { sessions };
    });

    await open(useStore, ws, "side-a");

    expect(useStore.getState().sessions["side-a"].items[0]).toMatchObject({ kind: "user" });
    expect(useStore.getState().sideWindows).toMatchObject([
      { parentId: null, sessionId: "side-a", slot: 0 },
      { parentId: null, sessionId: "side-b", slot: 1 },
    ]);
  });

  test("closeSideWindow closes only the one named, and frees its slot for the next", async () => {
    const { useStore, ws } = await bootstrap();
    await open(useStore, ws, "side-a");
    await open(useStore, ws, "side-b");

    useStore.getState().closeSideWindow("side-a");
    expect(useStore.getState().sideWindows.map((w) => w.sessionId)).toEqual(["side-b"]);
    expect(useStore.getState().sessions["side-a"]).toBeDefined(); // the conversation stays live

    await open(useStore, ws, "side-c");
    expect(useStore.getState().sideWindows.find((w) => w.sessionId === "side-c")!.slot).toBe(0);
  });

  test("the load result's engine lists land on the side chat, not on the open conversation", async () => {
    const { useStore, ws } = await bootstrap();
    seedEngine(useStore, "open-session", {
      models: [{ modelId: "sonnet", name: "Sonnet" }],
      configOptions: [{
        id: "model", name: "Model", type: "select", category: "model", currentValue: "sonnet",
        options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
      }],
    });

    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({
      jsonrpc: "2.0", id: lastSent(ws, "session/load").id,
      result: {
        models: { availableModels: [{ modelId: "haiku", name: "Haiku" }], currentModelId: "haiku" },
        configOptions: [{
          id: "model", name: "Model", type: "select", category: "model", currentValue: "opus",
          options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
        }],
      },
    });
    await opening;
    await flushHistory();

    const st = useStore.getState();
    // The card's dock reads the side chat's own model…
    expect(st.sessions["side-session"].engine).toMatchObject({
      models: [{ modelId: "haiku", name: "Haiku" }],
      configOptions: [{ id: "model", currentValue: "opus" }],
    });
    expect(st.sessions["side-session"].modelId).toBe("haiku");
    // …and the main column's pickers still describe the conversation on screen.
    expect(engineOf(st).models.map((m) => m.modelId)).toEqual(["sonnet"]);
    expect(engineOf(st).configOptions[0].currentValue).toBe("sonnet");
  });

  test("setting an option on a side chat leaves the main column's options alone", async () => {
    const { useStore, ws } = await bootstrap();
    const OPT = {
      id: "model", name: "Model", type: "select", category: "model", currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
    };
    seedEngine(useStore, "open-session", { configOptions: [OPT] });

    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/load").id, result: { configOptions: [OPT] } });
    await opening;
    await flushHistory();

    useStore.getState().setConfigOption("model", "opus", "side-session");
    await flush();
    // Addressed to the side chat, optimistically shown there, and nowhere else.
    const req = lastSent(ws, "session/set_config_option");
    expect(req.params).toMatchObject({ sessionId: "side-session", configId: "model", value: "opus" });
    const opt = (st: any, id: string) => st.sessions[id].engine.configOptions[0].currentValue;
    expect(opt(useStore.getState(), "side-session")).toBe("opus");
    expect(opt(useStore.getState(), "open-session")).toBe("sonnet");

    // The agent's answer replaces the side chat's list, still not the other's.
    ws.recv({
      jsonrpc: "2.0", id: req.id,
      result: { configOptions: [{ ...OPT, currentValue: "opus" }] },
    });
    await flush();
    expect(opt(useStore.getState(), "side-session")).toBe("opus");
    expect(opt(useStore.getState(), "open-session")).toBe("sonnet");
  });

  test("a config_option_update is routed to the session it names", async () => {
    const { useStore, ws } = await bootstrap();
    const OPT = {
      id: "model", name: "Model", type: "select", category: "model", currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
    };
    seedEngine(useStore, "open-session", { configOptions: [OPT] });
    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/load").id, result: { configOptions: [OPT] } });
    await opening;
    await flushHistory();

    // The gateway re-applies a conversation's own controls after any client's
    // load/new/fork and broadcasts the result for THAT session to every client —
    // it used to be applied globally, so this frame relabelled the main column.
    const opt = (id: string) => useStore.getState().sessions[id].engine.configOptions[0].currentValue;
    ws.recv({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: "side-session",
        update: { sessionUpdate: "config_option_update", configOptions: [{ ...OPT, currentValue: "opus" }] },
      },
    });
    await flush();
    expect(opt("side-session")).toBe("opus");
    expect(opt("open-session")).toBe("sonnet");

    // A frame naming the conversation on screen lands on that one.
    ws.recv({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: "open-session",
        update: { sessionUpdate: "config_option_update", configOptions: [{ ...OPT, currentValue: "opus" }] },
      },
    });
    await flush();
    expect(opt("open-session")).toBe("opus");

    // And one naming a conversation this client does not hold changes nothing —
    // it used to be enough for another device's session/load to move this
    // client's readout.
    ws.recv({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: "someone-elses-session",
        update: { sessionUpdate: "config_option_update", configOptions: [{ ...OPT, currentValue: "sonnet" }] },
      },
    });
    await flush();
    expect(opt("open-session")).toBe("opus");
    expect(opt("side-session")).toBe("opus");
  });

  test("setModel on a side chat is addressed to it, not to the open conversation", async () => {
    const { useStore, ws } = await bootstrap();
    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({
      jsonrpc: "2.0", id: lastSent(ws, "session/load").id,
      result: { models: { availableModels: [{ modelId: "haiku", name: "Haiku" }], currentModelId: "haiku" } },
    });
    await opening;
    await flushHistory();

    useStore.getState().setModel("opus", "side-session");
    await flush();
    expect(lastSent(ws, "session/set_model").params).toMatchObject({ sessionId: "side-session", modelId: "opus" });
    expect(useStore.getState().sessions["side-session"].modelId).toBe("opus");
    expect(useStore.getState().sessions["open-session"].modelId).toBeFalsy();
  });

  test("the side chat can be prompted without moving the open conversation", async () => {
    const { useStore, ws } = await bootstrap();
    const opening = useStore.getState().openSideChat(ROW);
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/load").id, result: {} });
    await opening;
    await flushHistory();

    // Not awaited: runPrompt only settles when the turn does, and this is about
    // where the turn was addressed, not how it ends.
    void useStore.getState().sendPromptTo("side-session", "and now this");
    await flush();

    const prompt = lastSent(ws, "session/prompt");
    expect(prompt.params.sessionId).toBe("side-session");
    const st = useStore.getState();
    expect(st.activeId).toBe("open-session");
    expect(st.sessions["side-session"].items.at(-1)).toMatchObject({ kind: "user", text: "and now this" });
    expect(st.sessions["open-session"].items).toHaveLength(0);
  });
});
