import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse, setHistoryFetch, setPrefs, historyCalls } from "../test/fakeSse.ts";

// Drain microtasks plus one macrotask turn — the SSE transport's fetch→stream→parser
// chain crosses several awaits before a pushed frame reaches the store.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const flushHistory = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function bootstrapAndWaitForSse(useStore: { getState: () => { bootstrap: () => void } }) {
  useStore.getState().bootstrap();
  await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
  return FakeSse.instances.at(-1)!;
}

async function bootstrapThenSwitchFolder() {
  const { useStore } = await import("./store.ts");

  const ws = await bootstrapAndWaitForSse(useStore);
  ws.open();
  await flush();

  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  await flush();

  const oldSessionReq = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: oldSessionReq.id, result: { sessionId: "old-session" } });
  await flush();
  expect(useStore.getState().activeId).toBe("old-session");

  useStore.getState().setCwd("/new");
  const newSessionReq = JSON.parse(ws.sent[2]);
  expect(newSessionReq.params.cwd).toBe("/new");
  ws.recv({ jsonrpc: "2.0", id: newSessionReq.id, result: { sessionId: "new-session" } });
  await flush();
  expect(useStore.getState().activeId).toBe("new-session");

  return { useStore, ws };
}

async function bootstrapThenCreateSecondSession() {
  const { useStore } = await import("./store.ts");

  const ws = await bootstrapAndWaitForSse(useStore);
  ws.open();
  await flush();

  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  await flush();

  const firstSessionReq = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: firstSessionReq.id, result: { sessionId: "first-session" } });
  await flush();
  expect(useStore.getState().activeId).toBe("first-session");

  const creating = useStore.getState().newSession();
  await flush();
  const secondSessionReq = JSON.parse(ws.sent[2]);
  ws.recv({ jsonrpc: "2.0", id: secondSessionReq.id, result: { sessionId: "second-session" } });
  await creating;
  await flush();
  expect(useStore.getState().activeId).toBe("second-session");

  return { useStore, ws };
}

// Bootstrap a single Claude session at the default cwd (/old), leaving the store
// connected with one open socket and `home-session` active.
async function bootstrapClaude() {
  const { useStore } = await import("./store.ts");

  const ws = await bootstrapAndWaitForSse(useStore);
  ws.open();
  await flush();

  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  await flush();

  const sessReq = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: sessReq.id, result: { sessionId: "home-session" } });
  await flush();
  expect(useStore.getState().activeId).toBe("home-session");

  return { useStore, ws };
}

