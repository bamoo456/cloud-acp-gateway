import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestServer, SESSION_IDLE_TTL_MS, TASK_TTL_MS } from "./gateway.ts";
import { sse, post, parseFrame as parse } from "./sse-testclient.ts";

// A future wall-clock far past the idle TTL, so reap(now) tears every idle session
// down without the test waiting on a real timer.
const FAR_FUTURE = Date.now() + 60 * 60 * 1000;

type Stream = ReturnType<typeof sse>;
type Agent = { sent: string[]; emit: (b: Buffer) => void };

// Open one ACP session over its own SSE stream: session/new, then make the fake
// agent answer with `sid`. Pushes the stream into `streams` so the test can close
// them all before tearing the server down (an open SSE conn blocks srv.close()).
// `options` are the controls the new session reports itself running, as
// claude-agent-acp's session/new does — the gateway records them from here.
async function openSession(
  port: number, agent: () => Agent, sid: string, streams: Stream[], options?: unknown[],
): Promise<{ conn: string; stream: Stream }> {
  const c = sse(port);
  streams.push(c);
  const conn = await c.conn;
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/x" } });
  const fwd = agent().sent.map(parse).filter((o) => o.method === "session/new").at(-1)!;
  const result = options ? { sessionId: sid, configOptions: options } : { sessionId: sid };
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwd.id, result })));
  await c.next((e) => !!e.data && parse(e.data).id === 1); // session is tracked once the response routes back
  await new Promise((r) => setTimeout(r, 10)); // controls are recorded just after the response routes
  return { conn, stream: c };
}

const closeSidsIn = (sent: string[]): string[] =>
  sent.map(parse).filter((o) => o.method === "session/close").map((o) => (o.params as { sessionId?: string }).sessionId!).filter(Boolean);

const shutdown = (streams: Stream[], close: () => Promise<void>) => {
  for (const s of streams) s.close();
  return close();
};

test("reap closes only sessions idle past the TTL", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  await openSession(port, agent, "S1", streams);
  agent().sent.length = 0;

  reap(Date.now()); // not idle yet
  assert.deepEqual(closeSidsIn(agent().sent), [], "not reaped before TTL");

  reap(FAR_FUTURE); // now past TTL
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "reaped after TTL");
  await shutdown(streams, close);
});

test("a session with an in-flight task is never reaped", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  // Start a turn — this marks the session's task active.
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "go" }] } });
  agent().sent.length = 0;

  reap(FAR_FUTURE);
  assert.deepEqual(closeSidsIn(agent().sent), [], "a running session is exempt from reaping");
  await shutdown(streams, close);
});

// Ask the fake agent for a permission on `sid`, then send the usage_update that
// production always emits on the very next frame for the same session. That pair
// is the whole bug: the heartbeat used to overwrite awaiting-input with "active",
// so the protection survived exactly one frame.
async function blockOnPermission(agent: () => Agent, sid: string, reqId: number): Promise<void> {
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "session/request_permission", params: { sessionId: sid } })));
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage_update", usage: {} } } })));
  await new Promise((r) => setTimeout(r, 40));
}

test("a session waiting on an unanswered permission is never reaped, however long the user takes", async () => {
  const { port, agent, running, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "go" }] } });
  await blockOnPermission(agent, "S1", 99);
  agent().sent.length = 0;

  // running() is the ONLY thing that prunes tasks, and the console polls /running
  // every 5s while a tab is visible — so this poll is what used to delete the task
  // and hand the session to the reaper. Driving it an hour out proves it doesn't.
  assert.equal(running(FAR_FUTURE)[0]?.state, "awaiting-input", "the poll leaves a session blocked on the user alone");

  reap(FAR_FUTURE);
  assert.deepEqual(closeSidsIn(agent().sent), [], "no session/close — reaping one would interrupt the live turn");
  await shutdown(streams, close);
});

