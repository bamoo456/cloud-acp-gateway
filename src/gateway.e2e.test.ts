import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { makeTestServer, Gateway, TASK_TTL_MS, handleRequest, type Conn } from "./gateway.ts";
import { Db } from "./db.ts";
import { sse, post, sseStatus, USER, TOKEN, parseFrame, type Evt } from "./sse-testclient.ts";

// Parsed message type
type Msg = Record<string, unknown>;

const authHeader = (user: string, pass: string) =>
  "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");

// makeTestServer() above wires only the SSE+POST transport (handleSseRpc), not
// the Basic-auth'd HTTP surface (/history*, /fs, ...) — that lives in
// handleRequest, which the real entrypoint only attaches to a listening server
// when ACPG_NO_LISTEN is unset. Tests always set ACPG_NO_LISTEN=1, so exercising
// that surface means wiring handleRequest to our own ephemeral server here.
// Auth is the gateway's real Basic credentials (ACPG_AUTH_USER/ACPG_AUTH_TOKEN),
// not the SSE transport's "u"/"t" test constant above.
function startHttpServer(): Promise<{ base: string; authed: (p: string) => Promise<Response>; close: () => Promise<void> }> {
  const srv = http.createServer(handleRequest);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const authed = (p: string) => fetch(base + p, {
        headers: { authorization: authHeader(process.env.ACPG_AUTH_USER ?? "", process.env.ACPG_AUTH_TOKEN ?? "") },
      });
      resolve({ base, authed, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

// Await the next agent->client frame whose parsed body matches pred.
function nextFrame(c: { next: (p: (e: Evt) => boolean) => Promise<Evt> }, pred: (o: Msg) => boolean): Promise<Msg> {
  return c.next((e) => { if (!e.data) return false; try { return pred(parseFrame(e.data)); } catch { return false; } })
    .then((e) => parseFrame(e.data));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

test("SSE connection requires account credentials for remote clients", async () => {
  const { port, close } = await makeTestServer();
  try {
    assert.equal(await sseStatus(port, `token=${TOKEN}&agent=claude`), 401);
    assert.equal(await sseStatus(port, `user=wrong&token=${TOKEN}&agent=claude`), 401);
    assert.equal(await sseStatus(port, "agent=claude", { authorization: authHeader(USER, TOKEN) }), 200);
  } finally {
    await close();
  }
});

test("learns the agent's real loadSession capability from its initialize reply", async () => {
  const { port, agent, sessionLoad, close } = await makeTestServer();
  const c = sse(port);
  const conn = await c.conn;

  // Unknown until the agent answers — callers fall back to the name-based guess.
  assert.equal(sessionLoad("claude"), undefined);

  // Client initializes; the gateway forwards it to the agent with a rewritten id.
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const fwd = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "initialize");
  const gatewayId = fwd!.id as number;

  // The agent reports it CANNOT load — overriding the optimistic name-based guess.
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: gatewayId,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: false } },
  })));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sessionLoad("claude"), false);

  c.close();
  await close();
});

test("a second client's initialize is answered from cache, never re-forwarded (codex 'Already initialized')", async () => {
  // One agent process is shared across connections, but codex-acp accepts
  // `initialize` exactly once (a second returns -32603 "Already initialized").
  // The gateway must forward only the first and answer reconnects from cache,
  // else the reconnecting client's init rejects and its send button stays greyed.
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const connA = await a.conn;

  await post(port, connA, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const fwd = agent().sent.map((s) => JSON.parse(s) as Msg).filter((o) => o.method === "initialize");
  assert.equal(fwd.length, 1, "the first initialize is forwarded to the shared agent");
  const gotA = nextFrame(a, (o) => o.id === 1 && !!o.result);
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: fwd[0].id as number,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  })));
  await withTimeout(gotA, 1000, "the first client never got its initialize result");

  // A reconnecting / second-tab client initializes again.
  const b = sse(port);
  const connB = await b.conn;
  const gotB = nextFrame(b, (o) => o.id === 99 && !!o.result);
  await post(port, connB, { jsonrpc: "2.0", id: 99, method: "initialize", params: { protocolVersion: 1 } });
  const reply = await withTimeout(gotB, 1000, "the second initialize was not answered from cache");
  assert.deepEqual((reply.result as Msg).agentCapabilities, { loadSession: true });
  assert.equal(
    agent().sent.map((s) => JSON.parse(s) as Msg).filter((o) => o.method === "initialize").length,
    1,
    "the second initialize must NOT reach the agent",
  );

  a.close();
  b.close();
  await close();
});

test("initialize requests that race the first handshake are all answered once it lands", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const connA = await a.conn;
  const b = sse(port);
  const connB = await b.conn;

  // Both initialize before the agent has answered the first — only one is forwarded.
  await post(port, connA, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await post(port, connB, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } });
  const fwd = agent().sent.map((s) => JSON.parse(s) as Msg).filter((o) => o.method === "initialize");
  assert.equal(fwd.length, 1, "only one initialize reaches the agent while the rest park");

  const gotA = nextFrame(a, (o) => o.id === 1 && !!o.result);
  const gotB = nextFrame(b, (o) => o.id === 2 && !!o.result);
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: fwd[0].id as number,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  })));
  // The forwarded one is answered via idmux, the parked one from the cache flush.
  await withTimeout(Promise.all([gotA, gotB]), 1000, "a racing initialize was left unanswered");

  a.close();
  b.close();
  await close();
});

test("notification broadcasts to all connected devices", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  // Wait for both connections to open
  await Promise.all([a.conn, b.conn]);

  const gotA = nextFrame(a, (o) => o.method === "session/update");
  const gotB = nextFrame(b, (o) => o.method === "session/update");

  agent().emit(
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "S", update: {} },
      }),
    ),
  );

  const [rA, rB] = await Promise.all([gotA, gotB]);
  assert.equal((rA.params as { sessionId: string }).sessionId, "S");
  assert.equal((rB.params as { sessionId: string }).sessionId, "S");

  a.close();
  b.close();
  await close();
});

