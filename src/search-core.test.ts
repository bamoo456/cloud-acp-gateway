import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "./search-core.ts";
import { buildSnippet, SNIPPET_RADIUS } from "./search-core.ts";
import { findHits, MAX_HITS_PER_SESSION } from "./search-core.ts";
import { encodeCursor, decodeCursor, afterCursor } from "./search-core.ts";
import { searchQueryParams, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, DEFAULT_SINCE_DAYS } from "./search-core.ts";
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

test("cursor round-trips", () => {
  const c = { recencyMs: 1754037920000, sessionId: "511701f8-ba4d" };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
});

test("decodeCursor rejects garbage", () => {
  assert.equal(decodeCursor("not-base64-!!"), null);
  assert.equal(decodeCursor(Buffer.from("nope", "utf8").toString("base64url")), null);
  assert.equal(decodeCursor(Buffer.from("abc|s1", "utf8").toString("base64url")), null);
});

test("afterCursor breaks recency ties on sessionId so resume neither repeats nor skips", () => {
  const cur = { recencyMs: 1000, sessionId: "s-b" };
  assert.equal(afterCursor(cur, { recencyMs: 999, sessionId: "s-z" }), true);   // older
  assert.equal(afterCursor(cur, { recencyMs: 1001, sessionId: "s-a" }), false); // newer
  assert.equal(afterCursor(cur, { recencyMs: 1000, sessionId: "s-a" }), true);  // tie, sorts after
  assert.equal(afterCursor(cur, { recencyMs: 1000, sessionId: "s-b" }), false); // the cursor itself
  assert.equal(afterCursor(cur, { recencyMs: 1000, sessionId: "s-c" }), false); // tie, sorts before
});

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const params = (qs: string) => searchQueryParams(new URLSearchParams(qs), NOW);

test("searchQueryParams defaults to a 14-day window", () => {
  const p = params("q=liquid");
  assert.equal(p?.sinceMs, NOW - DEFAULT_SINCE_DAYS * 86400000);
  assert.equal(p?.untilMs, null);
  assert.equal(p?.limit, DEFAULT_SEARCH_LIMIT);
  assert.equal(p?.agents, null);
  assert.equal(p?.role, null);
});

test("searchQueryParams drops the window on all=1", () => {
  assert.equal(params("q=liquid&all=1")?.sinceMs, null);
});

test("searchQueryParams accepts ISO and epoch-ms instants", () => {
  assert.equal(params("q=liquid&since=2026-07-01T00:00:00Z")?.sinceMs, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(params("q=liquid&until=1754037920000")?.untilMs, 1754037920000);
});

test("searchQueryParams ignores an unparseable instant rather than inventing one", () => {
  assert.equal(params("q=liquid&until=yesterday")?.untilMs, null);
});

test("searchQueryParams clamps the limit and collects repeated agents", () => {
  assert.equal(params("q=liquid&limit=9999")?.limit, MAX_SEARCH_LIMIT);
  assert.equal(params("q=liquid&limit=0")?.limit, 1);
  assert.deepEqual(params("q=liquid&agent=claude&agent=codex")?.agents, ["claude", "codex"]);
});

test("searchQueryParams rejects a too-short query", () => {
  assert.equal(params("q=a"), null);
  assert.equal(params(""), null);
});

test("searchQueryParams ignores an unusable role and decodes the cursor", () => {
  assert.equal(params("q=liquid&role=robot")?.role, null);
  assert.equal(params("q=liquid&role=user")?.role, "user");
  assert.deepEqual(params("q=liquid&cursor=" + encodeCursor({ recencyMs: 5, sessionId: "s1" }))?.cursor,
    { recencyMs: 5, sessionId: "s1" });
});
