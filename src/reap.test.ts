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
