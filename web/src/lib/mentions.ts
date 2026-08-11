import type { MessageFile } from "../types.ts";
import { formatRange, parseRangeFragment, rangeFragment, type LineRange } from "./lineRange.ts";

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

// The file panel works from absolute paths, not from cwd + a relative one: the
// files it lists come out of tool calls, and those name files anywhere — a row
// outside the conversation's folder has no relative path to build a URI from.
// For anything inside it this produces the same URI as fileUri, so an "@" pick
// and a panel pick of one file de-duplicate against each other.
export function absFileUri(abs: string): string {
  return "file://" + abs;
}

// A whole file, attached from the panel. `label` is what the chip shows — the
// path as it reads from the conversation's folder, which is how every row in
// the panel already names its file.
export function makeAbsFile(abs: string, label: string): MessageFile {
  return { name: label, uri: absFileUri(abs) };
}

// A range of lines. `text` is what makes this worth sending as an embedded
// resource rather than a link: the agent reads the lines out of the prompt
// instead of re-reading the file and guessing which ones "412-427" meant.
export function makeRangeFile(
  abs: string, label: string, range: LineRange, text: string,
): MessageFile {
  return {
    name: label,
    uri: absFileUri(abs) + rangeFragment(range),
    range: formatRange(range),
    text,
  };
}

// How a reference reads on a chip when its URI is all we have — the case on
// replay, where the transcript carries the wire form and not what the composer
// knew when the file was attached.
export function describeFileUri(uri: string): { name: string; range?: string } {
  const range = parseRangeFragment(uri);
  const path = range ? uri.slice(0, uri.lastIndexOf("#")) : uri;
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  return range ? { name, range: formatRange(range) } : { name };
}