test("response routes only to the originating device, id rewritten back", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const ca = await a.conn;
  const cb = await b.conn;

  // Both clients send a request with the same client id=1.
  // The gateway must rewrite each to a distinct gateway-level id.
  await post(port, ca, {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { sessionId: "S" },
  });
  await post(port, cb, {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { sessionId: "S" },
  });

  // agent saw two requests, each with a DISTINCT rewritten gateway id
  const fwded = agent()
    .sent.map((s) => JSON.parse(s) as Msg)
    .filter((o) => o.method === "session/prompt");
  assert.equal(fwded.length, 2, "gateway should forward both requests");
  const [idA, idB] = [fwded[0].id as number, fwded[1].id as number];
  assert.notEqual(idA, idB, "gateway ids must be distinct even though both clients used id=1");

  // agent responds to idA (the gateway id for A's request)
  // only A should get it back, with the original client id=1
  const gotA = nextFrame(a, (o) => o.id === 1 && o.result != null);
  agent().emit(
    Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: idA, result: { ok: true } }),
    ),
  );

  await gotA;
  await new Promise((r) => setTimeout(r, 40));

  const bGotResponse = b.frames.some((e) => {
    try {
      const o = parseFrame(e.data);
      return o.method == null && o.result != null;
    } catch {
      return false;
    }
  });
  assert.equal(bGotResponse, false, "B should not have received the response meant for A");

  a.close();
  b.close();
  await close();
});

test("a client's prompt is mirrored to other viewers as a user_message_chunk", async () => {
  const { port, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const ca = await a.conn;
  const cb = await b.conn;

  // B subscribes to session S by sending its own prompt (a prompt subscribes the
  // sender as a viewer). A is not yet a viewer, so B's prompt mirrors to nobody.
  await post(port, cb, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "from B" }] } });

  // When A prompts, B (a viewer) should receive a synthesized user_message_chunk.
  const mirrored = nextFrame(b, (o) => {
    const up = (o.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })?.update;
    return o.method === "session/update" && up?.sessionUpdate === "user_message_chunk" && up?.content?.text === "hello from A";
  });
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "hello from A" }] } });

  const m = await mirrored;
  assert.equal((m.params as { sessionId: string }).sessionId, "S");
  await new Promise((r) => setTimeout(r, 30));

  // A must never receive its OWN prompt mirrored back.
  const aGotOwn = a.frames.some((e) => {
    try {
      const o = parseFrame(e.data);
      const up = (o.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })?.update;
      return o.method === "session/update" && up?.sessionUpdate === "user_message_chunk" && up?.content?.text === "hello from A";
    } catch {
      return false;
    }
  });
  assert.equal(aGotOwn, false, "the sender must not receive its own mirrored prompt");

  a.close();
  b.close();
  await close();
});

test("a prompted user bubble is replayed to reconnecting clients", async () => {
  const { port, close } = await makeTestServer();
  const b = sse(port);
  let replay: ReturnType<typeof sse> | null = null;
  try {
    const cb = await b.conn;

    await post(port, cb, {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "S", prompt: [{ type: "text", text: "from B while A was away" }] },
    });

    replay = sse(port, { lastEventId: "0" });
    await replay.conn;
    const mirrored = await withTimeout(replay.next((e) => {
      if (!e.data) return false;
      try {
        const o = parseFrame(e.data);
        const up = (o.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })?.update;
        return o.method === "session/update"
          && up?.sessionUpdate === "user_message_chunk"
          && up?.content?.text === "from B while A was away";
      } catch { return false; }
    }), 100, "timed out waiting for replayed user prompt");

    assert.ok(mirrored.id && mirrored.id > 0, "the replayed prompt should carry a ledger seq");
  } finally {
    b.close();
    replay?.close();
    await close();
  }
});

test("session/load replay is gated to the loader, then broadcast resumes", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const ca = await a.conn;
  const cb = await b.conn;

  // Count session/update frames for "S" received by each client.
  const countUpdates = (frames: Evt[]) => frames.filter((e) => {
    try {
      const o = parseFrame(e.data);
      return o.method === "session/update" && (o.params as { sessionId?: string })?.sessionId === "S";
    } catch {
      return false;
    }
  }).length;

  // B starts loading session S. The gateway forwards it with a rewritten id.
  await post(port, cb, { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId: "S" } });
  const fwd = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "session/load");
  const gatewayId = fwd!.id as number;

  const update = (text: string) => agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "S", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  })));

  // Replay arriving DURING the load must reach only the loader (B), not A.
  update("replay");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(countUpdates(b.frames), 1, "loader receives the replay");
  assert.equal(countUpdates(a.frames), 0, "other device must NOT receive replay during a load");

  // Load response returns → gate clears.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: gatewayId, result: {} })));
  await new Promise((r) => setTimeout(r, 30));

  // A live update now broadcasts to both.
  update("live");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(countUpdates(a.frames), 1, "after the load, broadcast resumes to the other device");
  assert.equal(countUpdates(b.frames), 2, "loader still receives live updates");

  a.close();
  b.close();
  await close();
});

test("permission goes to viewers; first reply wins, rest dropped", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const ca = await a.conn;
  const cb = await b.conn;

  // Subscribe both clients to session S by sending a session/prompt each
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });
  await post(port, cb, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });
  // Clear the sent log so we only capture the permission replies below
  agent().sent.length = 0;

  // Agent sends a permission request (agent→client request, id=99) to session S
  // Both A and B are viewers of S, so both should receive it
  const gotA = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  const gotB = nextFrame(b, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: { sessionId: "S" },
      }),
    ),
  );
  await Promise.all([gotA, gotB]); // both viewers got the permission prompt

  // Both reply — first-reply-wins: only A's reply should be forwarded to the agent
  await post(port, ca, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
  await post(port, cb, { jsonrpc: "2.0", id: 99, result: { outcome: "deny" } });

  const answers = agent()
    .sent.map((s) => JSON.parse(s) as Msg)
    .filter((o) => o.id === 99 && o.result != null);
  assert.equal(answers.length, 1, "only one reply should be forwarded (first-reply-wins)");
  assert.equal(
    (answers[0].result as { outcome: string }).outcome,
    "allow",
    "the first reply (A's allow) should win",
  );

  a.close();
  b.close();
  await close();
});

