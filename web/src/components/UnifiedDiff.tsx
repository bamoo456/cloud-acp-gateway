import { parseUnifiedDiff, type DiffRow } from "../lib/unified-diff.ts";
import { highlightDiffRows, highlightLanguageFor } from "../lib/highlight.ts";

// A file diff as git produced it: hunk headers as separators, line numbers for
// both sides, and one row per line. Distinct from Diff.tsx, which renders the
// small before/after pairs an ACP tool call carries inline in the thread; this
// one reads a whole file's unified diff, so it shows only the changed
// neighbourhoods rather than every line of the file.
//
// `path` is only for picking a grammar to colour the code with — every row
// still shows its plain text when there's no match, the blob is too large to
// colour cheaply, or `path` is omitted.
//
// In Review mode it grows two optional props. `onPick` makes every row a target:
// tapping one anchors a comment to that line. That is a whole row rather than
// GitHub's hover-`+` because this panel is driven from a phone as often as from
// a mouse — there is no hover there, and a button inside the 38px gutter is
// below the touch target the rest of the panel keeps to. `renderComments` draws
// whatever belongs under a given line. Both absent, this renders exactly as it
// always did.

// Which line a row anchors a comment to. An added or context row is addressed by
// its new-side number; a deleted row only has an old-side one, and the two
// numbering schemes are not interchangeable — a comment stored against the wrong
// side points at an unrelated line.
export interface DiffAnchor { side: "new" | "old"; line: number; code: string }

export function anchorOf(row: DiffRow): DiffAnchor | null {
  if (row.newLine != null) return { side: "new", line: row.newLine, code: row.text };
  if (row.oldLine != null) return { side: "old", line: row.oldLine, code: row.text };
  return null;
}

export function UnifiedDiff({ diff, path, truncated, onPick, picked, renderComments }: {
  diff: string; path?: string; truncated?: boolean;
  onPick?: (anchor: DiffAnchor) => void;
  // The anchor a comment is being written against right now, drawn as selected
  // so the row and the open composer under it read as one thing.
  picked?: DiffAnchor | null;
  renderComments?: (anchor: DiffAnchor) => React.ReactNode;
}) {
  const parsed = parseUnifiedDiff(diff);
  if (parsed.hunks.length === 0) {
    return <div className="wf-empty">No changes against the last commit.</div>;
  }
  const lang = path ? highlightLanguageFor(path) : undefined;
  return (
    <div className={"udiff" + (lang ? " wf-hl" : "") + (onPick ? " pickable" : "")}>
      <div className="udiff-stat">
        <span className="add">+{parsed.additions}</span>
        <span className="del">−{parsed.deletions}</span>
      </div>
      {parsed.hunks.map((h, hi) => {
        const html = lang ? highlightDiffRows(h.rows, lang) : null;
        return (
          <div className="udiff-hunk" key={hi}>
            <div className="udiff-head">{h.header}</div>
            {h.rows.map((r, ri) => {
              const anchor = onPick || renderComments ? anchorOf(r) : null;
              const isPicked = !!anchor && !!picked &&
                picked.side === anchor.side && picked.line === anchor.line;
              const code = html?.[ri] != null
                ? <span className="code" dangerouslySetInnerHTML={{ __html: html[ri] || " " }} />
                : <span className="code">{r.text || " "}</span>;
              const row = (
                <>
                  <span className="gutter">{r.oldLine ?? ""}</span>
                  <span className="gutter">{r.newLine ?? ""}</span>
                  {/* The sign is its own cell rather than part of the text, so
                      selecting a hunk to copy yields the code, not a column of
                      +/- characters glued to it. */}
                  <span className="sign">{r.t === "add" ? "+" : r.t === "del" ? "−" : " "}</span>
                  {code}
                </>
              );
              return (
                <div key={ri}>
                  {/* A button only when it does something. A plain div stays a
                      plain div for the ordinary viewer, so nothing outside
                      Review mode gains a focus stop per diff line. */}
                  {anchor && onPick
                    ? <button type="button" className={"udiff-row " + r.t + (isPicked ? " picked" : "")}
                        onClick={() => onPick(anchor)}
                        title={"Comment on line " + anchor.line}>{row}</button>
                    : <div className={"udiff-row " + r.t + (isPicked ? " picked" : "")}>{row}</div>}
                  {anchor && renderComments?.(anchor)}
                </div>
              );
            })}
          </div>
        );
      })}
      {truncated && <div className="wf-note">Diff truncated — open the file locally to see the rest.</div>}
    </div>
  );
}
