import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "./search-core.ts";
import { buildSnippet, SNIPPET_RADIUS } from "./search-core.ts";
import { findHits, MAX_HITS_PER_SESSION } from "./search-core.ts";
import type { ViewMessage } from "./gateway.ts";

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

const say = (role: "user" | "assistant", text: string): ViewMessage => ({ role, blocks: [{ type: "text", text }] });

test("findHits requires every term in the SAME message", () => {
  const msgs: ViewMessage[] = [say("user", "liquid only"), say("assistant", "glass only")];
  assert.equal(findHits(msgs, parseQuery("liquid glass")!).hitCount, 0);
  assert.equal(findHits([say("user", "liquid glass here")], parseQuery("liquid glass")!).hitCount, 1);
});

test("findHits matches case-insensitively and reports the message index", () => {
  const msgs: ViewMessage[] = [say("user", "unrelated"), say("assistant", "The Liquid Glass chrome")];
  const r = findHits(msgs, parseQuery("liquid glass")!);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].index, 1);
  assert.equal(r.hits[0].role, "assistant");
});

test("findHits ignores non-text blocks", () => {
  const msgs: ViewMessage[] = [
    { role: "assistant", blocks: [{ type: "thought", text: "needle in a thought" }] },
    { role: "assistant", blocks: [{ type: "tool", name: "Read", output: "needle in tool output" }] },
    { role: "user", blocks: [{ type: "tool_result", output: "needle in a result" }] },
  ];
  assert.equal(findHits(msgs, parseQuery("needle")!).hitCount, 0);
});

test("findHits filters by role", () => {
  const msgs: ViewMessage[] = [say("user", "needle"), say("assistant", "needle")];
  assert.equal(findHits(msgs, parseQuery("needle")!, { role: "user" }).hitCount, 1);
});

test("findHits caps returned hits but counts them all", () => {
  const msgs = Array.from({ length: MAX_HITS_PER_SESSION + 4 }, () => say("user", "needle"));
  const r = findHits(msgs, parseQuery("needle")!);
  assert.equal(r.hits.length, MAX_HITS_PER_SESSION);
  assert.equal(r.hitCount, MAX_HITS_PER_SESSION + 4);
});
