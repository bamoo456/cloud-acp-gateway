import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";
import { branchTitle } from "./store.ts";

// Same drain the other store tests use: a pushed frame crosses several awaits
// (fetch → stream → parser) before it reaches the store.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

// Bootstrap one connected Claude session, with fork advertised unless a test
// says otherwise — the affordance is capability-gated, so the capability has to
// be part of the fixture rather than assumed.
async function bootstrap(opts: { fork?: boolean } = {}) {
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
      agentCapabilities: opts.fork === false ? {} : { sessionCapabilities: { fork: {} } },
    },
  });
  await flush();

  const sess = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: sess.id, result: { sessionId: "parent-session" } });
  await flush();
  expect(useStore.getState().activeId).toBe("parent-session");
  return { useStore, ws };
}

// The last upstream frame for a method, so a test doesn't depend on how many
// frames the bootstrap itself sent.
function lastSent(ws: FakeSse, method: string) {
  const hits = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.method === method);
  return hits.at(-1);
}

describe("branch conversation", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
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

  test("initialize records whether the agent advertised session/fork", async () => {
    const { useStore } = await bootstrap();
    expect(useStore.getState().cfg.agents.find((a) => a.name === "claude")?.sessionFork).toBe(true);
  });

  test("an agent without the fork capability is recorded as unable", async () => {
    const { useStore } = await bootstrap({ fork: false });
    expect(useStore.getState().cfg.agents.find((a) => a.name === "claude")?.sessionFork).toBe(false);
  });

  test("branchSession forks the open conversation and copies its thread into the branch", async () => {
    const { useStore, ws } = await bootstrap();
    useStore.getState().sendPrompt("first question");
    await flush();
    const prompt = lastSent(ws, "session/prompt");
    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await flush();

    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    const fork = lastSent(ws, "session/fork");
    expect(fork.params).toMatchObject({ sessionId: "parent-session", cwd: "/repo" });

    ws.recv({ jsonrpc: "2.0", id: fork.id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();

    const st = useStore.getState();
    expect(st.sideWindows).toMatchObject([{ parentId: "parent-session", sessionId: "branch-session", slot: 0 }]);
    // The window floats over its parent: the open conversation does not change.
    expect(st.activeId).toBe("parent-session");
    // The parent's thread is copied, not handed over — plus the boundary note and
    // the message the branch was opened with.
    expect(st.sessions["branch-session"].items).toHaveLength(st.sessions["parent-session"].items.length + 2);
    expect(st.sessions["branch-session"].items[0]).toMatchObject({ kind: "user", text: "first question" });
    expect(st.sessions["branch-session"].title).toBe("first question (Branch)");
    // The boundary between copied history and the branch's own turns is marked,
    // and the branch's own first turn sits after it.
    expect(st.sessions["branch-session"].items.at(-2)).toMatchObject({
      kind: "note", text: expect.stringContaining("everything above is copied"),
    });
    expect(st.sessions["branch-session"].items.at(-1)).toMatchObject({
      kind: "user", text: "try the other approach",
    });
    expect(st.sessions["branch-session"].id).toBe("branch-session");
    // It arrives mid-turn — its opening message is already on the wire — while
    // the parent it was copied from is not working at all.
    expect(st.sessions["branch-session"].working).toBe(true);
    expect(st.sessions["parent-session"].working).toBe(false);
  });

  test("the branch window opens on the copied thread before the fork answers", async () => {
    const { useStore, ws } = await bootstrap();
    useStore.getState().sendPrompt("first question");
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/prompt").id, result: { stopReason: "end_turn" } });
    await flush();

    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush(); // the fork request is out, but unanswered

    const pending = useStore.getState().sideWindows[0];
    expect(pending.parentId).toBe("parent-session");
    // A provisional id: the window is up, the agent has not answered yet.
    expect(pending.sessionId.startsWith("pending-")).toBe(true);
    const shown = useStore.getState().sessions[pending.sessionId];
    expect(shown.items[0]).toMatchObject({ kind: "user", text: "first question" });
    expect(shown.title).toBe("first question (Branch)");
    // Nothing can be sent into it yet, however it is asked.
    await useStore.getState().sendPromptTo(pending.sessionId, "too early");
    await flush();
    expect(lastSent(ws, "session/prompt").params.sessionId).toBe("parent-session");

    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();

    // The provisional session is replaced by the real one, thread intact.
    const st = useStore.getState();
    expect(st.sideWindows).toMatchObject([{ parentId: "parent-session", sessionId: "branch-session", slot: 0 }]);
    expect(st.sessions[pending.sessionId]).toBeUndefined();
    expect(st.sessions["branch-session"].items[0]).toMatchObject({ kind: "user", text: "first question" });
  });

  test("a branch arrives with its first turn already sent, so it is never content-less", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    expect(await branching).toBe(true);
    await flush();

    // The opening message went to the BRANCH, and the branch is in the recents
    // list — which is only safe because that turn is what writes its transcript.
    // A branch with no turn would be a sidebar row whose only outcome is a 404.
    const prompt = lastSent(ws, "session/prompt");
    expect(prompt.params.sessionId).toBe("branch-session");
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "try the other approach" }]);
    expect(useStore.getState().recentSessions.some((r) => r.sessionId === "branch-session")).toBe(true);
    expect(useStore.getState().sessions["parent-session"].items).toHaveLength(0); // parent untouched
  });

  test("branching refuses an empty message and reports it did nothing", async () => {
    const { useStore, ws } = await bootstrap();
    expect(await useStore.getState().branchSession({ text: "   " })).toBe(false);
    await flush();
    expect(lastSent(ws, "session/fork")).toBeUndefined();
    expect(useStore.getState().sideWindows).toEqual([]);
  });

  test("a failed fork reports false so the caller keeps the message", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "would have been lost" });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, error: { code: -32601, message: "Method not found" } });
    expect(await branching).toBe(false);
    await flush();
    expect(useStore.getState().sideWindows).toEqual([]);
    expect(lastSent(ws, "session/prompt")).toBeUndefined(); // nothing was sent anywhere
  });

  test("closing the window mid-fork keeps the branch but does not reopen it", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    // Closed while the fork is in flight, so the window is still on its
    // provisional id — that is the id the close button would carry.
    useStore.getState().closeSideWindow(useStore.getState().sideWindows[0].sessionId);

    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();

    const st = useStore.getState();
    expect(st.sideWindows).toEqual([]);                            // the window stays closed
    expect(st.sessions["branch-session"]).toBeDefined();     // the conversation is still live
  });

  test("a second branch of the same conversation is refused", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();
    const before = ws.sent.length;

    // One branch per parent: the card is identified by its parent, so a second
    // one would be two windows claiming the same identity.
    expect(await useStore.getState().branchSession({ text: "and another" })).toBe(false);
    await flush();
    expect(ws.sent.length).toBe(before);
    expect(useStore.getState().sideWindows).toHaveLength(1);
  });

  test("branchSession inherits the parent's model instead of re-reading the fork result", async () => {
    const { useStore, ws } = await bootstrap();
    // The parent is on a non-default model; the gateway puts that back onto the
    // fork, so the copy must carry it rather than the fork result's own value.
    useStore.setState((st) => ({
      sessions: { ...st.sessions, "parent-session": { ...st.sessions["parent-session"], modelId: "opus" } },
    }));

    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    const fork = lastSent(ws, "session/fork");
    ws.recv({
      jsonrpc: "2.0", id: fork.id,
      result: {
        sessionId: "branch-session",
        models: { availableModels: [{ modelId: "haiku", name: "Haiku" }], currentModelId: "haiku" },
      },
    });
    await branching;
    await flush();

    expect(useStore.getState().sessions["branch-session"].modelId).toBe("opus");
  });

  test("branchSession refuses a conversation with a turn in flight", async () => {
    const { useStore, ws } = await bootstrap();
    useStore.getState().sendPrompt("still running");
    await flush();
    const before = ws.sent.length;

    await useStore.getState().branchSession({ text: "try the other approach" });
    await flush();

    expect(lastSent(ws, "session/fork")).toBeUndefined();
    expect(ws.sent.length).toBe(before);
    expect(useStore.getState().sideWindows).toEqual([]);
    expect(useStore.getState().tip).toMatch(/finish/i);
  });

  test("a failed fork reports it and leaves the conversation alone", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    const fork = lastSent(ws, "session/fork");
    ws.recv({ jsonrpc: "2.0", id: fork.id, error: { code: -32601, message: "Method not found" } });
    await branching;
    await flush();

    const st = useStore.getState();
    expect(st.sideWindows).toEqual([]);
    expect(st.activeId).toBe("parent-session");
    expect(st.sessions["parent-session"]).toBeDefined();
    expect(st.tip).toMatch(/Couldn't branch/);
  });

  test("sendPromptTo prompts the branch without moving the open conversation", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();

    useStore.getState().sendPromptTo("branch-session", "try the other approach");
    await flush();

    const prompt = lastSent(ws, "session/prompt");
    expect(prompt.params.sessionId).toBe("branch-session");
    const st = useStore.getState();
    expect(st.activeId).toBe("parent-session");
    expect(st.busySessionIds["branch-session"]).toBe(true);
    expect(st.busySessionIds["parent-session"]).toBeUndefined();
    expect(st.sessions["branch-session"].items.at(-1)).toMatchObject({ kind: "user", text: "try the other approach" });
    expect(st.sessions["parent-session"].items).toHaveLength(0);

    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await flush();
    expect(useStore.getState().busySessionIds["branch-session"]).toBeUndefined();
    expect(useStore.getState().sessions["branch-session"].working).toBe(false);
  });

  test("sendPromptTo ignores a session that isn't live", async () => {
    const { useStore, ws } = await bootstrap();
    await useStore.getState().sendPromptTo("no-such-session", "hello");
    await flush();
    expect(lastSent(ws, "session/prompt")).toBeUndefined();
  });

  test("closeSideWindow closes the window but keeps the conversation", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();

    useStore.getState().closeSideWindow("branch-session");
    expect(useStore.getState().sideWindows).toEqual([]);
    expect(useStore.getState().sessions["branch-session"]).toBeDefined();
  });

  test("deleting a floating conversation closes its window", async () => {
    const { useStore, ws } = await bootstrap();
    const branching = useStore.getState().branchSession({ text: "try the other approach" });
    await flush();
    ws.recv({ jsonrpc: "2.0", id: lastSent(ws, "session/fork").id, result: { sessionId: "branch-session" } });
    await branching;
    await flush();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    await useStore.getState().deleteSession("branch-session");
    expect(useStore.getState().sideWindows).toEqual([]);
  });
});

describe("branchTitle", () => {
  test("suffixes the parent's name, then counts", () => {
    expect(branchTitle("Refactor the sidebar")).toBe("Refactor the sidebar (Branch)");
    expect(branchTitle("Refactor the sidebar (Branch)")).toBe("Refactor the sidebar (Branch 2)");
    expect(branchTitle("Refactor the sidebar (Branch 2)")).toBe("Refactor the sidebar (Branch 3)");
  });

  test("an unnamed conversation still gets a usable name", () => {
    expect(branchTitle("  ")).toBe("Untitled (Branch)");
  });
});
