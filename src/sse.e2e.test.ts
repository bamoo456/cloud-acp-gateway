import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestServer } from "./gateway.ts";
import { sse, post, sseStatus, parseFrame as parse } from "./sse-testclient.ts";

test("SSE rejects a connection without valid credentials", async () => {
  const { port, close } = await makeTestServer();
  assert.equal(await sseStatus(port, "agent=claude"), 401);
  await close();
});

test("SSE resume replays only frames after Last-Event-ID, tagging each with id:=seq", async () => {
  const { port, agent, close } = await makeTestServer();
  for (let n = 1; n <= 3; n++) {
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", n } })));
  }
  // Last-Event-ID:2 → only seq 3 replays.
  const mid = sse(port, { lastEventId: "2" });
  const firstMid = await mid.next((e) => !!e.data && parse(e.data).method === "session/update");
  assert.equal(firstMid.id, 3);
  assert.equal((parse(firstMid.data).params as { n?: number }).n, 3);

  // Last-Event-ID:0 → full replay from seq 1.
  const full = sse(port, { lastEventId: "0" });
  const firstFull = await full.next((e) => !!e.data && parse(e.data).method === "session/update");
  assert.equal(firstFull.id, 1);

  mid.close(); full.close();
  await close();
});

test("POST upstream routes to the agent (id rewritten); the response returns on SSE", async () => {
  const { port, agent, close } = await makeTestServer();
  const c = sse(port);
  const conn = await c.conn;

  assert.equal(await post(port, conn, { jsonrpc: "2.0", id: 777, method: "session/new", params: { cwd: "/x" } }), 202);
  // the agent saw the request with a gateway-rewritten id (not the client's 777)
  const fwded = agent().sent.map(parse).find((o) => o.method === "session/new")!;
  assert.ok(fwded);
  assert.notEqual(fwded.id, 777);
  // agent answers that gateway id → client gets the response with its original id 777
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwded.id, result: { sessionId: "S" } })));
  const resp = await c.next((e) => !!e.data && parse(e.data).id === 777);
  assert.equal((parse(resp.data).result as { sessionId?: string }).sessionId, "S");

  c.close();
  await close();
});

test("a point-to-point response is NOT replayed to an unrelated reconnecting client", async () => {
  const { port, agent, close } = await makeTestServer();
  // Client A prompts; the agent's response is routed only to A on the live path.
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  const fwded = agent().sent.map(parse).find((o) => o.method === "session/prompt")!;
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwded.id, result: { secret: "A-only" } })));
  // A sees its own response (id rewritten back to its client id 1).
  await a.next((e) => !!e.data && parse(e.data).id === 1);

  // A later broadcast notification gives B a deterministic barrier to wait on:
  // it is appended AFTER the response, so once B has it, B has seen everything
  // the ledger would replay up to that point.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", marker: 1 } })));

  // Client B does a full replay from the start of the ledger.
  const b = sse(port, { lastEventId: "0" });
  await b.next((e) => !!e.data && (parse(e.data).params as { marker?: number })?.marker === 1);
  // B must never have received A's point-to-point response.
  const leaked = b.frames.some((e) => !!e.data && (parse(e.data).result as { secret?: string })?.secret === "A-only");
  assert.equal(leaked, false, "B received A's point-to-point response during replay");

  a.close(); b.close();
  await close();
});

test("a notification broadcasts to every SSE stream", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  await Promise.all([a.conn, b.conn]); // both attached
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", hi: 1 } })));
  const gotA = await a.next((e) => !!e.data && parse(e.data).method === "session/update");
  const gotB = await b.next((e) => !!e.data && parse(e.data).method === "session/update");
  assert.equal((parse(gotA.data).params as { hi?: number }).hi, 1);
  assert.equal((parse(gotB.data).params as { hi?: number }).hi, 1);
  a.close(); b.close();
  await close();
});

test("permission goes to viewers over SSE; first POST reply wins, the rest are dropped", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const ca = await a.conn;
  const cb = await b.conn;
  // both view session S (a prompt subscribes them)
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  await post(port, cb, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  agent().sent.length = 0;
  // agent asks permission on S
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await Promise.all([
    a.next((e) => !!e.data && parse(e.data).id === 99),
    b.next((e) => !!e.data && parse(e.data).id === 99),
  ]);
  // both answer; only the first reaches the agent
  await post(port, ca, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
  await post(port, cb, { jsonrpc: "2.0", id: 99, result: { outcome: "deny" } });
  const answers = agent().sent.map(parse).filter((o) => o.id === 99 && "result" in o);
  assert.equal(answers.length, 1);
  assert.equal((answers[0].result as { outcome?: string }).outcome, "allow");
  a.close(); b.close();
  await close();
});

test("POST to an unknown conn is rejected with 409", async () => {
  const { port, close } = await makeTestServer();
  assert.equal(await post(port, "no-such-conn", { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S" } }), 409);
  await close();
});

test("a closed SSE stream does not break broadcast to the survivors", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  await Promise.all([a.conn, b.conn]);
  a.close(); // A drops
  await new Promise((r) => setTimeout(r, 20));
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", hi: 2 } })));
  const gotB = await b.next((e) => !!e.data && parse(e.data).method === "session/update");
  assert.equal((parse(gotB.data).params as { hi?: number }).hi, 2);
  b.close();
  await close();
});