test("inbox: an answer broadcasts one durable resolution to every viewer", async () => {
  const { port, agent, inbox, answerInbox, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const ca = await a.conn;
  const cb = await b.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });
  await post(port, cb, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S" } });
  agent().sent.length = 0;

  const gotA = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  const gotB = nextFrame(b, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 99, method: "session/request_permission",
    params: { sessionId: "S", toolCall: { title: "Edit file" }, options: [{ optionId: "allow", name: "Allow" }] },
  })));
  await Promise.all([gotA, gotB]);

  const pending = inbox({ status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reqId, "99");
  assert.equal(pending[0].title, "Edit file");
  assert.equal(pending[0].sessionId, "S");

  // Answer from the server side (no client reply) — the gateway routes it to the
  // live agent, so any device can answer without holding that agent's connection.
  const resolvedA = withTimeout(
    nextFrame(a, (o) => o.method === "_gateway/prompt_resolved"),
    1000,
    "first viewer did not receive the inbox resolution",
  );
  const resolvedB = withTimeout(
    nextFrame(b, (o) => o.method === "_gateway/prompt_resolved"),
    1000,
    "second viewer did not receive the inbox resolution",
  );
  assert.equal(answerInbox("claude", "99", "allow"), true);
  const [resolutionA, resolutionB] = await Promise.all([resolvedA, resolvedB]);
  assert.deepEqual(resolutionA, {
    jsonrpc: "2.0",
    method: "_gateway/prompt_resolved",
    params: {
      sessionId: "S",
      requestId: 99,
      requestMethod: "session/request_permission",
    },
  });
  assert.deepEqual(resolutionB, resolutionA);

  const fwd = agent().sent.map((s) => JSON.parse(s) as Msg).filter((o) => o.id === 99 && o.result != null);
  assert.equal(fwd.length, 1, "the answer is forwarded once to the agent");
  assert.equal((fwd[0].result as { outcome: { optionId: string } }).outcome.optionId, "allow");
  assert.deepEqual(inbox({ status: "pending" }), []);
  assert.equal(inbox({ status: "answered" }).length, 1);

  // A second server-side answer is a no-op (first-reply-wins).
  assert.equal(answerInbox("claude", "99", "deny"), false);
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", marker: "after-duplicate-answer" },
  })));
  await Promise.all([
    nextFrame(a, (frame) => (frame.params as { marker?: string } | undefined)?.marker === "after-duplicate-answer"),
    nextFrame(b, (frame) => (frame.params as { marker?: string } | undefined)?.marker === "after-duplicate-answer"),
  ]);
  for (const client of [a, b]) {
    assert.equal(client.frames.filter((event) =>
      !!event.data && parseFrame(event.data).method === "_gateway/prompt_resolved").length, 1);
  }

  a.close();
  b.close();
  await close();
});

test("inbox: an HTTP append failure returns 500 and preserves a retryable prompt", async () => {
  const { port, agent, inbox, failNextLedgerAppend, close } = await makeTestServer();
  const a = sse(port);
  try {
    const ca = await a.conn;
    await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

    const got = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
    agent().emit(Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S", options: [] },
    })));
    await got;
    agent().sent.length = 0;

    const answerUrl = `http://127.0.0.1:${port}/inbox/answer?agent=claude&reqId=99&optionId=allow`;
    failNextLedgerAppend();
    const failed = await fetch(answerUrl, { method: "POST" });
    assert.equal(failed.status, 500);
    assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 1);
    assert.equal(fwdedReplies(agent().sent, 99), 0);

    const retried = await fetch(answerUrl, { method: "POST" });
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { ok: true });
    assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 0);
    assert.equal(fwdedReplies(agent().sent, 99), 1);
  } finally {
    a.close();
    await close();
  }
});

test("inbox: a failed resolution append keeps the prompt pending and retryable", async () => {
  const { port, agent, inbox, answerInbox, failNextLedgerAppend, close } = await makeTestServer();
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

  const got = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S", options: [] },
  })));
  await got;
  agent().sent.length = 0;
  assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 1);

  failNextLedgerAppend();
  assert.throws(
    () => answerInbox("claude", "99", "allow"),
    /injected ledger append failure/,
  );
  assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 1);
  assert.equal(
    agent().sent.map((line) => JSON.parse(line) as Msg)
      .filter((frame) => frame.id === 99 && "result" in frame).length,
    0,
  );

  assert.equal(answerInbox("claude", "99", "allow"), true);
  assert.equal(inbox({ status: "pending" }).filter((item) => item.reqId === "99").length, 0);

  a.close();
  await close();
});

test("inbox: a client reply resolves the prompt; an agent exit expires what's left", async () => {
  const { port, agent, inbox, close } = await makeTestServer();
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

  const got = nextFrame(a, (o) => o.id === 8 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 8, method: "session/request_permission", params: { sessionId: "S", options: [] },
  })));
  await got;
  await post(port, ca, { jsonrpc: "2.0", id: 8, result: { outcome: "allow" } });
  assert.equal(inbox({ status: "answered" }).length, 1);

  // A second prompt is still pending when the agent dies → it becomes expired
  // (the request it was blocking on is gone and can never be answered).
  const got2 = nextFrame(a, (o) => o.id === 9 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { sessionId: "S", options: [] },
  })));
  await got2;
  assert.equal(inbox({ status: "pending" }).length, 1);

  agent().exit();
  assert.deepEqual(inbox({ status: "pending" }), []);
  assert.equal(inbox({ status: "expired" }).length, 1);

  a.close();
  await close();
});