test("answering the permission and ending the turn makes the session reapable again", async () => {
  const { port, agent, running, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "go" }] } });
  await blockOnPermission(agent, "S1", 99);

  // The user answers, the agent finishes the turn. Nothing is blocked on a human
  // any more, so the exemption must lift — this fix must not leak live sessions.
  await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: { outcome: "selected", optionId: "yes" } } });
  const prompt = agent().sent.map(parse).find((o) => o.method === "session/prompt")!;
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })));
  await new Promise((r) => setTimeout(r, 40));
  agent().sent.length = 0;

  assert.deepEqual(running(FAR_FUTURE), [], "the finished turn is no longer running");
  reap(FAR_FUTURE);
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "reaped as normal once idle");
  await shutdown(streams, close);
});

test("a silently running turn is never reaped, however long it stays quiet", async () => {
  const { port, agent, running, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "xcodebuild test" }] } });
  agent().sent.length = 0;

  // One `xcodebuild test` runs for minutes emitting no ACP frames, so nothing
  // heartbeats the task and nothing refreshes the idle window either.
  const base = Date.now();
  assert.ok(TASK_TTL_MS > SESSION_IDLE_TTL_MS, "the task TTL outlasts the idle TTL, so /running doesn't call a quiet turn finished");
  const early = base + SESSION_IDLE_TTL_MS + 1_000; // idle window open, task TTL not yet
  assert.equal(running(early)[0]?.state, "active", "the poll keeps the silently running task");
  reap(early);
  assert.deepEqual(closeSidsIn(agent().sent), [], "still working → not reaped");

  // Past the task TTL the poll DOES prune the task — and that must not hand the
  // session to the reaper. Raising the task TTL only postponed the same kill; the
  // unanswered session/prompt is the evidence no clock can retract, and it is what
  // the reaper actually consults.
  const late = base + TASK_TTL_MS + 1_000;
  assert.deepEqual(running(late), [], "the task itself is still TTL-pruned, as before");
  reap(late);
  assert.deepEqual(closeSidsIn(agent().sent), [], "prompt still unanswered → still not reaped");
  await shutdown(streams, close);
});

test("a turn whose prompt has been answered becomes reapable again", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "go" }] } });
  const prompt = agent().sent.map(parse).find((o) => o.method === "session/prompt")!;
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })));
  await new Promise((r) => setTimeout(r, 40));
  agent().sent.length = 0;

  // The exemption has to lift, or the fix trades a killed turn for a leaked
  // subprocess — reaping exists to bound exactly that.
  reap(FAR_FUTURE);
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "the finished turn no longer holds the session open");
  await shutdown(streams, close);
});

test("a prompt is released even when the client that sent it is already gone", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn, stream } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "go" }] } });
  const prompt = agent().sent.map(parse).find((o) => o.method === "session/prompt")!;

  // The phone drops mid-turn. idmux.forgetConn discards this request's origin, so
  // the response below arrives with nothing to route it to — the exact path the
  // old code left to the TTL, and the reason the release is keyed on the gateway
  // id instead. Without it the session stays pinned as "running" forever and its
  // backing CLI is never reclaimed.
  stream.close();
  await new Promise((r) => setTimeout(r, 60));
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })));
  await new Promise((r) => setTimeout(r, 40));
  agent().sent.length = 0;

  reap(FAR_FUTURE);
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "the orphaned response still released the session");
  await shutdown(streams, close);
});

test("session/cancel releases the turn it ended", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "go" }] } });

  // The agent may never answer a cancelled prompt (the ACP contract lets it just
  // stop), so cancel has to release the turn itself or the session is pinned.
  await post(port, conn, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S1" } });
  await new Promise((r) => setTimeout(r, 40));
  agent().sent.length = 0;

  reap(FAR_FUTURE);
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "a cancelled turn does not keep the session alive");
  await shutdown(streams, close);
});

