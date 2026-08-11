// A selection in the file viewer, reduced to the two things an attachment needs:
// which lines it covers, and the lines themselves.
//
// Selections snap out to whole lines. Half a line is never what "add these lines
// to the chat" means — a fragment starting mid-token reads to the agent as a
// truncation rather than as a deliberate cut, and the range printed on the chip
// has to be something you can look up in the file afterwards.
//
// Offsets are counted in the text the viewer actually rendered, never in the
// file as it sits on disk: the pane may be showing a syntax-highlighted copy, or
// one the gateway truncated, and a line number derived from anything else is a
// number for a different document.

export interface LineRange { start: number; end: number } // 1-based, inclusive

// Which line `offset` falls on.
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// The whole-line range covering the selection between two offsets, or null when
// there is nothing selected (a caret, or an empty document).
export function rangeFromOffsets(text: string, from: number, to: number): LineRange | null {
  if (!text) return null;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(text.length, Math.max(from, to));
  if (hi <= lo) return null;
  // A selection dragged past the end of a line lands on the *next* line's first
  // column. Counting that as the last line attaches one nobody highlighted.
  const last = text.charCodeAt(hi - 1) === 10 ? hi - 1 : hi;
  const start = lineAt(text, lo);
  return { start, end: Math.max(start, lineAt(text, last)) };
}

export function sliceLines(text: string, range: LineRange): string {
  return text.split("\n").slice(range.start - 1, range.end).join("\n");
}

// What a range reads as on a chip: "412-427", or just "412" for one line.
export function formatRange(range: LineRange): string {
  return range.start === range.end ? String(range.start) : range.start + "-" + range.end;
}

// The fragment appended to the file:// URI. "#L412-L427" is the form GitHub, Zed
// and every editor's "copy link to line" already emit, so it survives being read
// by a human — and it makes the URI unique per range, which is what the composer
// de-duplicates attachments on: two ranges of one file are two attachments, the
// same range twice is one.
export function rangeFragment(range: LineRange): string {
  return range.start === range.end
    ? "#L" + range.start
    : "#L" + range.start + "-L" + range.end;
}

export function parseRangeFragment(uri: string): LineRange | null {
  const m = /#L(\d+)(?:-L(\d+))?$/.exec(uri || "");
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!start || end < start) return null;
  return { start, end };
}
