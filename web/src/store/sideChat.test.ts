import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse, setHistoryFetch } from "../test/fakeSse.ts";

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
    expect(st.branch).toEqual({ parentId: "open-session", sessionId: "side-session" });
    expect(st.activeId).toBe("open-session");
    expect(st.cwd).toBe("/repo");
    expect(st.sessions["side-session"].items[0]).toMatchObject({ kind: "user", text: "what the side chat said" });
    expect(st.sessions["side-session"].viewOnly).toBeFalsy();
    expect(st.sessions["side-session"].cwd).toBe("/other");
    expect(st.sessions["side-session"].title).toBe("The other thread");
  });

  test("the side chat's models and modes do not repaint the open conversation's pickers", async () => {
    const { useStore, ws } = await bootstrap();
    useStore.setState({
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

    // The lists describe the conversation in the main column, which never changed.
    const st = useStore.getState();
    expect(st.models.map((m) => m.modelId)).toEqual(["sonnet"]);
    expect(st.modes.map((m) => m.id)).toEqual(["normal"]);
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
    expect(st.branch).toBeNull();
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
    expect(useStore.getState().branch).toBeNull();
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
