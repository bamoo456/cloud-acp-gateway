import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "./search-core.ts";
import { buildSnippet, SNIPPET_RADIUS } from "./search-core.ts";

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

test("buildSnippet collapses whitespace and marks every term occurrence", () => {
  const r = buildSnippet("the  Liquid\nglass chrome, liquid again", ["liquid", "glass"]);
  assert.equal(r?.snippet, "the Liquid glass chrome, liquid again");
  assert.deepEqual(r?.offsets, [[4, 10], [11, 16], [25, 31]]);
});

test("buildSnippet clips around the first occurrence and marks the clip", () => {
  const text = "x".repeat(SNIPPET_RADIUS * 2) + " needle " + "y".repeat(SNIPPET_RADIUS * 2);
  const r = buildSnippet(text, ["needle"]);
  assert.ok(r);
  assert.ok(r.snippet.startsWith("…"), "clipped at the head");
  assert.ok(r.snippet.endsWith("…"), "clipped at the tail");
  assert.ok(r.snippet.includes("needle"));
  const [start, end] = r.offsets[0];
  assert.equal(r.snippet.slice(start, end), "needle");
});

test("buildSnippet returns null when a term is absent", () => {
  assert.equal(buildSnippet("nothing here", ["absent"]), null);
});