test("opening past the LRU cap reaps the least-recently-active idle session", async () => {
  const { port, agent, close } = await makeTestServer();
  const streams: Stream[] = [];
  // Default cap is 5; open 6 distinct sessions.
  for (let i = 1; i <= 6; i++) await openSession(port, agent, `S${i}`, streams);
  // The first (oldest, idle) is evicted to make room for the sixth.
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "LRU victim is the oldest idle session");
  await shutdown(streams, close);
});

test("LRU eviction skips a session blocked on an unanswered prompt", async () => {
  const { port, agent, close } = await makeTestServer();
  const streams: Stream[] = [];
  for (let i = 1; i <= 5; i++) await openSession(port, agent, `S${i}`, streams);

  // No prompt was forwarded for S1, so nothing tracks it in `tasks` — the guard
  // that has to hold here is the one on the unanswered prompt itself. It is not
  // redundant with the `tasks` check: a task is TTL-prunable, an outstanding
  // prompt is not, which is exactly the asymmetry the reaper bug turned on.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S1" } })));
  // That permission also marked S1 most-recently-active, so re-touch the others
  // to put S1 back at the head of the queue — the position that elects a victim.
  for (const sid of ["S2", "S3", "S4", "S5"]) {
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } } } })));
  }
  await new Promise((r) => setTimeout(r, 40));
  agent().sent.length = 0;

  await openSession(port, agent, "S6", streams);
  assert.deepEqual(closeSidsIn(agent().sent), ["S2"], "S1 is waiting on the user; the next-oldest idle session goes instead");
  await shutdown(streams, close);
});

test("a client frame for a reaped session transparently re-loads it, then forwards", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);

  reap(FAR_FUTURE); // reap S1
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"]);
  agent().sent.length = 0;

  // Client prompts the reaped session. The gateway must first send session/load
  // (revive) and NOT yet forward the prompt.
  await post(port, conn, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "again" }] } });
  let sent = agent().sent.map(parse);
  const load = sent.find((o) => o.method === "session/load" && (o.params as { sessionId?: string }).sessionId === "S1");
  assert.ok(load, "a transparent session/load was sent for the reaped session");
  assert.equal(sent.some((o) => o.method === "session/prompt"), false, "prompt is parked until the load completes");

  // Adapter answers the load → the parked prompt is flushed.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: load!.id, result: { sessionId: "S1" } })));
  await new Promise((r) => setTimeout(r, 10));
  sent = agent().sent.map(parse);
  assert.ok(sent.some((o) => o.method === "session/prompt" && (o.params as { sessionId?: string }).sessionId === "S1"), "prompt forwarded after load");
  await shutdown(streams, close);
});

test("a revive's load replay is dropped outright — delivered to nobody and not appended", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn, stream } = await openSession(port, agent, "S1", streams);

  reap(FAR_FUTURE); // S1's CLI is reclaimed
  agent().sent.length = 0;

  // Touching the reaped session revives it. This load's gate points at
  // REVIVE_SENTINEL — not a real conn — so the adapter's replay reaches no client
  // at all. It used to be written to the ledger anyway: a full copy of the
  // conversation persisted on behalf of nobody.
  await post(port, conn, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "again" }] } });
  const load = agent().sent.map(parse).find((o) => o.method === "session/load" && (o.params as { sessionId?: string }).sessionId === "S1");
  assert.ok(load, "a transparent session/load was sent for the reaped session");

  const revivedNo = (e: { data: string }) => (parse(e.data).params as { revived?: number })?.revived;
  for (let n = 1; n <= 3; n++) {
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", revived: n } })));
  }
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: load!.id, result: { sessionId: "S1" } })));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    stream.frames.some((e) => !!e.data && revivedNo(e) !== undefined),
    false,
    "the touching client already has its history rendered — re-broadcasting would duplicate it",
  );

  // A frame the ledger DOES hold, giving the replay client below a deterministic
  // stopping point.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", marker: "after-revive" } })));
  const replay = sse(port, { lastEventId: "0" });
  streams.push(replay);
  await replay.next((e) => !!e.data && (parse(e.data).params as { marker?: string })?.marker === "after-revive");
  assert.equal(
    replay.frames.some((e) => !!e.data && revivedNo(e) !== undefined),
    false,
    "nothing consumed the revive replay, so nothing should have persisted it either",
  );
  await shutdown(streams, close);
});

