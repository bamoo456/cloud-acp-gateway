import { test } from "node:test";
import assert from "node:assert/strict";
import { OnceGate } from "./oncegate.ts";

test("a key can be claimed exactly once", () => {
  const g = new OnceGate();
  assert.equal(g.claim("p1"), true);
  assert.equal(g.claim("p1"), false);
  assert.equal(g.claim("p2"), true);
});

test("forget allows a key to be claimed again", () => {
  const g = new OnceGate();
  g.claim("p1");
  g.forget("p1");
  assert.equal(g.claim("p1"), true);
});