test("inbox: the gateway reuses an injected store (one SQLite connection) instead of opening its own", () => {
  // Production shares the single prefs `db()` connection by injecting it; the
  // gateway must read/write through that handle, not a second one on ledgerDir.
  const shared = new Db(":memory:");
  const gw = new Gateway(
    { claude: { cmd: "x", args: [], cwd: process.cwd() } } as unknown as Record<string, never>,
    fs.mkdtempSync(path.join(os.tmpdir(), "acpb-store-")),
    (_p, _cb, _onExit) => ({ send() {}, kill() {}, restart() {} }),
    () => shared,
  );
  assert.deepEqual(gw.inbox(), []);
  // A row written straight to the shared Db surfaces through the gateway → same handle.
  shared.addInboxItem({ type: "permission", agentName: "claude", reqId: "1", title: "x", createdAt: "t" });
  assert.deepEqual(gw.inbox().map((i) => i.reqId), ["1"]);
  shared.close();
});

test("recent sessions record turn traffic on a prompt, never on merely attaching", () => {
  // The conversation list's recency must not conflate "a client opened this" with
  // "someone talked to it" — that conflation is exactly why last_active_at can't
  // carry it, so the bump lives where the gateway pumps a turn.
  const shared = new Db(":memory:");
  const gw = new Gateway(
    { claude: { cmd: "x", args: [], cwd: process.cwd() } } as unknown as Record<string, never>,
    fs.mkdtempSync(path.join(os.tmpdir(), "acpb-store-")),
    (_p, _cb, _onExit) => ({ send() {}, kill() {}, restart() {} }),
    () => shared,
  );
  const ch = gw.channel("claude");
  const conn: Conn = { id: "c1", sink: { send() {}, sendUnsequenced() {}, close() {}, get alive() { return true; } } };

  ch.fromClient(conn, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "S1", cwd: "/repo" } })));
  assert.deepEqual([...shared.lastMessageAtBySession()], [], "attaching to a conversation is not turn traffic");

  ch.fromClient(conn, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "hello there" }] } })));
  assert.deepEqual([...shared.lastMessageAtBySession()].map(([sid]) => sid), ["S1"], "a prompt is");
  assert.deepEqual(shared.recentSessions().map((r) => [r.sessionId, r.cwd, r.title]), [["S1", "/repo", "hello there"]],
    "a session no client had recorded is created by its first prompt, under the cwd its load carried");
  shared.close();
});

function fwdedReplies(agentSent: string[], id: number): number {
  return agentSent.map((s) => JSON.parse(s) as Msg).filter((o) => o.id === id && o.result != null).length;
}

test("a running prompt shows as active, and clears when its response returns", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  assert.deepEqual(running(), [], "nothing running before any prompt");

  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  assert.deepEqual(running(), [{ agentName: "claude", sessionId: "S", state: "active", cwd: undefined, title: "go" }], "prompt in flight → active");

  // The gateway forwarded the prompt with a rewritten id; respond to it.
  const fwd = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "session/prompt");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fwd!.id, result: { stopReason: "end_turn" } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(running(), [], "response ended the turn → task cleared");

  a.close();
  await close();
});

test("running() keeps start order across interleaved heartbeats (the Recent Running section can't flap)", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  // Two turns start in order S1 then S2 → tasks tracked in that order.
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S1", prompt: [{ type: "text", text: "one" }] } });
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S2", prompt: [{ type: "text", text: "two" }] } });
  assert.deepEqual(running().map((t) => t.sessionId), ["S1", "S2"], "start order right after both prompts");

  // Interleaved streaming frames keep bumping S2 then S1 as most-recently-active.
  // running() must still report start order — the client renders the array verbatim,
  // so any reorder here is exactly the flapping this section exists to prevent.
  for (let i = 0; i < 3; i++) {
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } } } })));
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } } } })));
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(running().map((t) => t.sessionId), ["S1", "S2"], "heartbeats never reorder tasks to most-recently-active");

  a.close();
  await close();
});

test("a permission request flips the task to awaiting-input, then back to active", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });

  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(running(), [{ agentName: "claude", sessionId: "S", state: "awaiting-input", cwd: undefined, title: "go" }], "blocked on permission → awaiting-input");

  // awaiting-input never expires by TTL — a human may take any amount of time.
  assert.deepEqual(running(Date.now() + 10 * 60_000), [{ agentName: "claude", sessionId: "S", state: "awaiting-input", cwd: undefined, title: "go" }], "awaiting-input survives the TTL");

  // An agent frame while the prompt is STILL unanswered must not flip it back:
  // request_permission is always immediately followed by a usage_update for the
  // same session, so a heartbeat that pinned "active" undid awaiting-input one
  // frame later and handed the turn to the TTL (and then to the reaper).
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", update: { sessionUpdate: "usage_update", usage: {} } } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(running()[0]?.state, "awaiting-input", "a frame arriving while the prompt is unanswered stays awaiting-input");

  // Once the user answers AND the agent resumes (any frame for the session) it is
  // active again — the resume half of the heartbeat is unchanged.
  await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: { outcome: "selected", optionId: "yes" } } });
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(running(), [{ agentName: "claude", sessionId: "S", state: "active", cwd: undefined, title: "go" }], "answered + agent resumed → active");

  a.close();
  await close();
});

test("agent exit settles in-flight requests with an error and clears running tasks", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  // A prompt is in flight (forwarded to the agent, no response yet).
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  assert.equal(running().length, 1, "active right after the prompt");

  // The agent process dies before responding. The client should receive a
  // JSON-RPC error keyed to its ORIGINAL id (1) so its pending promise rejects
  // instead of hanging forever (issue #83).
  const errored = nextFrame(a, (o) => o.id === 1 && o.error != null);
  agent().exit();

  const f = await withTimeout(errored, 1000, "expected an error response on agent exit");
  assert.equal((f.error as { message?: string }).message, "agent exited before responding");

  // Server-side task state is cleared too — nothing left running.
  assert.deepEqual(running(), [], "agent exit clears the in-flight task");

  a.close();
  await close();
});