// --- session controls across a rebuilt session -------------------------------
// The adapter holds mode/model/effort/agent in memory only, so a session that was
// reaped (or LRU-evicted, or whose fingerprint changed) comes back from
// session/load at its DEFAULTS. Nobody else can put them back: the client that
// chose them may never even see that load — a revive's response routes to a
// sentinel conn and is dropped — so the gateway re-applies them itself, before
// anything else reaches the rebuilt session.

// One select-type config option, shaped like claude-agent-acp's.
const option = (id: string, currentValue: string, values: string[] = ["default", currentValue]) => ({
  id,
  name: id,
  type: "select",
  currentValue,
  options: [...new Set(values)].map((v) => ({ value: v, name: v })),
});

// A client sets one control and the adapter accepts it, answering (as it does) with
// the full option list. That response is what the gateway records.
async function setControl(
  port: number,
  agent: () => Agent,
  conn: string,
  sid: string,
  configId: string,
  value: string,
  reqId: number,
  answer: unknown = { configOptions: [option(configId, value)] },
): Promise<void> {
  await post(port, conn, { jsonrpc: "2.0", id: reqId, method: "session/set_config_option", params: { sessionId: sid, configId, value } });
  const fwd = agent().sent.map(parse).filter((o) => o.method === "session/set_config_option").at(-1)!;
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwd.id, result: answer })));
  await new Promise((r) => setTimeout(r, 10));
}

const controlsIn = (sent: string[]): Array<{ configId: string; value: string }> =>
  sent.map(parse).filter((o) => o.method === "session/set_config_option")
    .map((o) => o.params as { configId: string; value: string })
    .map(({ configId, value }) => ({ configId, value }));

// Answer a revive load with a session rebuilt at `options`' values, then let the
// re-apply run. Returns the frames the agent has been sent since.
async function answerLoad(agent: () => Agent, sid: string, options: unknown[]): Promise<void> {
  const load = agent().sent.map(parse).find((o) => o.method === "session/load" && (o.params as { sessionId?: string }).sessionId === sid)!;
  assert.ok(load, "a session/load was sent");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: load.id, result: { sessionId: sid, configOptions: options } })));
  await new Promise((r) => setTimeout(r, 20));
}

// Bounded because this one waits on an SSE frame the gateway only sends when the
// re-apply works: a regression should fail here, not hang the suite.
test("a revived session gets its controls back before the parked frame is forwarded", { timeout: 5_000 }, async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn, stream } = await openSession(port, agent, "S1", streams);
  await setControl(port, agent, conn, "S1", "mode", "plan", 2);

  reap(FAR_FUTURE);
  agent().sent.length = 0;

  await post(port, conn, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "again" }] } });
  await answerLoad(agent, "S1", [option("mode", "default", ["default", "plan"])]);

  assert.deepEqual(controlsIn(agent().sent), [{ configId: "mode", value: "plan" }], "the chosen mode is re-applied");
  assert.equal(
    agent().sent.map(parse).some((o) => o.method === "session/prompt"),
    false,
    "the prompt waits for the re-apply — running it in the default mode is the bug",
  );

  // Adapter confirms → the prompt goes through, and every attached client learns
  // the new values (the adapter emits no notification for set_config_option).
  const setReq = agent().sent.map(parse).find((o) => o.method === "session/set_config_option")!;
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: setReq.id, result: { configOptions: [option("mode", "plan")] } })));

  const evt = await stream.next((e) => e.data.includes("config_option_update"));
  const update = (parse(evt.data).params as { update: { configOptions: Array<{ id: string; currentValue: string }> } }).update;
  assert.deepEqual(update.configOptions.map((o) => [o.id, o.currentValue]), [["mode", "plan"]], "clients are told the re-applied values");

  await new Promise((r) => setTimeout(r, 20));
  assert.ok(agent().sent.map(parse).some((o) => o.method === "session/prompt"), "prompt forwarded once the controls are back");
  await shutdown(streams, close);
});

