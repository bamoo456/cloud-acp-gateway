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

test("a silently running turn is not reaped when the idle window opens", async () => {
  const { port, agent, running, reap, close } = await makeTestServer();
  const streams: Stream[] = [];
  const { conn } = await openSession(port, agent, "S1", streams);
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "xcodebuild test" }] } });
  agent().sent.length = 0;

  // One `xcodebuild test` runs for minutes emitting no ACP frames, so nothing
  // heartbeats the task and nothing refreshes the idle window either. The task is
  // the reaper's only evidence the turn is alive, so its TTL has to outlast the
  // idle TTL — otherwise the console's own poll prunes the task in the gap and
  // the next sweep tears down a session that is genuinely working.
  const base = Date.now();
  assert.ok(TASK_TTL_MS > SESSION_IDLE_TTL_MS, "the task TTL must never expire before the idle TTL would");
  const t = base + SESSION_IDLE_TTL_MS + 1_000; // idle window open, task TTL not yet
  assert.equal(running(t)[0]?.state, "active", "the poll keeps the silently running task");
  reap(t);
  assert.deepEqual(closeSidsIn(agent().sent), [], "still working → not reaped");
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