test("agent exit broadcasts _gateway/agent_restart to every connected client (and to the ledger, so a later reconnect replays it)", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const b = sse(port);
  const connA = await a.conn;
  const connB = await b.conn;

  // Both clients should see the notification — it is gateway-scoped, not per-conn.
  const sawA = nextFrame(a, (o) => o.method === "_gateway/agent_restart");
  const sawB = nextFrame(b, (o) => o.method === "_gateway/agent_restart");

  agent().exit();

  const [nA, nB] = await Promise.all([
    withTimeout(sawA, 1000, "client A should see _gateway/agent_restart"),
    withTimeout(sawB, 1000, "client B should see _gateway/agent_restart"),
  ]);
  assert.equal(nA.method, "_gateway/agent_restart");
  assert.equal(nB.method, "_gateway/agent_restart");
  // It is a JSON-RPC notification (no id, no result/error).
  assert.equal((nA as { id?: unknown }).id, undefined, "notification has no id");
  assert.equal((nA as { result?: unknown }).result, undefined, "notification has no result");
  assert.equal((nA as { error?: unknown }).error, undefined, "notification has no error");

  // And it must be appended to the ledger with a real seq, so a client that
  // disconnects at the moment of the exit and reconnects with Last-Event-ID
  // before the next respawn still sees the notification in the replay stream.
  // lastEventId:"0" requests a full replay from the head — that is the only way
  // to see frames that landed before this connection was opened.
  const replayer = sse(port, { lastEventId: "0" });
  const replayed = nextFrame(replayer, (o) => o.method === "_gateway/agent_restart");
  const r = await withTimeout(replayed, 1000, "reconnecting client should replay _gateway/agent_restart from the ledger");
  assert.equal(r.method, "_gateway/agent_restart");

  a.close();
  b.close();
  replayer.close();
  await close();
});

test("an active task whose response never arrives is reaped by the TTL", async () => {
  const { port, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  assert.equal(running().length, 1, "active right after the prompt");
  // Relative to the constant, not a wall-clock guess: TASK_TTL_MS is derived from
  // SESSION_IDLE_TTL_MS (and so moves with ACPG_SESSION_IDLE_TTL_MS), and a
  // hardcoded offset silently stops reaching it the moment either one changes.
  assert.deepEqual(running(Date.now() + TASK_TTL_MS + 1_000), [], "no heartbeat past the task TTL → it is pruned");

  a.close();
  await close();
});

test("running() reports the session's cwd, captured from session/new and session/load", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  // session/new carries the cwd but no sessionId yet — the gateway must pair the
  // cwd onto the session once the response assigns its id.
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/proj/new", mcpServers: [] } });
  const newReq = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "session/new");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: newReq!.id, result: { sessionId: "S-new" } })));
  await new Promise((r) => setTimeout(r, 20));

  // Prompt that session → it runs, and running() surfaces the captured cwd.
  await post(port, conn, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S-new", prompt: [{ type: "text", text: "go" }] } });
  assert.deepEqual(running(), [{ agentName: "claude", sessionId: "S-new", state: "active", cwd: "/proj/new", title: "go" }], "session/new cwd is paired on its response");

  // session/load carries both sessionId and cwd, so the cwd is captured immediately.
  await post(port, conn, { jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: "S-load", cwd: "/proj/load", mcpServers: [] } });
  await post(port, conn, { jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "S-load", prompt: [{ type: "text", text: "go" }] } });
  const loaded = running().find((t) => t.sessionId === "S-load");
  assert.equal(loaded?.cwd, "/proj/load", "session/load cwd is captured directly");

  a.close();
  await close();
});

test("a session/load replay does not register as a running task", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  // Load (not prompt) a session, then have the agent replay history for it.
  await post(port, conn, { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId: "S" } });
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(running(), [], "loading history is not a running task");

  a.close();
  await close();
});

test("a permission request for an untracked session does not conjure a running task", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  await a.conn;

  // No prompt was ever sent for "Z", so there is no in-flight task. A stray /
  // duplicate permission for it must not create a (TTL-immune) awaiting-input task
  // that would then linger in /running forever.
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "Z" } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(running(), [], "an untracked permission must not register a running task");
  // Even far past the active TTL, nothing should have appeared.
  assert.deepEqual(running(Date.now() + 10 * 60_000), [], "still nothing — no phantom awaiting-input leaked");

  a.close();
  await close();
});

test("a client session/cancel clears the session's running task immediately", async () => {
  const { port, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  assert.equal(running().length, 1, "active right after the prompt");

  // The user stops the turn. The agent may never send a terminating response (or
  // its origin was forgotten when the originating client dropped), so the cancel
  // itself must end the task — not a response we can't count on.
  await post(port, conn, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S" } });
  assert.deepEqual(running(), [], "cancel ended the turn → task cleared");

  a.close();
  await close();
});

test("a client session/cancel clears a TTL-immune awaiting-input task", async () => {
  const { port, agent, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(running()[0]?.state, "awaiting-input", "blocked on permission → awaiting-input");

  // awaiting-input is TTL-immune, so without cancel it would linger forever (e.g.
  // a Codex reply forks a fresh session and abandons this one). Cancel clears it.
  await post(port, conn, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S" } });
  assert.deepEqual(running(), [], "cancel cleared the abandoned awaiting-input task");
  assert.deepEqual(running(Date.now() + 10 * 60_000), [], "and it stays gone");

  a.close();
  await close();
});

test("running() surfaces the first prompt's text as the task title", async () => {
  const { port, running, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;

  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "Fix the bug in products" }] } });
  assert.equal(running()[0]?.title, "Fix the bug in products", "first prompt text labels the task");

  a.close();
  await close();
});

test("a reused permission request id is answerable again (gate resets per request)", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const conn = await a.conn;
  await post(port, conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });

  // Round 1: agent asks permission id=99; A answers; reply forwarded.
  let got = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await got;
  agent().sent.length = 0;
  await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
  assert.equal(fwdedReplies(agent().sent, 99), 1, "round 1 reply forwarded");

  // Round 2: agent REUSES id=99. The gate must have reset, so A's reply is
  // forwarded again (not silently dropped/wedged).
  got = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await got;
  agent().sent.length = 0;
  await post(port, conn, { jsonrpc: "2.0", id: 99, result: { outcome: "deny" } });
  assert.equal(fwdedReplies(agent().sent, 99), 1, "round 2 reply forwarded too — id reuse must not wedge");

  a.close();
  await close();
});

