import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestServer } from "./gateway.ts";
import { sse, post, parseFrame as parse } from "./sse-testclient.ts";

// A future wall-clock far past the idle TTL, so reap(now) tears every idle session
// down without the test waiting on a real timer.
const FAR_FUTURE = Date.now() + 60 * 60 * 1000;

type Stream = ReturnType<typeof sse>;
type Agent = { sent: string[]; emit: (b: Buffer) => void };

// Open one ACP session over its own SSE stream: session/new, then make the fake
// agent answer with `sid`. Pushes the stream into `streams` so the test can close
// them all before tearing the server down (an open SSE conn blocks srv.close()).
async function openSession(port: number, agent: () => Agent, sid: string, streams: Stream[]): Promise<{ conn: string; stream: Stream }> {
  const c = sse(port);
  streams.push(c);
  const conn = await c.conn;
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/x" } });
  const fwd = agent().sent.map(parse).filter((o) => o.method === "session/new").at(-1)!;
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwd.id, result: { sessionId: sid } })));
  await c.next((e) => !!e.data && parse(e.data).id === 1); // session is tracked once the response routes back
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

test("opening past the LRU cap reaps the least-recently-active idle session", async () => {
  const { port, agent, close } = await makeTestServer();
  const streams: Stream[] = [];
  // Default cap is 5; open 6 distinct sessions.
  for (let i = 1; i <= 6; i++) await openSession(port, agent, `S${i}`, streams);
  // The first (oldest, idle) is evicted to make room for the sixth.
  assert.deepEqual(closeSidsIn(agent().sent), ["S1"], "LRU victim is the oldest idle session");
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
