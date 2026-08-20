import { describe, test, expect } from "vitest";
import { threadHits } from "./findInThread.ts";
import type { ThreadItem } from "../types.ts";

const items: ThreadItem[] = [
  { id: "m0", kind: "user", text: "where is the cache cleared?" },
  { id: "m1", kind: "thought", text: "the cache is in store.ts" },
  { id: "m2", kind: "assistant", text: "The cache is flushed on reload; cache size is 8." },
  { id: "m3", kind: "tool", toolCallId: "t1", title: "Read cache.ts", toolKind: "read", status: "completed", locations: [], content: [] },
  { id: "m4", kind: "user", text: "and the CACHE key?" },
];

describe("threadHits", () => {
  test("counts every occurrence, case-insensitively, in user and assistant text", () => {
    const hits = threadHits(items, "cache");
    // m0 ×1, m2 ×2, m4 ×1 — and nothing from the thought or the tool card.
    expect(hits.map((h) => [h.itemId, h.nth])).toEqual([
      ["m0", 0], ["m2", 0], ["m2", 1], ["m4", 0],
    ]);
  });

  test("points a reply's hit at the start of its turn, so the right turn unfolds", () => {
    // m2's run starts at the thought (m1): that is the item Thread keys the
    // folded turn on, and the one the window has to reveal.
    expect(threadHits(items, "flushed")[0]).toMatchObject({ itemIndex: 2, turnStart: 1 });
    // A user message is its own start — it is not part of any turn.
    expect(threadHits(items, "where")[0]).toMatchObject({ itemIndex: 0, turnStart: 0 });
  });

  test("an empty or whitespace query matches nothing", () => {
    expect(threadHits(items, "")).toEqual([]);
    expect(threadHits(items, "   ")).toEqual([]);
  });

  test("treats the query as literal text, not a pattern", () => {
    const dotted: ThreadItem[] = [{ id: "a", kind: "user", text: "store.ts and storexts" }];
    expect(threadHits(dotted, "store.ts")).toHaveLength(1);
  });
});