test("an outstanding permission is re-delivered when a client reloads the session", async () => {
  const { port, agent, close } = await makeTestServer();

  // A prompts S (subscribes + starts the task), then the agent asks permission.
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  const gotA = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await gotA;

  // A drops before answering — the agent is still blocked on the prompt.
  a.close();
  await new Promise((r) => setTimeout(r, 20));

  // B reconnects (live, like the web client) and reloads S. The gateway
  // re-delivers the outstanding prompt once the load response returns.
  const b = sse(port);
  const cb = await b.conn;
  const gotB = nextFrame(b, (o) => o.id === 99 && o.method === "session/request_permission");
  await post(port, cb, { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId: "S" } });
  const loadReq = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "session/load");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: loadReq!.id, result: { sessionId: "S" } })));
  await gotB; // re-delivered to the reconnected client

  // And it is still answerable — the gate survived the reconnect.
  agent().sent.length = 0;
  await post(port, cb, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
  assert.equal(fwdedReplies(agent().sent, 99), 1, "the reconnected client's answer reaches the agent");

  b.close();
  await close();
});

test("an answered permission is not re-delivered on reload", async () => {
  const { port, agent, close } = await makeTestServer();
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  const gotA = nextFrame(a, (o) => o.id === 99 && o.method === "session/request_permission");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "S" } })));
  await gotA;
  // A answers it, then drops — there is nothing outstanding anymore.
  await post(port, ca, { jsonrpc: "2.0", id: 99, result: { outcome: "allow" } });
  a.close();
  await new Promise((r) => setTimeout(r, 20));

  // B reloads S; the gateway must NOT replay the already-answered prompt.
  const b = sse(port);
  const cb = await b.conn;
  await post(port, cb, { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId: "S" } });
  const loadReq = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "session/load");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: loadReq!.id, result: { sessionId: "S" } })));
  await new Promise((r) => setTimeout(r, 40));
  const replayed = b.frames.some((e) => {
    try { const o = parseFrame(e.data); return o.id === 99 && o.method === "session/request_permission"; } catch { return false; }
  });
  assert.equal(replayed, false, "an answered permission must not be replayed");

  b.close();
  await close();
});

test("an outstanding elicitation (agent question) is re-delivered on reload and answerable", async () => {
  const { port, agent, inbox, close } = await makeTestServer();

  // A prompts S, then the agent asks a question via elicitation/create (this is
  // how claude-agent-acp surfaces AskUserQuestion).
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S", prompt: [{ type: "text", text: "go" }] } });
  const gotA = nextFrame(a, (o) => o.id === 42 && o.method === "elicitation/create");
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 42, method: "elicitation/create",
    params: { sessionId: "S", mode: "form", message: "Which approach?", requestedSchema: { type: "object", properties: {} } },
  })));
  await gotA;

  // Mirrored into the durable inbox as a question (no one-tap options).
  const pending = inbox({ status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, "elicitation");
  assert.equal(pending[0].title, "Which approach?");

  // A drops before answering; B reconnects and reloads S — the question must
  // re-deliver exactly like a permission prompt.
  a.close();
  await new Promise((r) => setTimeout(r, 20));
  const b = sse(port);
  const cb = await b.conn;
  const gotB = nextFrame(b, (o) => o.id === 42 && o.method === "elicitation/create");
  await post(port, cb, { jsonrpc: "2.0", id: 5, method: "session/load", params: { sessionId: "S" } });
  const loadReq = agent().sent.map((s) => JSON.parse(s) as Msg).find((o) => o.method === "session/load");
  agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: loadReq!.id, result: { sessionId: "S" } })));
  await gotB;

  // And B's form answer reaches the agent through the same first-reply-wins gate.
  agent().sent.length = 0;
  const resolved = withTimeout(
    nextFrame(b, (o) => o.method === "_gateway/prompt_resolved"),
    1000,
    "the elicitation viewer did not receive the prompt resolution",
  );
  await post(port, cb, { jsonrpc: "2.0", id: 42, result: { action: "accept", content: { question_0: "Option A" } } });
  assert.deepEqual(await resolved, {
    jsonrpc: "2.0",
    method: "_gateway/prompt_resolved",
    params: {
      sessionId: "S",
      requestId: 42,
      requestMethod: "elicitation/create",
    },
  });
  assert.equal(fwdedReplies(agent().sent, 42), 1, "the elicitation answer reaches the agent");
  assert.equal(inbox({ status: "pending" }).length, 0, "the inbox entry resolves with the answer");

  b.close();
  await close();
});

test("the server-side option-answer route refuses an elicitation (it needs the form, not an optionId)", async () => {
  const { port, agent, answerInbox, close } = await makeTestServer();
  const a = sse(port);
  const ca = await a.conn;
  await post(port, ca, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "S" } });
  const got = nextFrame(a, (o) => o.id === 7 && o.method === "elicitation/create");
  agent().emit(Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: 7, method: "elicitation/create",
    params: { sessionId: "S", mode: "form", message: "Pick one", requestedSchema: { type: "object", properties: {} } },
  })));
  await got;

  agent().sent.length = 0;
  // An optionId-shaped reply would deserialize as action "cancel" and abort the
  // agent's tool call — the route must refuse instead of answering wrong.
  assert.equal(answerInbox("claude", "7", "allow"), false);
  assert.equal(fwdedReplies(agent().sent, 7), 0, "no bogus reply is sent to the agent");
  // The question is still answerable by a client rendering the form.
  await post(port, ca, { jsonrpc: "2.0", id: 7, result: { action: "decline" } });
  assert.equal(fwdedReplies(agent().sent, 7), 1);

  a.close();
  await close();
});