test("a client's own session/load gets the controls put back too", async () => {
  const { port, agent, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await setControl(port, agent, conn, "S1", "effort", "high", 2);
  agent().sent.length = 0;

  // The app returns from the background and reloads; the adapter rebuilt the
  // session from disk, at its defaults.
  await post(port, conn, { jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: "S1", cwd: "/x" } });
  await answerLoad(agent, "S1", [option("effort", "default", ["default", "high"])]);

  assert.deepEqual(controlsIn(agent().sent), [{ configId: "effort", value: "high" }], "effort is restored without the client asking");
  await shutdown(streams, close);
});

test("a control the rebuilt session no longer offers is dropped, not re-applied", async () => {
  const { port, agent, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await setControl(port, agent, conn, "S1", "model", "opus", 2);
  agent().sent.length = 0;

  // The model is gone from this session's option list (agent upgrade, model
  // retired). Pushing a value the adapter would reject is worse than leaving it.
  await post(port, conn, { jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: "S1", cwd: "/x" } });
  await answerLoad(agent, "S1", [option("model", "default", ["default", "sonnet"])]);

  assert.deepEqual(controlsIn(agent().sent), [], "no re-apply for a value that is no longer on offer");
  await shutdown(streams, close);
});

test("a value the adapter clamped is remembered as clamped, not as the client asked", async () => {
  const { port, agent, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await setControl(port, agent, conn, "S1", "mode", "plan", 2);
  // Switching model invalidated `plan`, so the adapter clamped mode back to
  // default and says so in the same response. Re-applying `plan` on every later
  // load would fight that clamp forever.
  await setControl(port, agent, conn, "S1", "model", "haiku", 3, {
    configOptions: [option("model", "haiku"), option("mode", "default", ["default", "plan"])],
  });
  agent().sent.length = 0;

  await post(port, conn, { jsonrpc: "2.0", id: 4, method: "session/load", params: { sessionId: "S1", cwd: "/x" } });
  await answerLoad(agent, "S1", [option("model", "haiku"), option("mode", "default", ["default", "plan"])]);

  assert.deepEqual(controlsIn(agent().sent), [], "nothing to put back — the session came back as the adapter left it");
  await shutdown(streams, close);
});

test("a silent adapter still releases the parked frame", async () => {
  const previous = process.env.ACPG_CONTROL_ACK_TIMEOUT_MS;
  process.env.ACPG_CONTROL_ACK_TIMEOUT_MS = "60";
  try {
    const { port, agent, reap, close } = await makeTestServer();
    const streams: Stream[] = [];
    const { conn } = await openSession(port, agent, "S1", streams);
    await setControl(port, agent, conn, "S1", "mode", "plan", 2);

    reap(FAR_FUTURE);
    agent().sent.length = 0;

    await post(port, conn, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "again" }] } });
    await answerLoad(agent, "S1", [option("mode", "default", ["default", "plan"])]);
    assert.deepEqual(controlsIn(agent().sent), [{ configId: "mode", value: "plan" }]);

    // The adapter never answers the re-apply. A held-back prompt is worse than a
    // wrong mode, so the wait is bounded and the frame goes through anyway.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(agent().sent.map(parse).some((o) => o.method === "session/prompt"), "the user's prompt is not swallowed by a silent adapter");
    await shutdown(streams, close);
  } finally {
    if (previous === undefined) delete process.env.ACPG_CONTROL_ACK_TIMEOUT_MS;
    else process.env.ACPG_CONTROL_ACK_TIMEOUT_MS = previous;
  }
});

