import { parseUnifiedDiff } from "../lib/unified-diff.ts";
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
export function UnifiedDiff({ diff, path, truncated }: { diff: string; path?: string; truncated?: boolean }) {
  const parsed = parseUnifiedDiff(diff);
  if (parsed.hunks.length === 0) {
    return <div className="wf-empty">No changes against the last commit.</div>;
  }
  const lang = path ? highlightLanguageFor(path) : undefined;
  return (
    <div className={"udiff" + (lang ? " wf-hl" : "")}>
      <div className="udiff-stat">
        <span className="add">+{parsed.additions}</span>
        <span className="del">−{parsed.deletions}</span>
      </div>
      {parsed.hunks.map((h, hi) => {
        const html = lang ? highlightDiffRows(h.rows, lang) : null;
        return (
          <div className="udiff-hunk" key={hi}>
            <div className="udiff-head">{h.header}</div>
            {h.rows.map((r, ri) => (
              <div className={"udiff-row " + r.t} key={ri}>
                <span className="gutter">{r.oldLine ?? ""}</span>
                <span className="gutter">{r.newLine ?? ""}</span>
                {/* The sign is its own cell rather than part of the text, so
                    selecting a hunk to copy yields the code, not a column of
                    +/- characters glued to it. */}
                <span className="sign">{r.t === "add" ? "+" : r.t === "del" ? "−" : " "}</span>
                {html?.[ri] != null
                  ? <span className="code" dangerouslySetInnerHTML={{ __html: html[ri] || " " }} />
                  : <span className="code">{r.text || " "}</span>}
              </div>
            ))}
          </div>
        );
      })}
      {truncated && <div className="wf-note">Diff truncated — open the file locally to see the rest.</div>}
    </div>
  );
}
