import { describe, test, expect } from "vitest";
import { Acp, SseParser, sseFactory, type Sock, type SseEvent } from "./acp.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A controllable fake socket implementing the minimal Sock surface.
class FakeSock implements Sock {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(1000); }
  // test helpers
  open() { this.onopen?.(); }
  recv(o: unknown) { this.onmessage?.(JSON.stringify(o)); }
}

function make() {
  const sock = new FakeSock();
  const acp = new Acp("ws://x/acp", () => sock);
  acp.connect();
  sock.open();
  return { sock, acp };
}

describe("Acp transport", () => {
  test("request resolves on matching response and rewrites ids per call", async () => {
    const { sock, acp } = make();
    const p = acp.request("session/new", { cwd: "/x" });
    const sent = JSON.parse(sock.sent[0]);
    expect(sent.method).toBe("session/new");
    expect(sent.id).toBeGreaterThan(0);
    sock.recv({ jsonrpc: "2.0", id: sent.id, result: { sessionId: "S1" } });
    await expect(p).resolves.toEqual({ sessionId: "S1" });
  });

  test("request rejects on error response", async () => {
    const { sock, acp } = make();
    const p = acp.request("session/prompt", {});
    const id = JSON.parse(sock.sent[0]).id;
    sock.recv({ jsonrpc: "2.0", id, error: { code: -1, message: "boom" } });
    await expect(p).rejects.toMatchObject({ message: "boom" });
  });

  test("notifications go to onNotification, not request handlers", () => {
    const { sock, acp } = make();
    const seen: unknown[] = [];
    acp.onNotification((m) => seen.push(m));
    sock.recv({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S" } });
    expect(seen).toHaveLength(1);
  });

  test("agent->client requests go to onRequest with id", () => {
    const { sock, acp } = make();
    const seen: Array<{ id: unknown; method: string | undefined }> = [];
    acp.onRequest((m) => seen.push({ id: m.id, method: m.method }));
    sock.recv({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {} });
    expect(seen).toEqual([{ id: 99, method: "session/request_permission" }]);
  });

  test("respond / respondErr / notify emit well-formed frames", () => {
    const { sock, acp } = make();
    acp.respond(99, { ok: true });
    acp.respondErr(98, -32601, "nope");
    acp.notify("session/cancel", { sessionId: "S" });
    const frames = sock.sent.map((s) => JSON.parse(s));
    expect(frames[0]).toEqual({ jsonrpc: "2.0", id: 99, result: { ok: true } });
    expect(frames[1]).toEqual({ jsonrpc: "2.0", id: 98, error: { code: -32601, message: "nope" } });
    expect(frames[2]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S" } });
  });

  test("close rejects all pending with __disconnected", async () => {
    const { sock, acp } = make();
    const p = acp.request("session/prompt", {});
    sock.close();
    await expect(p).rejects.toMatchObject({ __disconnected: true });
  });

  test("needsReconnect tracks socket liveness", () => {
    const acp = new Acp("ws://x/acp", () => new FakeSock());
    expect(acp.needsReconnect()).toBe(true); // no socket yet
    const { sock, acp: live } = make();
    expect(live.needsReconnect()).toBe(false); // OPEN
    sock.readyState = 0; // CONNECTING — a reconnect is already in flight
    expect(live.needsReconnect()).toBe(false);
    sock.close(); // CLOSED
    expect(live.needsReconnect()).toBe(true);
  });
});

describe("SseParser", () => {
  test("parses id/event/data blocks, including across chunk boundaries", () => {
    const seen: SseEvent[] = [];
    const p = new SseParser((e) => seen.push(e));
    p.push('id:1\ndata:{"a":1}\n\n');
    p.push('event: ready\ndata:{"conn"'); // split mid-event
    p.push(':"c1"}\n\n');
    p.push(": ka\n\n"); // keepalive comment → empty-data message event
    expect(seen[0]).toEqual({ id: 1, event: "message", data: '{"a":1}' });
    expect(seen[1]).toEqual({ id: null, event: "ready", data: '{"conn":"c1"}' });
    expect(seen[2]).toEqual({ id: null, event: "message", data: "" });
  });

  test("emits multiple events from one chunk", () => {
    const seen: SseEvent[] = [];
    new SseParser((e) => seen.push(e)).push("id:1\ndata:a\n\nid:2\ndata:b\n\n");
    expect(seen.map((e) => [e.id, e.data])).toEqual([[1, "a"], [2, "b"]]);
  });
});

describe("Acp over SSE+POST", () => {
  // A controllable fake fetch: GET opens a stream the test drives via pushChunk /
  // endStream; POST records the call.
  function harness() {
    const sseUrls: string[] = [];
    const posts: Array<{ url: string; body: string }> = [];
    let push!: (s: string) => void;
    let end!: () => void;

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push({ url, body: String(init.body) }); return { ok: true, status: 202, body: null }; }
      sseUrls.push(url);
      const queue: Uint8Array[] = [];
      let pendingRead: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
      let done = false;
      push = (s) => {
        const v = new TextEncoder().encode(s);
        if (pendingRead) { pendingRead({ done: false, value: v }); pendingRead = null; } else queue.push(v);
      };
      end = () => { done = true; if (pendingRead) { pendingRead({ done: true }); pendingRead = null; } };
      const reader = {
        read: () => new Promise<{ done: boolean; value?: Uint8Array }>((res) => {
          if (queue.length) res({ done: false, value: queue.shift() });
          else if (done) res({ done: true });
          else pendingRead = res;
        }),
      };
      return { ok: true, status: 200, body: { getReader: () => reader } };
    }) as unknown as typeof fetch;

    const factory = sseFactory({
      sseUrl: (last) => `/sse?lastEventId=${last}`,
      rpcUrl: (conn) => `/rpc?conn=${conn}`,
      fetchImpl,
    });
    return { factory, sseUrls, posts, push: (s: string) => push(s), end: () => end() };
  }

  test("ready opens; frames notify; send POSTs to conn; reconnect resumes from lastSeq", async () => {
    const h = harness();
    const acp = new Acp("sse", h.factory);
    let status = "";
    const notes: unknown[] = [];
    acp.onStatus((s) => { status = s; });
    acp.onNotification((m) => notes.push(m));

    acp.connect();
    await tick();
    expect(h.sseUrls[0]).toBe("/sse?lastEventId=-1"); // first connect is fresh

    h.push('event: ready\ndata:{"conn":"c1"}\n\n');
    await tick();
    expect(status).toBe("connected");

    h.push('id:5\ndata:{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"S"}}\n\n');
    await tick();
    expect(notes).toHaveLength(1);

    acp.notify("session/cancel", { sessionId: "S" });
    await tick();
    expect(h.posts[0]).toEqual({ url: "/rpc?conn=c1", body: JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S" } }) });

    // stream drops → offline; a reconnect resumes after the highest seq seen (5)
    h.end();
    await tick();
    expect(status).toBe("offline");
    acp.connect();
    await tick();
    expect(h.sseUrls[1]).toBe("/sse?lastEventId=5");
  });

  test("external cursor seeds the resume position on a fresh factory", async () => {
    const stored = { v: 9 };
    const sseUrls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 202, body: null };
      sseUrls.push(url);
      const reader = { read: () => new Promise(() => {}) }; // never resolves; we only care about the URL
      return { ok: true, status: 200, body: { getReader: () => reader } };
    }) as unknown as typeof fetch;
    const factory = sseFactory(
      { sseUrl: (last) => `/sse?lastEventId=${last}`, rpcUrl: (c) => `/rpc?conn=${c}`, fetchImpl },
      { get: () => stored.v, set: (n) => { stored.v = n; } },
    );
    factory("sse");
    await tick();
    expect(sseUrls[0]).toBe("/sse?lastEventId=9");
  });
});