// --- what a session runs, remembered from its own start and across a restart ---
// The controls a client sets are only half the story: a conversation nobody ever
// switched by hand still ran on SOMETHING, and the adapter resolves that from its
// CLI's global config (~/.claude/settings.json) at every session/new AND every
// session/load. So a resumed conversation silently moves to whatever that config
// says today unless the gateway records what the session itself reported.

test("a session's own starting controls are put back on a rebuild, with nobody having set one", async () => {
  const { port, agent, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams, [option("effort", "xhigh", ["default", "high", "xhigh"])]);

  reap(FAR_FUTURE);
  agent().sent.length = 0;

  // The rebuild reports `high` — the CLI's global config moved under us. What the
  // conversation actually ran is xhigh, and that is what it must come back as.
  await post(port, conn, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "again" }] } });
  await answerLoad(agent, "S1", [option("effort", "high", ["default", "high", "xhigh"])]);

  assert.deepEqual(controlsIn(agent().sent), [{ configId: "effort", value: "xhigh" }], "the session's own value, not the global default");
  await shutdown(streams, close);
});

// The re-apply is sequential — each control waits for the adapter's answer before
// the next goes out (switching model rebuilds the effort list) — so a test that
// expects more than one put back has to play the adapter for each.
async function ackControls(agent: () => Agent, rounds = 4): Promise<void> {
  const answered = new Set<unknown>();
  for (let i = 0; i < rounds; i++) {
    const pending = agent().sent.map(parse)
      .filter((o) => o.method === "session/set_config_option" && !answered.has(o.id));
    if (!pending.length) return;
    for (const req of pending) {
      answered.add(req.id);
      const p = req.params as { configId: string; value: string };
      agent().emit(Buffer.from(JSON.stringify({
        jsonrpc: "2.0", id: req.id, result: { configOptions: [option(p.configId, p.value)] },
      })));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a session's controls survive a gateway restart", async () => {
  const first = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(first.port, first.agent, "S1", streams, [option("model", "opus", ["default", "opus", "sonnet"])]);
  await setControl(first.port, first.agent, conn, "S1", "effort", "xhigh", 2);
  await shutdown(streams, first.close);

  // A redeploy: new process, new agent, every adapter session gone. The client
  // reopens the conversation, which loads it from disk at the adapter's defaults.
  const second = await makeTestServer({ ledgerDir: first.ledgerDir });
  const streams2: Stream[] = [];
  const c = sse(second.port);
  streams2.push(c);
  const conn2 = await c.conn;
  await post(second.port, conn2, { jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "S1", cwd: "/x" } });
  await answerLoad(second.agent, "S1", [
    option("model", "sonnet", ["default", "opus", "sonnet"]),
    option("effort", "high", ["default", "high", "xhigh"]),
  ]);
  await ackControls(second.agent);

  assert.deepEqual(
    controlsIn(second.agent().sent),
    [{ configId: "model", value: "opus" }, { configId: "effort", value: "xhigh" }],
    "the table outlived the process that recorded it",
  );
  await shutdown(streams2, second.close);
});

test("the agent's configured defaults are applied to a new session, and an unusable one is dropped", async () => {
  const { port, agent, close } = await makeTestServer({ defaults: { model: "opus", effort: "max" } });
  const streams: Stream[] = [];
  await openSession(port, agent, "S1", streams, [
    option("model", "sonnet", ["default", "opus", "sonnet"]),
    // This session's adapter doesn't offer `max` — pushing it would just be a
    // rejection on every session the gateway opens.
    option("effort", "high", ["default", "high", "xhigh"]),
  ]);

  assert.deepEqual(controlsIn(agent().sent), [{ configId: "model", value: "opus" }], "the gateway's default replaces the CLI's, the unusable one is dropped");
  await shutdown(streams, close);
});

// --- a forked conversation ----------------------------------------------------
// claude-agent-acp's session/fork answers with a NEW session id, so the gateway has
// to register that id exactly as it registers a session/new — the request itself
// only names the SOURCE. And a fork continues one specific conversation, so it
// inherits that conversation's controls instead of coming up on this agent's
// configured defaults the way a genuinely new session does.

