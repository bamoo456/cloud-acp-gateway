// Find-in-conversation, over the STORE rather than the DOM.
//
// The thread renders neither everything nor all of what it renders: only the
// last window of items is mounted (Thread.tsx's `visible`), and only one agent
// turn is unfolded at a time. So a DOM walk — what findInFile does for a file —
// would miss most of the conversation. Matching happens here, against the text
// the store holds; the DOM is only asked to paint a hit once the thread has
// revealed and unfolded it.
//
// Thoughts and tool output are deliberately out of scope: a thought sits in a
// closed <details> that nothing would scroll to, and tool arguments/output
// dominate a transcript by volume and drown real hits — the same exclusion the
// gateway's own search makes (search-core.ts, searchableText).

import type { ThreadItem } from "../types.ts";
import { matchOffsets } from "./findInFile.ts";

export const THREAD_HIGHLIGHT = "th-find";

export type ThreadHit = {
  itemIndex: number;
  itemId: string;
  // Which occurrence within that item — an item can match many times, and the
  // counter steps occurrences, not messages.
  nth: number;
  // First item of the agent run this hit belongs to. Thread.tsx folds a run of
  // thought/assistant items into one turn keyed on that item's id, so this is
  // both what has to be revealed and what has to be unfolded.
  turnStart: number;
};

function isTurnPart(it: ThreadItem): boolean {
  return it.kind === "thought" || it.kind === "assistant";
}

export function threadHits(items: ThreadItem[], query: string): ThreadHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: ThreadHit[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "user" && it.kind !== "assistant") continue;
    const n = matchOffsets(it.text ?? "", q).length;
    if (!n) continue;
    let start = i;
    while (start > 0 && isTurnPart(items[start]) && isTurnPart(items[start - 1])) start--;
    for (let nth = 0; nth < n; nth++) hits.push({ itemIndex: i, itemId: it.id, nth, turnStart: start });
  }
  return hits;
}
