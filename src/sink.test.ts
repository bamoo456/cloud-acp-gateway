import { test } from "node:test";
import assert from "node:assert/strict";
import { SseSink, type SseResponse } from "./sink.ts";

// A fake http response that records written chunks and lets the test fire "close".
function fakeRes(): SseResponse & { chunks: string[]; ended: boolean; fireClose: () => void } {
  let onClose: (() => void) | null = null;
  return {
    chunks: [],
    ended: false,
    writableEnded: false,
    write(chunk: string) { this.chunks.push(chunk); return true; },
    end() { this.ended = true; this.writableEnded = true; },
    on(_event: "close", cb: () => void) { onClose = cb; },
    fireClose() { onClose?.(); },
  };
}

test("SseSink emits one SSE event per frame with id:=seq", () => {
  const res = fakeRes();
  const sink = new SseSink(res);
  sink.send(7, Buffer.from('{"jsonrpc":"2.0","method":"session/update"}'));
  assert.deepEqual(res.chunks, ['id:7\ndata:{"jsonrpc":"2.0","method":"session/update"}\n\n']);
});

test("SseSink keepalive writes an SSE comment", () => {
  const res = fakeRes();
  new SseSink(res).keepalive();
  assert.deepEqual(res.chunks, [": ka\n\n"]);
});

test("SseSink stops writing once the connection closes", () => {
  const res = fakeRes();
  const sink = new SseSink(res);
  assert.equal(sink.alive, true);
  res.fireClose();
  assert.equal(sink.alive, false);
  sink.send(1, Buffer.from("x"));
  assert.equal(res.chunks.length, 0, "must not write after close");
});

test("SseSink treats a write throw as death (dead peer), not backpressure", () => {
  const res = fakeRes();
  res.write = () => { throw new Error("EPIPE"); };
  const sink = new SseSink(res);
  sink.send(1, Buffer.from("x"));
  assert.equal(sink.alive, false);
});

test("SseSink.close ends the response and marks not-alive", () => {
  const res = fakeRes();
  const sink = new SseSink(res);
  sink.close();
  assert.equal(res.ended, true);
  assert.equal(sink.alive, false);
});