// Branch a live conversation. `options` are the controls the forked session reports
// itself running — the CLI's current global config, as any fresh session does. The
// cwd differs from openSession's so the pairing is provably the fork's own.
async function forkSession(
  port: number, agent: () => Agent, conn: string, sourceSid: string, sid: string, reqId: number, options?: unknown[],
): Promise<void> {
  await post(port, conn, { jsonrpc: "2.0", id: reqId, method: "session/fork", params: { sessionId: sourceSid, cwd: "/fork", mcpServers: [] } });
  const fwd = agent().sent.map(parse).filter((o) => o.method === "session/fork").at(-1)!;
  const result = options ? { sessionId: sid, configOptions: options } : { sessionId: sid };
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwd.id, result })));
  await new Promise((r) => setTimeout(r, 20)); // controls are applied just after the response routes
}

// Bounded for the same reason the revive test is: the subscription half waits on a
// frame the gateway only routes once the fork is registered, so a regression has to
// fail here rather than hang the suite.
test("a session/fork response registers the new session against the forking client", { timeout: 5_000 }, async () => {
  const { port, agent, running, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn, stream } = await openSession(port, agent, "S1", streams);
  await forkSession(port, agent, conn, "S1", "S2", 5);

  await post(port, conn, { jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId: "S2", prompt: [{ type: "text", text: "go" }] } });
  assert.deepEqual(
    running().find((t) => t.sessionId === "S2"),
    { agentName: "claude", sessionId: "S2", state: "active", cwd: "/fork", title: "go" },
    "the fork's own cwd is paired onto the session its response created",
  );

  // An agent->client request goes to a session's viewers only, so one arriving
  // proves the forking conn was subscribed to an id it never named itself.
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 77, method: "session/request_permission",
    params: { sessionId: "S2", toolCall: { title: "Run a tool" }, options: [] },
  })));
  const evt = await stream.next((e) => !!e.data && parse(e.data).id === 77);
  assert.equal((parse(evt.data).params as { sessionId: string }).sessionId, "S2", "the fork's frames reach the client that asked for it");

  await shutdown(streams, close);
});

test("a forked session inherits the source conversation's controls, not the agent's defaults", async () => {
  const { port, agent, close } = await makeTestServer({ defaults: { model: "haiku" } });
  const streams: Stream[] = [];
  // S1 doesn't offer `haiku`, so the configured default is dropped there and the
  // conversation runs on what the client then chose.
  const { conn } = await openSession(port, agent, "S1", streams, [option("model", "sonnet", ["default", "opus", "sonnet"])]);
  await setControl(port, agent, conn, "S1", "model", "opus", 2);
  agent().sent.length = 0;

  // The fork comes up on the CLI's global config, like every fresh session — and
  // offers `haiku`, so a fork routed through the defaults would land there instead.
  await forkSession(port, agent, conn, "S1", "S2", 3, [option("model", "sonnet", ["default", "opus", "sonnet", "haiku"])]);

  assert.deepEqual(controlsIn(agent().sent), [{ configId: "model", value: "opus" }], "the branch continues on the model the source ran");
  await ackControls(agent);
  await shutdown(streams, close);
});

test("a fork of a source with nothing recorded is left at its own values", async () => {
  const { port, agent, close } = await makeTestServer({ defaults: { model: "opus" } });
  const streams: Stream[] = [];
  // A bare session/new result records nothing — the same state a conversation the
  // CLI created and the gateway adopted from history is in.
  const { conn } = await openSession(port, agent, "S1", streams);
  agent().sent.length = 0;

  await forkSession(port, agent, conn, "S1", "S2", 3, [option("model", "sonnet", ["default", "opus", "sonnet"])]);

  assert.deepEqual(controlsIn(agent().sent), [], "nothing to inherit means nothing is pushed — the defaults are not a fallback");
  await shutdown(streams, close);
});
