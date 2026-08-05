import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeTestServer } from "./gateway.ts";
import { sse, post, sseStatus, parseFrame as parse, USER, TOKEN } from "./sse-testclient.ts";

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 1000)),
  ]);
}

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
  const isResolved = (frame: Record<string, unknown>) =>
    frame.method === "_gateway/prompt_resolved" &&
    (frame.params as { sessionId?: string } | undefined)?.sessionId === "S";
  const resolvedA = withTimeout(
    a.next((e) => !!e.data && isResolved(parse(e.data))),
    "first viewer did not receive the prompt resolution",
  );
  const resolvedB = withTimeout(
    b.next((e) => !!e.data && isResolved(parse(e.data))),
    "second viewer did not receive the prompt resolution",
  );

  // Both answer; only the first reaches the agent and both see one durable
  // resolution notification carrying the original request-id type.
  await post(port, ca, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
  const [gotResolvedA, gotResolvedB] = await Promise.all([resolvedA, resolvedB]);
  assert.deepEqual(parse(gotResolvedA.data), {
    jsonrpc: "2.0",
    method: "_gateway/prompt_resolved",
    params: {
      sessionId: "S",
      requestId: 99,
      requestMethod: "session/request_permission",
    },
  });
  assert.deepEqual(parse(gotResolvedB.data), parse(gotResolvedA.data));

  await post(port, cb, { jsonrpc: "2.0", id: 99, result: { outcome: "deny" } });
  const marker = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", marker: "after-losing-answer" } };
  agent().emit(Buffer.from(JSON.stringify(marker)));
  await Promise.all([
    a.next((e) => !!e.data && (parse(e.data).params as { marker?: string })?.marker === "after-losing-answer"),
    b.next((e) => !!e.data && (parse(e.data).params as { marker?: string })?.marker === "after-losing-answer"),
  ]);
  for (const client of [a, b]) {
    assert.equal(
      client.frames.filter((e) => !!e.data && isResolved(parse(e.data))).length,
      1,
      "a losing answer must not append or broadcast a second tombstone",
    );
  }
  const answers = agent().sent.map(parse).filter((o) => o.id === 99 && "result" in o);
  assert.equal(answers.length, 1);
  assert.equal((answers[0].result as { outcome?: string }).outcome, "allow");
  a.close(); b.close();
  await close();
});

test("a prompt resolution append failure returns 500 and remains retryable over RPC", async () => {
  const { port, agent, inbox, failNextLedgerAppend, close } = await makeTestServer();
  const client = sse(port);
  try {
    const conn = await client.conn;
    await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S", options: [] },
    })));
    await client.next((e) => !!e.data && parse(e.data).id === 99);
    agent().sent.length = 0;

    failNextLedgerAppend();
    const url = `http://127.0.0.1:${port}/acp/rpc?user=u&token=t&agent=claude&conn=${encodeURIComponent(conn)}`;
    const failed = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, result: { outcome: "allow" } }),
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(failed.status, 500);
    assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 1);
    assert.equal(agent().sent.filter((line) => parse(line).id === 99).length, 0);

    assert.equal(await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } }), 202);
    assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 0);
    assert.equal(agent().sent.filter((line) => parse(line).id === 99).length, 1);
  } finally {
    client.close();
    await close();
  }
});

test("replay hides a resolved request while preserving the tombstone in each cursor window", async () => {
  const { port, agent, close } = await makeTestServer();
  const clients: Array<ReturnType<typeof sse>> = [];
  const live = sse(port);
  clients.push(live);
  try {
    const conn = await live.conn;
    await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" },
    })));
    const request = await live.next((event) =>
      !!event.data && parse(event.data).method === "session/request_permission");
    assert.notEqual(request.id, null);

    const resolvedPromise = live.next((event) =>
      !!event.data && parse(event.data).method === "_gateway/prompt_resolved");
    await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
    const resolution = await resolvedPromise;
    assert.notEqual(resolution.id, null);

    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", marker: "after-resolution" },
    })));
    await live.next((event) =>
      !!event.data && (parse(event.data).params as { marker?: string })?.marker === "after-resolution");

    const beforeRequest = sse(port, { lastEventId: "0" });
    clients.push(beforeRequest);
    await beforeRequest.next((event) =>
      !!event.data && (parse(event.data).params as { marker?: string })?.marker === "after-resolution");
    assert.ok(beforeRequest.frames.some((event) =>
      event.id === resolution.id && !!event.data && parse(event.data).method === "_gateway/prompt_resolved"));
    assert.equal(beforeRequest.frames.some((event) =>
      !!event.data && parse(event.data).method === "session/request_permission"), false);

    const between = sse(port, { lastEventId: String(request.id) });
    clients.push(between);
    await between.next((event) => event.id === resolution.id);
    assert.ok(between.frames.some((event) =>
      !!event.data && parse(event.data).method === "_gateway/prompt_resolved"));
    assert.equal(between.frames.some((event) =>
      !!event.data && parse(event.data).method === "session/request_permission"), false);

    const after = sse(port, { lastEventId: String(resolution.id) });
    clients.push(after);
    await after.next((event) =>
      !!event.data && (parse(event.data).params as { marker?: string })?.marker === "after-resolution");
    assert.equal(after.frames.some((event) => {
      if (!event.data) return false;
      const frame = parse(event.data);
      return frame.method === "session/request_permission" || frame.method === "_gateway/prompt_resolved";
    }), false);
  } finally {
    for (const client of clients) client.close();
    await close();
  }
});