describe("store notification routing", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/old" }],
      "fsRoot": "/"
    }</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a folder switch keeps prior sessions live and still applies their frames", async () => {
    const { useStore, ws } = await bootstrapThenSwitchFolder();
    // old-session must NOT have been wiped by setCwd("/new")
    expect(useStore.getState().sessions["old-session"]).toBeDefined();

    ws.recv({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "old-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late old response" } } },
    });
    await flush();
    // the background session accumulated the frame; the active one is untouched
    expect(useStore.getState().sessions["old-session"].items.length).toBeGreaterThan(0);
    expect(useStore.getState().sessions["new-session"].items).toHaveLength(0);
  });

  test("a background session's Recent entry uses its own cwd, not the active one", async () => {
    const { useStore, ws } = await bootstrapThenSwitchFolder();
    // global cwd is now "/new" (new-session active); old-session lives under "/old".
    // A background frame for old-session must record its Recent entry under /old —
    // recording it under the active /new would surface a duplicate (same title, wrong folder).
    ws.recv({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "old-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "background chunk" } } },
    });
    await flush();
    const recents = useStore.getState().recentSessions.filter((r) => r.sessionId === "old-session");
    expect(recents).toHaveLength(1);
    expect(recents[0].cwd).toBe("/old");
  });

  test("selectSession activates a live session without hitting /history and restores its cwd", async () => {
    const { useStore } = await bootstrapThenCreateSecondSession(); // first-session(/old), second-session(/old) active
    // stamp distinct cwds to prove cwd follows the active session
    useStore.setState((st: any) => ({ sessions: {
      ...st.sessions,
      "first-session": { ...st.sessions["first-session"], cwd: "/repo-a" },
    } }));
    const before = historyCalls.length;

    (useStore.getState() as any).selectSession("first-session");

    expect(useStore.getState().activeId).toBe("first-session");
    expect(useStore.getState().cwd).toBe("/repo-a");
    expect(historyCalls.length).toBe(before); // hot path: no /history/messages fetch
  });

  test("_gateway/reload rebuilds the active session via session/load", async () => {
    const { useStore, ws } = await bootstrapThenSwitchFolder();
    // give the active session some content so we can see the rebuild clear it
    ws.recv({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "new-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    });
    await flush();
    expect(useStore.getState().sessions["new-session"].items.length).toBeGreaterThan(0);
    const before = ws.sent.length;

    ws.recv({ jsonrpc: "2.0", method: "_gateway/reload" });
    await flush();

    const load = ws.sent.slice(before).map((raw) => JSON.parse(raw)).find((f) => f.method === "session/load");
    expect(load).toMatchObject({ method: "session/load", params: { sessionId: "new-session" } });
    expect(useStore.getState().sessions["new-session"].items).toHaveLength(0); // thread reset, awaiting replay
  });

  test("_gateway/reload drops the current agent's other live sessions so they rebuild later", async () => {
    const { useStore, ws } = await bootstrapThenCreateSecondSession(); // first-session + second-session(active), agent "claude"
    expect(useStore.getState().sessions["first-session"]).toBeDefined();

    ws.recv({ jsonrpc: "2.0", method: "_gateway/reload" });
    await flush();

    // the non-active sibling is dropped (will rebuild from history on select)…
    expect(useStore.getState().sessions["first-session"]).toBeUndefined();
    // …and the active one is reset awaiting its session/load replay
    expect(useStore.getState().sessions["second-session"].items).toHaveLength(0);
  });

  test("_gateway/agent_restart resets state and reconnects like a fresh page load", async () => {
    const { useStore, ws } = await bootstrapClaude(); // one claude session: home-session
    ws.recv({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "home-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } },
    });
    await flush();
    expect(useStore.getState().sessions["home-session"].items.length).toBeGreaterThan(0);
    expect(useStore.getState().agentReady).toBe(true);
    expect(useStore.getState().activeId).toBe("home-session");

    ws.recv({ jsonrpc: "2.0", method: "_gateway/agent_restart" });
    await flush();

    // sessions are cleared (like a page refresh), activeId is null
    expect(useStore.getState().sessions).toEqual({});
    expect(useStore.getState().activeId).toBeNull();
    expect(useStore.getState().agentReady).toBe(false);

    // A new SSE socket is opened via openConnection()
    expect(FakeSse.instances.length).toBe(2);
    const ws2 = FakeSse.instances[1];
    ws2.open();
    await flush();

    // Initialize the fresh handshake
    const init2 = JSON.parse(ws2.sent[0]);
    ws2.recv({ jsonrpc: "2.0", id: init2.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    await flush();
    expect(useStore.getState().agentReady).toBe(true);

    // lastSessionByAgent still remembers the old session → the "fresh page load"
    // path calls openSavedSession(), which fetches /history/messages and
    // rebuilds the thread. If no recent session were remembered, initSession()
    // would create a brand-new one.
    expect(useStore.getState().activeId).not.toBeNull();
  });

  test("_gateway/agent_restart while locked is a no-op (unlock() owns the connection)", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const before = FakeSse.instances.length;

    // Flip the store into "locked" state directly. (engaging a real lock needs a
    // configured PIN, which the test harness does not set up — the code path
    // we're testing is the early-return in onAgentRestart, not lock() itself.)
    useStore.setState({ locked: true });

    // The notification arrives while locked. It must NOT open a new
    // connection — the screen lock is in charge; unlock() will rebuild.
    ws.recv({ jsonrpc: "2.0", method: "_gateway/agent_restart" });
    await flush();
    expect(FakeSse.instances.length, "no reconnect should fire while locked").toBe(before);
    expect(useStore.getState().locked).toBe(true);
  });

  test("does not error-reply to permission requests for unloaded sessions (would eat the prompt)", async () => {
    const { useStore, ws } = await bootstrapThenSwitchFolder();
    const sentBefore = ws.sent.length;

    ws.recv({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "old-session",
        toolCall: { title: "Edit old folder" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();

    // Not rendered into the now-active session...
    expect(useStore.getState().sessions["new-session"].items).toHaveLength(0);
    // ...and crucially NOT answered with an error: the gateway gate is
    // first-reply-wins, so erroring here would deny every viewer the chance.
    expect(ws.sent).toHaveLength(sentBefore);
    // Recorded so a later open / reload of that session can surface it.
    const pending = (useStore.getState() as any).pendingPermissions;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ reqId: 77, sessionId: "old-session", title: "Edit old folder" });
  });

  test("tracks and answers permission requests for a non-active live session", async () => {
    const { useStore, ws } = await bootstrapThenCreateSecondSession();

    ws.recv({
      jsonrpc: "2.0",
      id: 88,
      method: "session/request_permission",
      params: {
        sessionId: "first-session",
        toolCall: { title: "Edit first session file" },
        options: [
          { optionId: "deny", kind: "reject_once", name: "Deny" },
          { optionId: "allow", kind: "allow_once", name: "Allow" },
        ],
      },
    });
    await flush();

    const pending = (useStore.getState() as any).pendingPermissions;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reqId: 88,
      sessionId: "first-session",
      title: "Edit first session file",
    });
    expect(useStore.getState().activeId).toBe("second-session");

    (useStore.getState() as any).answerPermission(88, "deny");

    const response = JSON.parse(ws.sent[3]);
    expect(response).toMatchObject({
      id: 88,
      result: { outcome: { outcome: "selected", optionId: "deny" } },
    });
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(0);
    const item = useStore.getState().sessions["first-session"].items[0];
    expect(item).toMatchObject({ kind: "permission", resolved: true, chosen: "Deny" });
  });

  test("re-delivering a permission with the same reqId does not duplicate the prompt", async () => {
    const { useStore, ws } = await bootstrapClaude();

    const perm = {
      jsonrpc: "2.0",
      id: 55,
      method: "session/request_permission",
      params: {
        sessionId: "home-session",
        toolCall: { title: "Edit a file" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    };
    ws.recv(perm);
    ws.recv(perm); // the gateway re-delivers the outstanding prompt after a reload
    await flush();

    const items = useStore.getState().sessions["home-session"].items;
    const perms = items.filter((it) => it.kind === "permission");
    expect(perms).toHaveLength(1);
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(1);
  });

  test("a _gateway/reload re-attaches an outstanding permission prompt after session/load", async () => {
    const { useStore, ws } = await bootstrapClaude();

    // A prompt arrives for the active session: rendered in-thread and recorded as
    // the durable pendingPermissions entry.
    ws.recv({
      jsonrpc: "2.0",
      id: 33,
      method: "session/request_permission",
      params: {
        sessionId: "home-session",
        toolCall: { title: "Edit a file" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();
    expect(useStore.getState().sessions["home-session"].items.some((it) => it.kind === "permission")).toBe(true);
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(1);

    // The gateway trimmed past our cursor → reload. resync rebuilds the active
    // session via session/load, which wipes the thread (and the prompt item).
    const before = ws.sent.length;
    ws.recv({ jsonrpc: "2.0", method: "_gateway/reload" });
    await flush();
    const load = ws.sent.slice(before).map((raw) => JSON.parse(raw)).find((f) => f.method === "session/load");
    expect(load).toMatchObject({ method: "session/load", params: { sessionId: "home-session" } });
    expect(useStore.getState().sessions["home-session"].items).toHaveLength(0); // wiped, awaiting replay

    // The load resolves WITHOUT the gateway re-delivering the prompt (the race that
    // makes it disappear). pendingPermissions is the durable source, so the prompt
    // must be re-attached to the rebuilt thread anyway.
    ws.recv({ jsonrpc: "2.0", id: load.id, result: { sessionId: "home-session" } });
    await flush();
    const perm = useStore.getState().sessions["home-session"].items.find((it) => it.kind === "permission");
    expect(perm).toMatchObject({ reqId: 33, title: "Edit a file", resolved: false });
    // Still answerable, and answering clears the durable entry.
    (useStore.getState() as any).answerPermission(33, "allow");
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(0);
  });

  test("a re-used reqId surfaces a fresh prompt instead of being swallowed by a resolved one", async () => {
    const { useStore, ws } = await bootstrapClaude();

    const ask = (title: string) => ws.recv({
      jsonrpc: "2.0",
      id: 5, // the agent reuses request ids across turns (the gateway resets its gate)
      method: "session/request_permission",
      params: {
        sessionId: "home-session",
        toolCall: { title },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });

    // First prompt arrives and is answered → its item stays in-thread as a resolved record.
    ask("Edit file A");
    await flush();
    (useStore.getState() as any).answerPermission(5, "allow");
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(0);
    const resolved = useStore.getState().sessions["home-session"].items.find((it) => it.kind === "permission");
    expect(resolved).toMatchObject({ reqId: 5, resolved: true });

    // A NEW prompt reuses reqId 5. The lingering resolved item must NOT suppress it,
    // or the prompt would vanish (impossible to answer → stalled session).
    ask("Edit file B");
    await flush();

    const perms = useStore.getState().sessions["home-session"].items.filter((it) => it.kind === "permission");
    const live = perms.filter((it) => it.kind === "permission" && !it.resolved);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ reqId: 5, title: "Edit file B", resolved: false });
    // …and it is tracked as the durable, still-answerable prompt.
    expect((useStore.getState() as any).pendingPermissions).toMatchObject([{ reqId: 5, title: "Edit file B" }]);
  });

  // #2: the badge reads inboxItems (server truth, cross-agent), but a prompt that
  // arrives over SSE must show there INSTANTLY, not after the 5s /inbox poll —
  // otherwise a background prompt feels laggy. So SSE feeds inboxItems too, with
  // the poll staying authoritative (it overwrites with server state).
  test("an SSE permission immediately populates inboxItems (no poll needed)", async () => {
    const { useStore, ws } = await bootstrapThenCreateSecondSession();
    ws.recv({
      jsonrpc: "2.0", id: 88, method: "session/request_permission",
      params: {
        sessionId: "first-session", toolCall: { title: "Edit first session file" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();
    const inbox = (useStore.getState() as any).inboxItems;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      agentName: "claude", sessionId: "first-session", reqId: "88",
      title: "Edit first session file", status: "pending",
    });
  });

  test("a re-delivered SSE permission does not duplicate the inboxItems entry", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const perm = {
      jsonrpc: "2.0", id: 55, method: "session/request_permission",
      params: { sessionId: "home-session", toolCall: { title: "Edit a file" }, options: [{ optionId: "allow", name: "Allow" }] },
    };
    ws.recv(perm);
    ws.recv(perm); // gateway re-delivers the outstanding prompt after a reload
    await flush();
    expect((useStore.getState() as any).inboxItems.filter((it: any) => String(it.reqId) === "55")).toHaveLength(1);
  });

  test("answerPermission clears the inboxItems copy too (no stale badge entry)", async () => {
    const { useStore, ws } = await bootstrapClaude();
    ws.recv({
      jsonrpc: "2.0", id: 33, method: "session/request_permission",
      params: { sessionId: "home-session", toolCall: { title: "Edit a file" }, options: [{ optionId: "allow", name: "Allow" }] },
    });
    await flush();
    expect((useStore.getState() as any).inboxItems).toHaveLength(1);
    (useStore.getState() as any).answerPermission(33, "allow");
    expect((useStore.getState() as any).inboxItems).toHaveLength(0);
  });

  test("ensureConnected is a no-op while the socket is open", async () => {
    const { useStore } = await bootstrapClaude();
    const before = FakeSse.instances.length;
    useStore.getState().ensureConnected();
    expect(FakeSse.instances.length).toBe(before);
    expect(useStore.getState().conn).toBe("connected");
  });

  test("ensureConnected reconnects after the socket dropped while backgrounded", async () => {
    const { useStore, ws } = await bootstrapClaude();
    ws.close(); // abnormal close, e.g. iOS reaping a backgrounded tab's socket
    await flush();
    expect(useStore.getState().conn).toBe("offline");

    const before = FakeSse.instances.length;
    useStore.getState().ensureConnected();
    // Reconnects immediately rather than waiting on the (possibly frozen) backoff.
    expect(FakeSse.instances.length).toBe(before + 1);
    expect(useStore.getState().conn).toBe("connecting");
  });

  test("opening a saved session surfaces a permission prompt that arrived while away", async () => {
    const { useStore, ws } = await bootstrapClaude();

    // A prompt for a session we haven't loaded — Fix #3 records it rather than
    // erroring; the history API will never carry it on reopen.
    ws.recv({
      jsonrpc: "2.0",
      id: 91,
      method: "session/request_permission",
      params: {
        sessionId: "bg-session",
        toolCall: { title: "Write a file" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(1);

    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "earlier work" }] }],
        total: 1,
        truncated: false,
      }),
    }));

    await useStore.getState().openHistorySession({ sessionId: "bg-session", title: "Background" });
    await flush();

    const perm = useStore.getState().sessions["bg-session"].items.find((it) => it.kind === "permission");
    expect(perm).toMatchObject({ reqId: 91, title: "Write a file", resolved: false });
  });

  test("recents derive a title from the first user message instead of Untitled", async () => {
    const { useStore } = await bootstrapClaude();
    const { makeSession, addUserBubble } = await import("./reducers.ts");

    // A loaded session that carries content but no explicit title (e.g. opened
    // from history on this device) — the recents cache must not record "Untitled".
    let sess = addUserBubble(makeSession("loaded-session", Date.now()), "幫我看一下 service configuration");
    sess = { ...sess, title: "Untitled" }; // simulate a session whose title was never derived
    useStore.setState({ sessions: { "loaded-session": sess }, activeId: "loaded-session" });

    useStore.getState().cancel(); // any activity touches the recents cache

    const recent = useStore.getState().recentSessions.find((r) => r.sessionId === "loaded-session");
    expect(recent?.title).toBe("幫我看一下 service configuration");
  });

  test("does not sync empty sessions into the browser URL", async () => {
    const replace = vi.spyOn(history, "replaceState");
    await bootstrapThenSwitchFolder();

    expect(replace).not.toHaveBeenCalled();
  });

  test("syncs the active session with a relative history URL after it has content", async () => {
    const replace = vi.spyOn(history, "replaceState");
    const { useStore, ws } = await bootstrapThenSwitchFolder();

    const sending = useStore.getState().sendPrompt("hello");
    await flush();

    expect(replace).toHaveBeenLastCalledWith(
      null,
      "",
      "/?agent=claude&session=new-session&cwd=%2Fnew",
    );

    const promptReq = JSON.parse(ws.sent[3]);
    expect(promptReq).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "new-session" },
    });
    ws.recv({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    await sending;
  });

  test("sendPrompt records the active session in local recent activity", async () => {
    const { useStore, ws } = await bootstrapThenSwitchFolder();

    const sending = useStore.getState().sendPrompt("hello recent");
    await flush();

    expect(useStore.getState().recentSessions[0]).toMatchObject({
      agentName: "claude",
      cwd: "/new",
      sessionId: "new-session",
      title: "hello recent",
    });

    const promptReq = JSON.parse(ws.sent[3]);
    ws.recv({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    await sending;
  });

  test("replying to a saved view-only session resumes using that session's cwd", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const { makeSession, addUserBubble } = await import("./reducers.ts");
    const saved = {
      ...addUserBubble(makeSession("saved-session", Date.now(), { agentName: "claude", cwd: "/saved" }), "previous work"),
      viewOnly: true,
    };
    useStore.setState((st: any) => ({
      cwd: "/other",
      activeId: "saved-session",
      sessions: { ...st.sessions, "saved-session": saved },
    }));

    const before = ws.sent.length;
    const sending = useStore.getState().sendPrompt("continue here");
    await flush();

    const load = JSON.parse(ws.sent[before]);
    expect(load).toMatchObject({
      method: "session/load",
      params: { sessionId: "saved-session", cwd: "/saved" },
    });
    ws.recv({ jsonrpc: "2.0", id: load.id, result: { sessionId: "saved-session" } });
    await flush();
    const prompt = JSON.parse(ws.sent[before + 1]);
    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
  });

  test("switching folders clears the active pointer before the new session arrives", async () => {
    const { useStore, ws } = await bootstrapClaude();
    ws.recv({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "home-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old folder work" } } },
    });
    await flush();
    expect(new URL(location.href).searchParams.get("session")).toBe("home-session");
    expect(new URL(location.href).searchParams.get("cwd")).toBe("/old");

    useStore.getState().setCwd("/new");

    expect(useStore.getState().cwd).toBe("/new");
    expect(useStore.getState().activeId).toBeNull();
    expect(location.search).toBe("");
    const newSessionReq = JSON.parse(ws.sent.at(-1)!);
    expect(newSessionReq).toMatchObject({ method: "session/new", params: { cwd: "/new" } });
  });

  test("opening a history session does not update local recent activity", async () => {
    // Seed the cache the store reads at init (recents live on the gateway now).
    const existingRecent = {
      agentName: "claude",
      cwd: "/old",
      sessionId: "existing-recent",
      title: "Existing recent",
      lastActiveAt: "2026-06-10T01:00:00.000Z",
    };
    const { hydrateRecentSessions } = await import("../lib/recentSessions.ts");
    hydrateRecentSessions([existingRecent]);
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({ messages: [], total: 0, truncated: false }),
    }));
    const { useStore } = await import("./store.ts");

    await useStore.getState().openHistorySession({ sessionId: "history-only", title: "History only" });
    await flush();

    expect(useStore.getState().recentSessions).toEqual([existingRecent]);
  });

  test("opening a recent session switches cwd and loads it without bumping recent activity", async () => {
    const crossFolderRecent = {
      agentName: "claude",
      cwd: "/other",
      sessionId: "recent-session",
      title: "Cross folder recent",
      lastActiveAt: "2026-06-10T01:00:00.000Z",
    };
    const { hydrateRecentSessions } = await import("../lib/recentSessions.ts");
    hydrateRecentSessions([crossFolderRecent]);
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "previous work" }] }],
        total: 1,
        truncated: false,
      }),
    }));
    const { useStore } = await import("./store.ts");

    await useStore.getState().openRecentSession({
      agentName: "claude",
      cwd: "/other",
      sessionId: "recent-session",
      title: "Cross folder recent",
      lastActiveAt: "2026-06-10T01:00:00.000Z",
    });

    expect(useStore.getState().cwd).toBe("/other");
    expect(useStore.getState().activeId).toBe("recent-session");
    expect(useStore.getState().sessions["recent-session"].viewOnly).toBe(true);
    const url = historyCalls[0];
    expect(url).toContain("cwd=%2Fother");
    expect(useStore.getState().recentSessions[0]).toMatchObject({
      sessionId: "recent-session",
      lastActiveAt: "2026-06-10T01:00:00.000Z",
    });
  });

  test("openRecentSession reconnects to the owning agent for a cross-agent recent", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [{ name: "claude", cwd: "/old" }, { name: "codex", cwd: "/codex-project", history: true }],
      fsRoot: "/",
    });
    const { useStore, ws } = await bootstrapClaude();

    await useStore.getState().openRecentSession({
      agentName: "codex", cwd: "/codex-here", sessionId: "codex-recent",
      title: "Codex recent", lastActiveAt: "2026-06-10T01:00:00.000Z",
    });

    // Old socket torn down; reconnect to codex via the deep-link join flow.
    expect(ws.closed).toBe(true);
    expect(useStore.getState().agentName).toBe("codex");
    expect(useStore.getState().cwd).toBe("/codex-here");
    expect(useStore.getState().joining).toBe(true);
    expect(location.search).toContain("agent=codex");
    expect(location.search).toContain("session=codex-recent");
    expect(location.search).toContain("cwd=%2Fcodex-here");
    expect(FakeSse.instances[1].url).toContain("agent=codex");
  });

  test("openHistorySession reconnects to the owning agent for a cross-agent conversation", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [{ name: "claude", cwd: "/old" }, { name: "codex", cwd: "/codex-project", history: true }],
      fsRoot: "/",
    });
    const { useStore, ws } = await bootstrapClaude();

    await useStore.getState().openHistorySession({
      sessionId: "codex-conv", title: "Codex conversation", agentName: "codex", cwd: "/old",
    });

    expect(ws.closed).toBe(true);
    expect(useStore.getState().agentName).toBe("codex");
    expect(useStore.getState().joining).toBe(true);
    expect(location.search).toContain("agent=codex");
    expect(location.search).toContain("session=codex-conv");
  });

  test("openHistorySession opens in place when the conversation belongs to the active agent", async () => {
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({ messages: [{ role: "user", blocks: [{ type: "text", text: "prior" }] }], total: 1, truncated: false }),
    }));
    const { useStore, ws } = await bootstrapClaude();

    await useStore.getState().openHistorySession({ sessionId: "same-agent", title: "Same agent", agentName: "claude" });
    await flushHistory();

    // Same socket — no reconnect — and the saved conversation loaded view-only.
    expect(ws.closed).toBe(false);
    expect(FakeSse.instances).toHaveLength(1);
    expect(useStore.getState().activeId).toBe("same-agent");
    expect(useStore.getState().sessions["same-agent"].viewOnly).toBe(true);
  });

  test("tracks in-flight prompts per session when switching conversations", async () => {
    const { useStore, ws } = await bootstrapThenCreateSecondSession();

    useStore.getState().setActive("first-session");
    const firstSending = useStore.getState().sendPrompt("first work");
    await flush();

    const firstPromptReq = JSON.parse(ws.sent[3]);
    expect(firstPromptReq).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "first-session" },
    });

    useStore.getState().setActive("second-session");
    const secondSending = useStore.getState().sendPrompt("second work");
    await flush();

    const secondPromptReq = JSON.parse(ws.sent[4]);
    expect(secondPromptReq).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "second-session" },
    });

    ws.recv({ jsonrpc: "2.0", id: firstPromptReq.id, result: { stopReason: "end_turn" } });
    await firstSending;
    await flush();

    expect(useStore.getState().activeId).toBe("second-session");
    expect(useStore.getState().sessions["first-session"].working).toBe(false);
    expect(useStore.getState().sessions["second-session"].working).toBe(true);
    expect(useStore.getState().busy).toBe(true);

    ws.recv({ jsonrpc: "2.0", id: secondPromptReq.id, result: { stopReason: "end_turn" } });
    await secondSending;
    await flush();

    expect(useStore.getState().sessions["second-session"].working).toBe(false);
    expect(useStore.getState().busy).toBe(false);
  });

  test("captures promptCapabilities and sends images as image content blocks", async () => {
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [] } });
    await flush();
    expect(useStore.getState().promptCapabilities.image).toBe(true);

    const sessReq = JSON.parse(ws.sent[1]);
    ws.recv({ jsonrpc: "2.0", id: sessReq.id, result: { sessionId: "img-session" } });
    await flush();

    const sending = useStore.getState().sendPrompt("what is this?", [{ mimeType: "image/png", data: "AAAA" }]);
    await flush();

    const prompt = JSON.parse(ws.sent[2]);
    expect(prompt).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "img-session",
        prompt: [
          { type: "text", text: "what is this?" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
      },
    });
    // the sent image is shown on the user's own bubble immediately
    const user = useStore.getState().sessions["img-session"].items.find((it) => it.kind === "user");
    expect(user).toMatchObject({ kind: "user", images: [{ mimeType: "image/png", data: "AAAA" }] });

    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
  });

  test("drops images when the agent does not report the image capability", async () => {
    const { useStore, ws } = await bootstrapClaude(); // init result reports no promptCapabilities
    expect(useStore.getState().promptCapabilities.image).toBeFalsy();

    const sending = useStore.getState().sendPrompt("text only", [{ mimeType: "image/png", data: "AAAA" }]);
    await flush();

    const prompt = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "text only" }]);
    const user = useStore.getState().sessions["home-session"].items.find((it) => it.kind === "user") as any;
    expect(user.images).toBeUndefined();

    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
  });

  test("connects to ACPG_DEFAULT_AGENT instead of the first agents.json entry", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "codex",
      agents: [
        { name: "claude", cwd: "/old" },
        { name: "codex", cwd: "/codex-project", history: true },
      ],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");

    expect(useStore.getState().agentName).toBe("codex");
    expect(useStore.getState().cwd).toBe("/codex-project");

    const ws = await bootstrapAndWaitForSse(useStore);
    expect(ws.url).toContain("agent=codex");
  });

  test("setAgent reconnects and keeps the prior agent's sessions while starting a fresh one", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/old" },
        { name: "codex", cwd: "/codex-project", history: true },
      ],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flushHistory();
    const sessReq = JSON.parse(ws.sent[1]);
    ws.recv({ jsonrpc: "2.0", id: sessReq.id, result: { sessionId: "claude-session" } });
    await flush();
    expect(useStore.getState().activeId).toBe("claude-session");

    useStore.getState().setAgent("codex");

    expect(useStore.getState().agentName).toBe("codex");
    // The working directory is preserved across the switch, not reset to the
    // new agent's configured cwd.
    expect(useStore.getState().cwd).toBe("/old");
    // Sessions are KEPT across the switch — the prior agent's session survives in
    // memory so switching back to it is an instant pointer swap (no wipe).
    expect(useStore.getState().sessions["claude-session"]).toBeDefined();
    // the old socket is gone, and its close didn't surface as offline/reconnect
    expect(ws.closed).toBe(true);
    expect(useStore.getState().conn).toBe("connecting");

    const ws2 = FakeSse.instances[1];
    expect(ws2.url).toContain("agent=codex");
    ws2.open();
    await flush();
    const init2 = JSON.parse(ws2.sent[0]);
    ws2.recv({ jsonrpc: "2.0", id: init2.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();
    // The kept activeId is a foreign-agent (claude) session, so codex starts a
    // fresh session/new rather than viewing the claude session.
    const sessReq2 = JSON.parse(ws2.sent[1]);
    expect(sessReq2).toMatchObject({ method: "session/new", params: { cwd: "/old" } });
    ws2.recv({ jsonrpc: "2.0", id: sessReq2.id, result: { sessionId: "codex-session" } });
    await flush();
    expect(useStore.getState().activeId).toBe("codex-session");
    // Retention holds after the codex session is established, too.
    expect(useStore.getState().sessions["claude-session"]).toBeDefined();
    expect(useStore.getState().conn).toBe("connected");
  });

  test("a transient reconnect does not pull the user back onto the agent's left-behind session", async () => {
    // Regression: handleStatus("connected") fires on every reconnect, including a
    // network-blip auto-reconnect. The switch-back fallback must restore
    // lastSessionByAgent ONLY when no live session of the current agent is already
    // active — otherwise a blip silently jumps the view off the user's current session.
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/old" },
        { name: "codex", cwd: "/codex-project", history: true },
      ],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flushHistory();
    const sessReq = JSON.parse(ws.sent[1]);
    ws.recv({ jsonrpc: "2.0", id: sessReq.id, result: { sessionId: "session-A" } });
    await flush();
    expect(useStore.getState().activeId).toBe("session-A");
    // Give A content so it is worth remembering — setAgent only stamps
    // lastSessionByAgent for a session with hasContent.
    ws.recv({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-A", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "work in A" } } } });
    await flush();
    expect(useStore.getState().sessions["session-A"].hasContent).toBe(true);

    // Switch claude -> codex -> claude to populate lastSessionByAgent[claude] = A and
    // land back on A (the live conversation re-activates with no fresh session/new).
    useStore.getState().setAgent("codex");
    const ws2 = FakeSse.instances[1];
    ws2.open();
    await flush();
    const init2 = JSON.parse(ws2.sent[0]);
    ws2.recv({ jsonrpc: "2.0", id: init2.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();
    const codexNew = JSON.parse(ws2.sent[1]);
    ws2.recv({ jsonrpc: "2.0", id: codexNew.id, result: { sessionId: "codex-session" } });
    await flush();

    useStore.getState().setAgent("claude");
    const ws3 = FakeSse.instances[2];
    expect(ws3.url).toContain("agent=claude");
    ws3.open();
    await flush();
    const init3 = JSON.parse(ws3.sent[0]);
    ws3.recv({ jsonrpc: "2.0", id: init3.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();
    // Back on the left-behind claude session A.
    expect(useStore.getState().activeId).toBe("session-A");

    // Open/create a DIFFERENT claude session B and make it active.
    const creatingB = useStore.getState().newSession();
    await flush();
    const newB = JSON.parse(ws3.sent.at(-1)!);
    expect(newB).toMatchObject({ method: "session/new" });
    ws3.recv({ jsonrpc: "2.0", id: newB.id, result: { sessionId: "session-B" } });
    await creatingB;
    await flush();
    expect(useStore.getState().activeId).toBe("session-B");
    const sentBeforeBlip = ws3.sent.length;

    // Simulate a transient drop: the live stream ends (fail(1006)) -> offline ->
    // a 1500ms auto-reconnect backoff opens a fresh socket. Drive that reconnect.
    vi.useFakeTimers();
    try {
      ws3.close(); // stream end surfaces as onclose(1006) -> handleStatus("offline")
      await vi.advanceTimersByTimeAsync(0); // drain the offline handler microtasks
      expect(useStore.getState().conn).toBe("offline");
      await vi.advanceTimersByTimeAsync(1500); // fire the reconnect timer -> acp.connect()
    } finally {
      vi.useRealTimers();
    }
    await flush();

    // The reconnect opened a new socket on the same (claude) Acp.
    const ws4 = FakeSse.instances[3];
    expect(ws4.url).toContain("agent=claude");
    ws4.open();
    await flush();
    const init4 = JSON.parse(ws4.sent[0]);
    ws4.recv({ jsonrpc: "2.0", id: init4.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();

    // The blip must NOT have pulled the view back to A, and must NOT have started a
    // spurious fresh session (B is still a live current-agent session).
    expect(useStore.getState().activeId).toBe("session-B");
    expect(ws4.sent.length).toBe(1); // only the initialize frame; no session/new
    expect(ws3.sent.length).toBe(sentBeforeBlip); // no late frames on the dead socket
  });

  test("switching agents and back instantly re-activates the live conversation without a history fetch", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/old" },
        { name: "codex", cwd: "/codex-project", history: true },
      ],
      fsRoot: "/",
    });
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "remembered work" }] }],
        total: 1,
        truncated: false,
      }),
    }));
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flushHistory();
    const sessReq = JSON.parse(ws.sent[1]);
    ws.recv({ jsonrpc: "2.0", id: sessReq.id, result: { sessionId: "claude-session" } });
    await flush();
    // Give the session content so it's worth remembering.
    ws.recv({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "claude-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
    await flush();
    expect(useStore.getState().sessions["claude-session"].hasContent).toBe(true);

    // Switch away to codex, then back to claude.
    useStore.getState().setAgent("codex");
    const ws2 = FakeSse.instances[1];
    ws2.open();
    await flush();
    const init2 = JSON.parse(ws2.sent[0]);
    ws2.recv({ jsonrpc: "2.0", id: init2.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();

    // Switch back to claude. The claude-session is still live in memory, so the
    // switch-back is an instant pointer swap (activateLive) with NO /history fetch.
    const historyBefore = historyCalls.length;
    useStore.getState().setAgent("claude");
    const ws3 = FakeSse.instances[2];
    expect(ws3.url).toContain("agent=claude");
    ws3.open();
    await flush();
    const init3 = JSON.parse(ws3.sent[0]);
    ws3.recv({ jsonrpc: "2.0", id: init3.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flushHistory();

    // Re-activated the still-live conversation instantly (no rebuild).
    expect(useStore.getState().activeId).toBe("claude-session");
    // No new /history/messages call happened during the switch-back.
    expect(historyCalls.length).toBe(historyBefore);
    // The prior content is still present (never lost / never re-fetched).
    const restored = useStore.getState().sessions["claude-session"];
    expect(restored.items.some((it) => it.kind === "assistant" && it.text === "hi")).toBe(true);
  });

  test("setAgent keeps a background session's outstanding permission as the durable source", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [{ name: "claude", cwd: "/old" }, { name: "codex", cwd: "/codex-project", history: true }],
      fsRoot: "/",
    });
    const { useStore, ws } = await bootstrapClaude();

    // A prompt for a claude session we don't have loaded — recorded (not errored)
    // and tagged with the agent whose connection can answer its reqId.
    ws.recv({
      jsonrpc: "2.0",
      id: 70,
      method: "session/request_permission",
      params: {
        sessionId: "bg-session",
        toolCall: { title: "Write a file" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();
    expect((useStore.getState() as any).pendingPermissions).toMatchObject([
      { reqId: 70, sessionId: "bg-session", agentName: "claude" },
    ]);

    // Switching agent keeps sessions live, so it must also keep the durable prompt —
    // wiping it would lose the pending badge on a switch-away/back even though the
    // conversation (and its reqId on the gateway) survives.
    useStore.getState().setAgent("codex");
    expect(useStore.getState().agentName).toBe("codex");
    expect((useStore.getState() as any).pendingPermissions).toMatchObject([
      { reqId: 70, sessionId: "bg-session", agentName: "claude" },
    ]);
  });

  test("answering a prompt does not clear a colliding reqId on another agent's retained session", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [{ name: "claude", cwd: "/old" }, { name: "codex", cwd: "/codex-project", history: true }],
      fsRoot: "/",
    });
    const { useStore, ws } = await bootstrapClaude();

    // A claude prompt for a background session, recorded as durable + tagged claude.
    ws.recv({
      jsonrpc: "2.0",
      id: 7, // agent request ids are per-connection, so codex can reuse this number
      method: "session/request_permission",
      params: {
        sessionId: "claude-bg",
        toolCall: { title: "Claude edit" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();

    // Switch to codex (claude's prompt stays durable) and get a codex prompt that
    // happens to reuse reqId 7 on codex's own connection.
    useStore.getState().setAgent("codex");
    const ws2 = FakeSse.instances[1];
    ws2.open();
    await flush();
    const init2 = JSON.parse(ws2.sent[0]);
    ws2.recv({ jsonrpc: "2.0", id: init2.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();
    const codexNew = JSON.parse(ws2.sent[1]);
    ws2.recv({ jsonrpc: "2.0", id: codexNew.id, result: { sessionId: "codex-session" } });
    await flush();
    ws2.recv({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "codex-bg",
        toolCall: { title: "Codex edit" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
    await flush();
    expect((useStore.getState() as any).pendingPermissions).toHaveLength(2);

    // Answering codex's reqId 7 must clear ONLY codex's entry — claude's identically
    // numbered prompt is a different request on a different connection and stays pending.
    (useStore.getState() as any).answerPermission(7, "allow");
    const remaining = (useStore.getState() as any).pendingPermissions;
    expect(remaining).toMatchObject([{ reqId: 7, sessionId: "claude-bg", agentName: "claude" }]);
  });

  test("setAgent ignores unknown agents and the current agent", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [{ name: "claude", cwd: "/old" }],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();

    useStore.getState().setAgent("claude");
    useStore.getState().setAgent("nope");

    expect(useStore.getState().agentName).toBe("claude");
    expect(FakeSse.instances).toHaveLength(1);
    expect(ws.closed).toBe(false);
  });

  test("falls back to the first agents.json entry when the default agent is unknown", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "gone",
      agents: [{ name: "claude", cwd: "/old" }],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");

    expect(useStore.getState().agentName).toBe("claude");
    expect(useStore.getState().cwd).toBe("/old");
  });

  test("clears a stale deep-link when joining the session fails", async () => {
    history.replaceState(null, "", "/?session=missing-session&cwd=%2Fold");
    const replace = vi.spyOn(history, "replaceState");
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();

    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();

    const load = JSON.parse(ws.sent[1]);
    expect(load).toMatchObject({
      method: "session/load",
      params: { sessionId: "missing-session", cwd: "/old" },
    });
    ws.recv({ jsonrpc: "2.0", id: load.id, error: { code: -32603, message: "Internal error", data: { details: "Session not found" } } });
    await flush();

    const fallback = JSON.parse(ws.sent[2]);
    expect(fallback).toMatchObject({ method: "session/new", params: { cwd: "/old" } });
    ws.recv({ jsonrpc: "2.0", id: fallback.id, result: { sessionId: "fresh-empty" } });
    await flush();

    expect(useStore.getState().activeId).toBe("fresh-empty");
    expect(useStore.getState().tip).toBe("");
    expect(replace).toHaveBeenCalledWith(null, "", "/");
  });

  test("opens deep-links for agents without session/load from history", async () => {
    history.replaceState(null, "", "/?session=codex-archived&cwd=%2Fcodex-project");
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "codex",
      agents: [{ name: "codex", cwd: "/codex-project", history: true, sessionLoad: false }],
      fsRoot: "/",
    });
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "shared codex context" }] }],
        total: 1,
        truncated: false,
      }),
    }));
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();

    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();

    expect(ws.sent.map((raw) => JSON.parse(raw).method)).toEqual(["initialize"]);
    expect(useStore.getState().activeId).toBe("codex-archived");
    expect(useStore.getState().joining).toBe(false);
    expect(useStore.getState().sessions["codex-archived"].viewOnly).toBe(true);
    const url = historyCalls[0];
    expect(url).toContain("/history/messages?agent=codex");
    expect(url).toContain("session=codex-archived");
  });

  test("honors a live loadSession capability to resume a Codex deep-link over ACP", async () => {
    history.replaceState(null, "", "/?session=codex-archived&cwd=%2Fcodex-project");
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "codex",
      // The gateway-injected flag is a conservative guess; the live initialize
      // handshake is authoritative and flips it to true.
      agents: [{ name: "codex", cwd: "/codex-project", history: true, sessionLoad: false }],
      fsRoot: "/",
    });
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "shared codex context" }] }],
        total: 1,
        truncated: false,
      }),
    }));
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();

    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    await flushHistory();

    // loadSession:true → the deep-link joins the SAME session over ACP instead
    // of opening it view-only and forking on the first reply.
    const load = JSON.parse(ws.sent[1]);
    expect(load).toMatchObject({ method: "session/load", params: { sessionId: "codex-archived", cwd: "/codex-project" } });
    ws.recv({ jsonrpc: "2.0", id: load.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await flushHistory();
    expect(useStore.getState().sessions["codex-archived"].viewOnly).toBe(false);

    const sending = useStore.getState().sendPrompt("continue from here");
    await flush();

    // Continues the resumed session — no cancel, no fork.
    const prompt = JSON.parse(ws.sent[2]);
    expect(prompt).toMatchObject({ method: "session/prompt", params: { sessionId: "codex-archived" } });
    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
    await flush();

    expect(ws.sent.map((raw) => JSON.parse(raw).method)).not.toContain("session/new");
    expect(useStore.getState().activeId).toBe("codex-archived");
  });

  test("replying to history for agents without session/load starts a new session", async () => {
    history.replaceState(null, "", "/?session=codex-archived&cwd=%2Fcodex-project");
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "codex",
      agents: [{ name: "codex", cwd: "/codex-project", history: true, sessionLoad: false }],
      fsRoot: "/",
    });
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "shared codex context" }] }],
        total: 1,
        truncated: false,
      }),
    }));
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flushHistory();

    const sending = useStore.getState().sendPrompt("continue from here");
    await flush();

    // Forking abandons the old session — it must be cancelled so a stalled prior
    // turn on the gateway doesn't linger as a duplicate running task.
    const cancel = JSON.parse(ws.sent[1]);
    expect(cancel).toMatchObject({ method: "session/cancel", params: { sessionId: "codex-archived" } });

    const start = JSON.parse(ws.sent[2]);
    expect(start).toMatchObject({ method: "session/new", params: { cwd: "/codex-project" } });
    ws.recv({ jsonrpc: "2.0", id: start.id, result: { sessionId: "codex-fork" } });
    await flush();

    const prompt = JSON.parse(ws.sent[3]);
    expect(prompt).toMatchObject({ method: "session/prompt", params: { sessionId: "codex-fork" } });
    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
    await flush();

    expect(ws.sent.map((raw) => JSON.parse(raw).method)).not.toContain("session/load");
    expect(useStore.getState().activeId).toBe("codex-fork");
    expect(useStore.getState().sessions["codex-fork"].items.some((it) => it.kind === "user" && it.text === "continue from here")).toBe(true);
  });

  test("writes live Codex sessions into the share URL with the agent name", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "codex",
      agents: [{ name: "codex", cwd: "/codex-project", history: true, sessionLoad: false }],
      fsRoot: "/",
    });
    const { useStore } = await import("./store.ts");

    const ws = await bootstrapAndWaitForSse(useStore);
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();

    const start = JSON.parse(ws.sent[1]);
    ws.recv({ jsonrpc: "2.0", id: start.id, result: { sessionId: "codex-live" } });
    await flush();

    const sending = useStore.getState().sendPrompt("live codex work");
    await flush();
    const prompt = JSON.parse(ws.sent[2]);
    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
    await flush();

    expect(location.search).toContain("agent=codex");
    expect(location.search).toContain("session=codex-live");
    // Codex still can't resume, so it stays out of the resumable "recent" list.
    expect(useStore.getState().recentSessions).toEqual([]);
  });

  test("jumpToTask opens a same-folder task in place without reconnecting", async () => {
    const { useStore } = await bootstrapClaude();
    const { makeSession } = await import("./reducers.ts");
    // A sibling session already loaded under the current folder.
    useStore.setState((st) => ({ sessions: { ...st.sessions, sibling: makeSession("sibling") } }) as any);

    useStore.getState().jumpToTask({ agentName: "claude", sessionId: "sibling", state: "active", cwd: "/old" });

    // Switched in place — same socket, no reconnect.
    expect(useStore.getState().activeId).toBe("sibling");
    expect(FakeSse.instances).toHaveLength(1);
    expect(useStore.getState().joining).toBe(false);
  });

  test("jumpToTask reconnects to the gateway-reported folder for a cross-folder task", async () => {
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({ messages: [{ role: "user", blocks: [{ type: "text", text: "remote work" }] }], total: 1, truncated: false }),
    }));
    const { useStore, ws } = await bootstrapClaude();

    // A task the gateway says runs in a DIFFERENT folder than the one we're in.
    useStore.getState().jumpToTask({ agentName: "claude", sessionId: "remote-session", state: "active", cwd: "/elsewhere" });

    // Old socket torn down; URL + state now point at the task's real folder.
    expect(ws.closed).toBe(true);
    expect(useStore.getState().cwd).toBe("/elsewhere");
    expect(useStore.getState().joining).toBe(true);
    expect(location.search).toContain("agent=claude");
    expect(location.search).toContain("session=remote-session");
    expect(location.search).toContain("cwd=%2Felsewhere");

    // The reconnected socket joins via session/load in the gateway-reported cwd,
    // not the folder we happened to be browsing before the jump.
    const ws2 = FakeSse.instances[1];
    expect(ws2).toBeDefined();
    ws2.open();
    await flush();
    const init2 = JSON.parse(ws2.sent[0]);
    ws2.recv({ jsonrpc: "2.0", id: init2.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();
    const load = JSON.parse(ws2.sent[1]);
    expect(load).toMatchObject({ method: "session/load", params: { sessionId: "remote-session", cwd: "/elsewhere" } });
  });

  test("jumpToTask switches agent and uses the gateway cwd for a cross-agent task", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [{ name: "claude", cwd: "/old" }, { name: "codex", cwd: "/codex-project", history: true }],
      fsRoot: "/",
    });
    const { useStore, ws } = await bootstrapClaude();

    useStore.getState().jumpToTask({ agentName: "codex", sessionId: "codex-task", state: "awaiting-input", cwd: "/codex-here" });

    expect(ws.closed).toBe(true);
    expect(useStore.getState().agentName).toBe("codex");
    // The gateway cwd wins over the previous agent's folder.
    expect(useStore.getState().cwd).toBe("/codex-here");
    expect(location.search).toContain("agent=codex");
    expect(location.search).toContain("session=codex-task");
    expect(location.search).toContain("cwd=%2Fcodex-here");
    const ws2 = FakeSse.instances[1];
    expect(ws2.url).toContain("agent=codex");
  });

  test("jumpToTask falls back to recents for cwd when an older gateway omits it", async () => {
    // No task.cwd (older gateway) — the folder must come from the account's recents,
    // which the gateway returns from GET /prefs and bootstrap hydrates.
    setPrefs({ recentSessions: [{
      agentName: "claude", cwd: "/recalled", sessionId: "rec-task", title: "Recalled", lastActiveAt: "2026-06-10T01:00:00.000Z",
    }] });
    const { useStore } = await bootstrapClaude();
    // recents are hydrated during bootstrap; confirm it's present.
    expect(useStore.getState().recentSessions.some((r) => r.sessionId === "rec-task")).toBe(true);

    useStore.getState().jumpToTask({ agentName: "claude", sessionId: "rec-task", state: "active" });

    expect(useStore.getState().cwd).toBe("/recalled");
    expect(location.search).toContain("cwd=%2Frecalled");
  });

  test("newSession switches to an empty provisional immediately, then adopts the real id", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const before = ws.sent.length;

    const creating = useStore.getState().newSession();

    // The view moves on the click — a brand-new empty conversation is active
    // before session/new has come back.
    const provId = useStore.getState().activeId!;
    expect(provId).not.toBe("home-session");
    expect(provId.startsWith("pending-")).toBe(true);
    expect(useStore.getState().sessions[provId].hasContent).toBe(false);
    expect(useStore.getState().tip).toBe("Starting session…");

    const req = JSON.parse(ws.sent[before]);
    expect(req).toMatchObject({ method: "session/new", params: { cwd: "/old" } });
    ws.recv({ jsonrpc: "2.0", id: req.id, result: { sessionId: "fresh-session" } });
    await creating;
    await flush();

    // The provisional is swapped for the real session id, no stray pending entry.
    expect(useStore.getState().activeId).toBe("fresh-session");
    expect(useStore.getState().sessions[provId]).toBeUndefined();
    expect(useStore.getState().tip).toBe("");
  });

  test("ignores repeat + clicks while a new session is still resolving", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const before = ws.sent.length;

    const first = useStore.getState().newSession();
    const provId = useStore.getState().activeId!;
    // A second tap (because nothing seems to happen yet) must not stack up a
    // second provisional or fire another session/new round-trip.
    void useStore.getState().newSession();
    expect(useStore.getState().activeId).toBe(provId);
    expect(ws.sent.length).toBe(before + 1);

    const req = JSON.parse(ws.sent[before]);
    ws.recv({ jsonrpc: "2.0", id: req.id, result: { sessionId: "fresh-session" } });
    await first;
    await flush();
    expect(useStore.getState().activeId).toBe("fresh-session");
  });

  test("a prompt sent while session/new is in flight keeps its bubble and adopts the real id", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const before = ws.sent.length;

    const creating = useStore.getState().newSession();
    const provId = useStore.getState().activeId!;

    // User starts typing and sends before the agent has created the session.
    const sending = useStore.getState().sendPrompt("hello during wait");
    expect(useStore.getState().sessions[provId].items.some((it) => it.kind === "user" && it.text === "hello during wait")).toBe(true);

    await flush();
    // newSession and the prompt share the single in-flight session/new.
    const req = JSON.parse(ws.sent[before]);
    expect(req.method).toBe("session/new");
    ws.recv({ jsonrpc: "2.0", id: req.id, result: { sessionId: "fresh-session" } });
    await creating;
    await flush();

    // Remapped to the real id, the in-flight bubble preserved, no orphaned provisional.
    expect(useStore.getState().activeId).toBe("fresh-session");
    expect(useStore.getState().sessions[provId]).toBeUndefined();
    expect(useStore.getState().sessions["fresh-session"].items.some((it) => it.kind === "user" && it.text === "hello during wait")).toBe(true);

    const prompt = JSON.parse(ws.sent[before + 1]);
    expect(prompt).toMatchObject({ method: "session/prompt", params: { sessionId: "fresh-session" } });
    ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await sending;
  });

  test("rolls back the provisional and shows an error when session/new fails", async () => {
    const { useStore, ws } = await bootstrapClaude();
    const before = ws.sent.length;

    const creating = useStore.getState().newSession();
    const provId = useStore.getState().activeId!;
    expect(provId.startsWith("pending-")).toBe(true);

    const req = JSON.parse(ws.sent[before]);
    ws.recv({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "agent unavailable" } });
    await creating;
    await flush();

    expect(useStore.getState().sessions[provId]).toBeUndefined();
    expect(useStore.getState().activeId).toBeNull();
    expect(useStore.getState().tip).toContain("Couldn't start session");
  });

  test("boots under the agent named in a deep-link instead of the default", async () => {
    history.replaceState(null, "", "/?agent=codex&session=codex-archived&cwd=%2Fcodex-project");
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      token: "test-token",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/claude-project", history: true, sessionLoad: true },
        { name: "codex", cwd: "/codex-project", history: true, sessionLoad: false },
      ],
      fsRoot: "/",
    });
    setHistoryFetch(() => Promise.resolve({
      json: () => Promise.resolve({
        messages: [{ role: "user", blocks: [{ type: "text", text: "shared codex context" }] }],
        total: 1,
        truncated: false,
      }),
    }));
    const { useStore } = await import("./store.ts");

    expect(useStore.getState().agentName).toBe("codex");

    const ws = await bootstrapAndWaitForSse(useStore);
    expect(ws.url).toContain("agent=codex");
    ws.open();
    await flush();
    const init = JSON.parse(ws.sent[0]);
    ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    await flush();

    expect(useStore.getState().activeId).toBe("codex-archived");
    expect(useStore.getState().sessions["codex-archived"].viewOnly).toBe(true);
    const url = historyCalls[0];
    expect(url).toContain("/history/messages?agent=codex");
  });

  test("answerInboxItem clears the SSE pendingPermissions copy and resolves the in-thread item (no ghost prompt)", async () => {
    const { useStore } = await import("./store.ts");
    const { makeSession } = await import("./reducers.ts");
    const opts = [{ optionId: "allow", kind: "allow_once", name: "Allow" }];
    // Session S (non-active) holds the prompt both in-thread AND in pendingPermissions
    // (SSE), and it's also in the polled inbox. Answering from the badge must clear
    // all three, else appendPendingPermissions re-adds reqId 99 as a ghost on reopen.
    const sess = {
      ...makeSession("S"), agentName: "claude", seq: 1,
      items: [{ id: "S:1", kind: "permission" as const, reqId: 99, title: "Edit", options: opts, resolved: false }],
    };
    useStore.setState({
      agentName: "claude", activeId: "other",
      sessions: { S: sess } as any,
      pendingPermissions: [{ reqId: 99, sessionId: "S", agentName: "claude", title: "Edit", options: opts, createdAt: 1 }],
      inboxItems: [{ id: 1, agentName: "claude", sessionId: "S", reqId: "99", title: "Edit", options: opts, status: "pending", createdAt: "x" }],
    });

    (useStore.getState() as any).answerInboxItem("claude", "99", "allow");

    const st = useStore.getState() as any;
    expect(st.inboxItems).toHaveLength(0);
    expect(st.pendingPermissions).toHaveLength(0);
    const item = st.sessions.S.items.find((it: any) => it.kind === "permission" && String(it.reqId) === "99");
    expect(item.resolved).toBe(true);
  });
});
