// Lightweight markdown editing helpers for the composer textarea. These are
// pure string/caret transforms so they can be unit-tested without a DOM: the
// caller reads selectionStart/selectionEnd, applies the result, then restores
// the selection range. Nothing here renders markdown — they only make *typing*
// it less tedious (wrap a selection, continue a list).

export interface EditResult {
  text: string;
  // The selection to restore after applying `text`. For a collapsed caret,
  // start === end.
  selStart: number;
  selEnd: number;
}

// Toggle a symmetric inline marker (e.g. "**" for bold, "*"/"_" for italic,
// "`" for code) around the selection [start, end):
//   - selection already wrapped *inside* (the selected text begins and ends
//     with the marker) -> strip the markers.
//   - selection already wrapped *outside* (the markers sit just beyond the
//     selection) -> strip those surrounding markers.
//   - otherwise -> wrap the selection, leaving it selected.
// With a collapsed caret (start === end) it inserts an empty pair and parks the
// caret between the markers, ready to type.
export function toggleWrap(text: string, start: number, end: number, marker: string): EditResult {
  const sel = text.slice(start, end);
  const n = marker.length;

  if (sel.length >= 2 * n && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(n, sel.length - n);
    return { text: text.slice(0, start) + inner + text.slice(end), selStart: start, selEnd: start + inner.length };
  }

  if (start >= n && text.slice(start - n, start) === marker && text.slice(end, end + n) === marker) {
    return { text: text.slice(0, start - n) + sel + text.slice(end + n), selStart: start - n, selEnd: end - n };
  }

  const wrapped = text.slice(0, start) + marker + sel + marker + text.slice(end);
  return { text: wrapped, selStart: start + n, selEnd: end + n };
}

// A list item line: optional indent, a bullet ("-", "*", "+") or an ordered
// marker ("1.", "2)"), the gap after it, then the content.
const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;
// A blockquote line: leading ">" markers (possibly nested, possibly indented)
// and the content after them.
const QUOTE_RE = /^(\s*>[ >]*)(.*)$/;

// On a newline inside a markdown list or blockquote, continue the construct:
// re-emit the same marker (incrementing an ordered number) on the next line so
// the user doesn't retype it. Returns the edit to apply, or null when the caret
// isn't on such a line (the caller then inserts a plain newline).
//
// If the current item is empty (just the marker, no content), continuing would
// only add more empty bullets — instead we *terminate* the list by clearing the
// marker, mirroring how editors end a list on a second Enter.
export function continueList(text: string, caret: number): EditResult | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);

  const list = LIST_RE.exec(line);
  if (list) {
    const [, indent, bullet, gap, content] = list;
    if (content.trim() === "") {
      // Empty item -> drop the marker, ending the list with a bare newline.
      return { text: text.slice(0, lineStart) + "\n" + text.slice(caret), selStart: lineStart + 1, selEnd: lineStart + 1 };
    }
    const m = /^(\d+)([.)])$/.exec(bullet);
    const nextBullet = m ? `${parseInt(m[1], 10) + 1}${m[2]}` : bullet;
    const insert = "\n" + indent + nextBullet + gap;
    const pos = caret + insert.length;
    return { text: text.slice(0, caret) + insert + text.slice(caret), selStart: pos, selEnd: pos };
  }

  const quote = QUOTE_RE.exec(line);
  if (quote) {
    const [, prefix, content] = quote;
    if (content.trim() === "") {
      return { text: text.slice(0, lineStart) + "\n" + text.slice(caret), selStart: lineStart + 1, selEnd: lineStart + 1 };
    }
    const insert = "\n" + prefix;
    const pos = caret + insert.length;
    return { text: text.slice(0, caret) + insert + text.slice(caret), selStart: pos, selEnd: pos };
  }

  return null;
}
