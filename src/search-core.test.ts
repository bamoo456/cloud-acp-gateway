import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "./search-core.ts";

test("parseQuery lowercases and splits on whitespace", () => {
  assert.deepEqual(parseQuery("  Liquid   Glass "), { terms: ["liquid", "glass"], probe: "liquid" });
});

test("parseQuery rejects a query shorter than the minimum", () => {
  assert.equal(parseQuery("a"), null);
  assert.equal(parseQuery("   "), null);
});

test("parseQuery picks the longest term as the probe", () => {
  assert.equal(parseQuery("in gateway of")?.probe, "gateway");
});

test("parseQuery skips probe terms containing JSON-escaped characters", () => {
  // `"` and `\` are escaped inside JSONL, so they never appear literally in the
  // file bytes — probing on them would produce false negatives.
  assert.equal(parseQuery('say "hi" loudly')?.probe, "loudly");
  assert.equal(parseQuery('"\\"')?.probe, null);
});
