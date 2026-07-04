import type { MessageFile } from "../types.ts";

export interface Mention { start: number; query: string; }

// The "@ file" token whose end sits at the caret, or null. A mention is a run of
// non-whitespace beginning with "@", anchored at start-of-text or after whitespace
// (so an email like a@b doesn't trigger it). `query` is the text after the "@".
export function activeMention(value: string, caret: number): Mention | null {
  if (caret < 0 || caret > value.length) return null;
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(value[i])) i--;
  const start = i + 1;             // first char of the whitespace-delimited token
  if (value[start] !== "@") return null;
  return { start, query: value.slice(start + 1, caret) };
}

// Replace the active mention token (from its "@" up to the caret) with
// `replacement`, returning the new text and where to put the caret afterwards.
export function replaceMention(
  value: string, mention: Mention, caret: number, replacement: string,
): { text: string; caret: number } {
  const before = value.slice(0, mention.start);
  const after = value.slice(caret);
  return { text: before + replacement + after, caret: before.length + replacement.length };
}

// Build the file:// URI for a cwd-relative path, for an ACP resource_link.
export function fileUri(cwd: string, rel: string): string {
  const base = (cwd || "").replace(/\/+$/, "");
  return "file://" + base + "/" + rel.replace(/^\/+/, "");
}

export function makeMessageFile(cwd: string, rel: string): MessageFile {
  return { name: rel, uri: fileUri(cwd, rel) };
}
