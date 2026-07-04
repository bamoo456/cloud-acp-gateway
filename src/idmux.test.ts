import { test } from "node:test";
import assert from "node:assert/strict";
import { IdMux } from "./idmux.ts";

test("allocates unique gateway ids and maps responses back to origin", () => {
  const m = new IdMux();
  const b1 = m.outbound("connA", 1, "session/prompt", "S");
  const b2 = m.outbound("connB", 1, "session/new", undefined, "/proj");
  assert.notEqual(b1, b2); // both clients used id 1, no collision

  const o1 = m.inbound(b1);
  assert.deepEqual(o1, { connId: "connA", clientId: 1, method: "session/prompt", sessionId: "S", cwd: undefined });

  // session/new has no sessionId yet — its cwd rides along to be paired on response.
  const o2 = m.inbound(b2);
  assert.deepEqual(o2, { connId: "connB", clientId: 1, method: "session/new", sessionId: undefined, cwd: "/proj" });
});

test("inbound returns null for unknown/used ids and consumes the mapping", () => {
  const m = new IdMux();
  const b = m.outbound("c", 5, "x");
  assert.ok(m.inbound(b));
  assert.equal(m.inbound(b), null); // consumed
  assert.equal(m.inbound(9999), null);
});

test("forgetConn drops all of a connection's pending ids", () => {
  const m = new IdMux();
  const b = m.outbound("gone", 1, "x");
  m.forgetConn("gone");
  assert.equal(m.inbound(b), null);
});

test("drain returns every outstanding origin and empties the map", () => {
  const m = new IdMux();
  const b1 = m.outbound("connA", 1, "session/prompt", "S");
  const b2 = m.outbound("connB", 7, "session/load", "T");

  const drained = m.drain();
  assert.deepEqual(drained, [
    { connId: "connA", clientId: 1, method: "session/prompt", sessionId: "S", cwd: undefined },
    { connId: "connB", clientId: 7, method: "session/load", sessionId: "T", cwd: undefined },
  ]);
  // Drained mappings are gone — a late response finds nothing.
  assert.equal(m.inbound(b1), null);
  assert.equal(m.inbound(b2), null);
  assert.deepEqual(m.drain(), []);
});
