import { test } from "node:test";
import assert from "node:assert/strict";
import { Subscriptions } from "./subscriptions.ts";

test("tracks viewers per session and is idempotent", () => {
  const s = new Subscriptions();
  s.subscribe("c1", "A");
  s.subscribe("c2", "A");
  s.subscribe("c1", "A"); // dup
  assert.deepEqual(s.viewers("A").sort(), ["c1", "c2"]);
  assert.deepEqual(s.viewers("B"), []);
});

test("sessionsOf lists a connection's sessions", () => {
  const s = new Subscriptions();
  s.subscribe("c1", "A");
  s.subscribe("c1", "B");
  assert.deepEqual(s.sessionsOf("c1").sort(), ["A", "B"]);
});

test("remove drops a connection from all sessions", () => {
  const s = new Subscriptions();
  s.subscribe("c1", "A");
  s.subscribe("c2", "A");
  s.remove("c1");
  assert.deepEqual(s.viewers("A"), ["c2"]);
  assert.deepEqual(s.sessionsOf("c1"), []);
});