test("a reconnecting client resumes from its cursor, replaying only newer frames", async () => {
  const { port, agent, close } = await makeTestServer();
  // No live client needed: the channel is pre-created, so the agent can emit 3
  // notifications straight into the ledger, which stamps them seq 1, 2, 3.
  for (let n = 1; n <= 3; n++) {
    agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", n } })));
  }

  // Resume from seq 2 → only seq 3 (n=3) replays on attach.
  const mid = sse(port, { lastEventId: "2" });
  await mid.conn;
  const firstMid = await mid.next((e) => { if (!e.data) return false; try { return (parseFrame(e.data) as Msg).method === "session/update"; } catch { return false; } });
  assert.equal((parseFrame(firstMid.data).params as { n?: number }).n, 3, "cursor=2 must replay only the frame after seq 2");
  assert.ok((firstMid.id ?? 0) > 2, "the replayed event's seq must be greater than the cursor");

  // Resume from 0 → full replay, starting at seq 1 (n=1).
  const full = sse(port, { lastEventId: "0" });
  await full.conn;
  const firstFull = await full.next((e) => { if (!e.data) return false; try { return (parseFrame(e.data) as Msg).method === "session/update"; } catch { return false; } });
  assert.equal((parseFrame(firstFull.data).params as { n?: number }).n, 1, "cursor=0 must replay from the first frame");

  mid.close(); full.close();
  await close();
});

test("a cursor below the retained ledger floor asks for reload without replaying the partial tail", async () => {
  const prev = process.env.ACPG_LEDGER_MAX_FRAMES;
  process.env.ACPG_LEDGER_MAX_FRAMES = "2";
  const { port, agent, close } = await makeTestServer();
  let c: ReturnType<typeof sse> | null = null;
  try {
    for (let n = 1; n <= 5; n++) {
      agent().emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S", n } })));
    }

    c = sse(port, { lastEventId: "1" });
    await c.conn;
    await new Promise((r) => setTimeout(r, 40));

    const parsed = c.frames.map((e) => parseFrame(e.data));
    assert.equal(parsed[0]?.method, "_gateway/reload");
    assert.equal(parsed.some((o) => o.method === "session/update"), false, "partial retained tail should not replay after reload");
  } finally {
    c?.close();
    if (prev === undefined) delete process.env.ACPG_LEDGER_MAX_FRAMES;
    else process.env.ACPG_LEDGER_MAX_FRAMES = prev;
    await close();
  }
});