test("an unanswered replayed permission remains visible and answerable", async () => {
  const { port, agent, inbox, close } = await makeTestServer();
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" },
  })));
  const resumed = sse(port, { lastEventId: "0" });
  try {
    const request = await resumed.next((event) =>
      !!event.data && parse(event.data).method === "session/request_permission");
    assert.equal(parse(request.data).id, 99);

    const conn = await resumed.conn;
    agent().sent.length = 0;
    assert.equal(await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } }), 202);
    assert.equal(agent().sent.filter((line) => parse(line).id === 99).length, 1);
    assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 0);
  } finally {
    resumed.close();
    await close();
  }
});

test("replay keeps only the latest pending occurrence when a request id is reused", async () => {
  const { port, agent, close } = await makeTestServer();
  const clients: Array<ReturnType<typeof sse>> = [];
  const live = sse(port);
  clients.push(live);
  try {
    const conn = await live.conn;
    await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S", round: 1 },
    })));
    const firstRequest = await live.next((event) =>
      !!event.data && parse(event.data).method === "session/request_permission");
    const firstResolutionPromise = live.next((event) =>
      !!event.data && parse(event.data).method === "_gateway/prompt_resolved");
    await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
    const firstResolution = await firstResolutionPromise;
    assert.notEqual(firstResolution.id, null);

    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S", round: 2 },
    })));
    const secondRequest = await live.next((event) =>
      event.id !== firstRequest.id && !!event.data && parse(event.data).method === "session/request_permission");
    assert.notEqual(secondRequest.id, null);

    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", marker: "after-reused-request" },
    })));
    await live.next((event) =>
      !!event.data && (parse(event.data).params as { marker?: string })?.marker === "after-reused-request");

    const resumed = sse(port, { lastEventId: "0" });
    clients.push(resumed);
    await resumed.next((event) =>
      !!event.data && (parse(event.data).params as { marker?: string })?.marker === "after-reused-request");
    const replayedRequests = resumed.frames.filter((event) =>
      !!event.data && parse(event.data).method === "session/request_permission" && parse(event.data).id === 99);
    assert.equal(replayedRequests.length, 1);
    assert.equal(replayedRequests[0].id, secondRequest.id);
    const resolutionIndex = resumed.frames.findIndex((event) => event.id === firstResolution.id);
    const secondRequestIndex = resumed.frames.findIndex((event) => event.id === secondRequest.id);
    assert.notEqual(resolutionIndex, -1);
    assert.notEqual(secondRequestIndex, -1);
    assert.ok(resolutionIndex < secondRequestIndex);
  } finally {
    for (const client of clients) client.close();
    await close();
  }
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

test("ready is written before the replay, not after it", async () => {
  const { port, agent, close } = await makeTestServer();
  for (let n = 1; n <= 3; n++) {
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", n } })));
  }

  // The shared sse() helper strips the ready event out of `frames`, so ordering
  // needs a raw client that records every block in wire order.
  const order: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}/acp/sse?user=${USER}&token=${TOKEN}&agent=claude`,
      { headers: { accept: "text/event-stream", "last-event-id": "0" } },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(":")) continue; // keepalive
            order.push(block.includes("event: ready") ? "ready" : "frame");
            // Three replayed frames requested; stop once everything expected arrived.
            if (order.length === 4) { req.destroy(); resolve(); }
          }
        });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      // destroy() above surfaces as a socket error after we already resolved.
      if (order.length < 4) reject(e);
    });
    setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(order)}`)), 1000);
  });
  assert.deepEqual(order, ["ready", "frame", "frame", "frame"]);
  await close();
});

test("?session= scopes the replay to that session plus channel-scoped frames", async () => {
  const { port, agent, close } = await makeTestServer();
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", n: 1 } })));
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S2", n: 2 } })));
  // No sessionId → appended with sid null, i.e. a channel-scoped frame (the same
  // shape _gateway/agent_restart takes). The filter must keep it.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "channel/notice", params: {} })));
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", n: 3 } })));

  const c = sse(port, { lastEventId: "0", session: "S1" });
  // The last S1 frame is the barrier: replay is ordered, so once it arrives the
  // filter has already decided about everything before it.
  await c.next((e) => !!e.data && (parse(e.data).params as { n?: number })?.n === 3);
  const methods = c.frames.map((e) => parse(e.data)).map((f) => `${f.method}:${(f.params as { sessionId?: string; n?: number })?.sessionId ?? "-"}`);
  assert.deepEqual(methods, ["session/update:S1", "channel/notice:-", "session/update:S1"]);
  c.close();
  await close();
});

test("no ?session= replays the whole channel exactly as before", async () => {
  const { port, agent, close } = await makeTestServer();
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", n: 1 } })));
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S2", n: 2 } })));

  const c = sse(port, { lastEventId: "0" });
  await c.next((e) => !!e.data && (parse(e.data).params as { n?: number })?.n === 2);
  const sids = c.frames.map((e) => (parse(e.data).params as { sessionId?: string }).sessionId);
  assert.deepEqual(sids, ["S1", "S2"]);
  c.close();
  await close();
});