test("/history/search requires auth", async () => {
  const { base, close } = await startHttpServer();
  try {
    const res = await fetch(base + "/history/search?q=needle");
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("/history/search rejects a query shorter than two characters", async () => {
  const { authed, close } = await startHttpServer();
  try {
    const res = await authed("/history/search?q=a");
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("/history/search rejects a cwd outside FS_ROOT", async () => {
  const { authed, close } = await startHttpServer();
  try {
    const res = await authed("/history/search?q=needle&cwd=" + encodeURIComponent("/definitely/not/under/root"));
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("/history/search answers with the search envelope", async () => {
  const { authed, close } = await startHttpServer();
  try {
    const res = await authed("/history/search?q=needle&all=1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.results));
    assert.equal(typeof body.truncated, "boolean");
    assert.ok(Array.isArray(body.skipped));
    assert.equal(typeof body.scanned.ms, "number");
  } finally {
    await close();
  }
});

// The three tests below lock in the security properties the route is solely
// responsible for (search-core.ts and searchTranscripts have no way to enforce
// them — see the route's own comments in gateway.ts). Without these, a future
// edit could add e.g. `fsRoot: q.get("fsRoot") ?? undefined` to the options
// object passed to searchTranscripts and nothing would fail: SearchScope's
// fields are all optional, so it would compile cleanly. Each assertion is
// designed to FAIL if the query-string parameter were honoured, not just to
// exercise the parameter and check for 200 — see the fixture comments for why.

// What makes the three hermetic, and why none of it can live in this file:
//   - agents: `npm test` sets ACPG_AGENTS_FILE=agents.test.json, which defines
//     exactly `claude` and `codex`. cfg.agents is built at import, so a test
//     cannot set this itself — and without it, ?agent=codex resolves to nothing
//     on a host whose own agents.json lacks that key, which would make the two
//     NOT-FOUND assertions below pass for the wrong reason.
//   - stores: `npm test` also points CLAUDE_CONFIG_DIR and CODEX_HOME at
//     throwaway dirs. CLAUDE_DIR is a module-scope const fixed at import, so the
//     shell is the only reach; codexHome() re-reads its env per call, so a test
//     may additionally swap CODEX_HOME for a fixture of its own.
// The fixture cwds still live under the real homedir: FS_ROOT defaults there and
// a candidate outside it is dropped before its file is ever opened, which is the
// property half of these tests exist to prove.

// Codex is the fast lever for fsRoot: CODEX_HOME re-read per call means this
// test can point stage A at a rollout it wrote itself. ?agent=codex additionally
// excludes the claude provider, so stage A never walks a claude store at all.
test("/history/search ignores a ?fsRoot= override: a codex fixture outside the real FS_ROOT stays excluded", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-fsroot-"));
  // A cwd outside the real FS_ROOT (which defaults to the real homedir) — same
  // shape as history.test.ts's own "outside" fixtures.
  const outCwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-outcwd-"));
  const needle = "cdxfsrootneedle" + Date.now();
  const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "20");
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(path.join(rolloutDir, "rollout-EVIL.jsonl"), [
    { type: "session_meta", payload: { id: "CDX-EVIL", cwd: outCwd, timestamp: "2026-07-20T10:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: needle }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { authed, close } = await startHttpServer();
  try {
    // ?fsRoot= names the fixture's OWN out-of-bounds cwd as the root. If the
    // route ever threaded this into searchCandidates's fsRoot option, the
    // fixture would sit exactly ON its root and pass the guard trivially —
    // this is what makes "not found" a real proof, not a vacuous one.
    const res = await authed(`/history/search?q=${needle}&all=1&agent=codex&fsRoot=${encodeURIComponent(outCwd)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      (body.results as Array<{ sessionId: string }>).some((r) => r.sessionId === "CDX-EVIL"),
      false,
      "a query-string fsRoot must never widen the real FS_ROOT guard",
    );
  } finally {
    await close();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(outCwd, { recursive: true, force: true });
  }
});

// The claude store the gateway really reads, for the pair of tests below. It is
// the throwaway CLAUDE_CONFIG_DIR `npm test` created: CLAUDE_DIR is fixed at
// import, so this is the only reach — and refusing to run without it is what
// stops these fixtures from being written into a developer's real ~/.claude.
function fixtureClaudeProjectsRoot(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  assert.ok(dir, "CLAUDE_CONFIG_DIR must point at a throwaway claude store — run this suite via `npm test`");
  assert.notEqual(path.resolve(dir), path.join(os.homedir(), ".claude"), "refusing to write fixtures into the real ~/.claude");
  const root = path.join(dir, "projects");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// One claude transcript, in the claude JSONL shape stage C parses.
function writeClaudeFixture(projectsRoot: string, project: string, sessionId: string, cwd: string, text: string) {
  const dir = path.join(projectsRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", cwd, sessionId, message: { role: "user", content: text } }) + "\n");
}

// The positive control for the claude arm — the sibling the ?projectsRoot= test
// below had none of. Without it, "not found" there would pass just as happily
// against a claude provider that never ran, or a fixture shape stage C cannot
// parse. Asserting the SAME fixture shape IS found from the real projects root
// is what makes the next test's silence mean something.
test("/history/search finds a claude fixture sitting in the projects root it actually reads", async () => {
  const fixtureCwd = fs.mkdtempSync(path.join(os.homedir(), ".acpg-search-test-"));
  const needle = "clzfoundneedle" + Date.now();
  writeClaudeFixture(fixtureClaudeProjectsRoot(), "-real-project", "SESSION-FOUND", fixtureCwd, needle);

  const { authed, close } = await startHttpServer();
  try {
    const res = await authed(`/history/search?q=${needle}&all=1&agent=claude`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      (body.results as Array<{ sessionId: string }>).some((r) => r.sessionId === "SESSION-FOUND"),
      true,
      "the claude provider must be configured and reading CLAUDE_DIR/projects, or the ?projectsRoot= test below proves nothing",
    );
  } finally {
    await close();
    fs.rmSync(path.join(fixtureClaudeProjectsRoot(), "-real-project"), { recursive: true, force: true });
    fs.rmSync(fixtureCwd, { recursive: true, force: true });
  }
});

// The negative half of the pair: the SAME fixture shape the test above proves is
// findable, this time reachable only through ?projectsRoot=. Its absence from
// the results can therefore mean one thing only — the query string did not move
// stage A off the projects root the gateway resolves for itself.
test("/history/search ignores a ?projectsRoot= override: a claude fixture under a fake root is not found", async () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-projroot-"));
  // Must resolve within the real FS_ROOT (defaults to the real homedir) so that,
  // if projectsRoot WERE honoured, nothing else would still filter it out —
  // otherwise "not found" would prove nothing.
  const fixtureCwd = fs.mkdtempSync(path.join(os.homedir(), ".acpg-search-test-"));
  const needle = "clzprojrootneedle" + Date.now();
  writeClaudeFixture(fakeRoot, "-fake-project", "SESSION-EVIL", fixtureCwd, needle);

  const { authed, close } = await startHttpServer();
  try {
    const res = await authed(`/history/search?q=${needle}&all=1&agent=claude&projectsRoot=${encodeURIComponent(fakeRoot)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      (body.results as Array<{ sessionId: string }>).some((r) => r.sessionId === "SESSION-EVIL"),
      false,
      "a query-string projectsRoot must never redirect stage A away from the projects root the gateway resolved for itself",
    );
  } finally {
    await close();
    fs.rmSync(fakeRoot, { recursive: true, force: true });
    fs.rmSync(fixtureCwd, { recursive: true, force: true });
  }
});

// budgetMs=0 is fully deterministic: searchTranscripts's loop
// (src/gateway.ts ~line 1346) breaks on `clock() - startedAt >= budgetMs`,
// which is true on the very first check when budgetMs is 0 — no dependence on
// machine speed or fixture count. That determinism is what makes this a real
// positive control rather than a pin one layer removed from the route: a
// codex fixture that legitimately matches (cwd inside the real FS_ROOT, unlike
// the fsRoot test's fixture above) is asserted FOUND. If a future edit threads
// `?budgetMs=` into the route's options literal, `budgetMs=0` would stop the
// scan before reading anything and the needle would vanish — this test would
// fail loudly. It also doubles as a well-formedness check on this fixture
// shape: if the JSONL were malformed, this test would fail too (unlike a
// "not found" assertion, which passes the same way whether the override was
// honoured or the fixture was simply broken).
// Limitation, disclosed rather than silently assumed away: a route written as
// `Number(q.get("budgetMs")) || undefined` would not be caught, since 0 is
// falsy and `||` would fall back to the 2000ms default — this test can only
// catch a `??`-style or explicit-presence passthrough. Still strictly
// stronger than pinning searchQueryParams alone (search-core.test.ts already
// has that pin), which cannot fail against a route that reads
// `q.get("budgetMs")` directly, bypassing searchQueryParams entirely.
test("/history/search finds a codex fixture even with ?budgetMs=0 — the query string cannot override SEARCH_BUDGET_MS", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-budget-"));
  // Inside the real FS_ROOT (unlike the fsRoot test's fixture) — this fixture
  // must legitimately match so "found" is a real assertion, not luck.
  const fixtureCwd = fs.mkdtempSync(path.join(os.homedir(), ".acpg-search-test-"));
  const needle = "cdxbudgetneedle" + Date.now();
  const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "20");
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(path.join(rolloutDir, "rollout-BUDGET.jsonl"), [
    { type: "session_meta", payload: { id: "CDX-BUDGET", cwd: fixtureCwd, timestamp: "2026-07-20T10:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: needle }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { authed, close } = await startHttpServer();
  try {
    const res = await authed(`/history/search?q=${needle}&all=1&agent=codex&budgetMs=0`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      (body.results as Array<{ sessionId: string }>).some((r) => r.sessionId === "CDX-BUDGET"),
      true,
      "?budgetMs=0 must not cut the scan short — SEARCH_BUDGET_MS (2000ms) is a server constant, not a query parameter",
    );
  } finally {
    await close();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(fixtureCwd, { recursive: true, force: true });
  }
});
