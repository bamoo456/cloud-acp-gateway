// Parse the unified diff text /workspace/diff returns (git's own output) into
// rows the panel can render with line numbers on both sides.
//
// Why parse git's diff instead of reusing Diff.tsx's LCS over old/new text: a
// side panel shows *file* diffs, not the small before/after snippets a tool
// call carries. Whole-file LCS is O(n·m) and Diff.tsx already degrades to
// "everything deleted, everything added" past 40k cells — a 300-line file
// against itself is already over that. git has done the work; this reads it.

export type DiffRowType = "ctx" | "add" | "del";

export interface DiffRow {
  t: DiffRowType;
  text: string;
  // Line numbers in the pre- and post-image. Null on the side the row doesn't
  // exist in (an added line has no old number), which is what lets the gutter
  // render blank there rather than an off-by-one lie.
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;   // the "@@ -a,b +c,d @@ context" line, shown as a separator
  rows: DiffRow[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let cur: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const lines = (text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = HUNK.exec(line);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      cur = { header: line, rows: [] };
      hunks.push(cur);
      continue;
    }
    // Everything before the first @@ is git's file header (diff --git, index,
    // ---/+++, mode changes). The panel shows the path in its own title bar, so
    // none of it is worth a row — and skipping it is also what stops the "+++"
    // line from being counted and coloured as an added line.
    if (!cur) continue;
    const kind = line[0];
    if (kind === "+") {
      cur.rows.push({ t: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
      additions++;
    } else if (kind === "-") {
      cur.rows.push({ t: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
      deletions++;
    } else if (kind === " ") {
      cur.rows.push({ t: "ctx", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (kind === "\\") {
      // "\ No newline at end of file" — an annotation on the row above, not a
      // line of the file. Dropping it keeps both line counters honest.
      continue;
    } else if (line === "") {
      // An empty context line git wrote without its leading space — real
      // content, so it gets a row. The one exception is the final split
      // element, which is the artifact of the diff's own trailing newline and
      // would otherwise append a phantom blank line to every file.
      if (i < lines.length - 1) cur.rows.push({ t: "ctx", text: "", oldLine: oldLine++, newLine: newLine++ });
    } else {
      // A new file's header inside a multi-file diff. /workspace/diff is
      // single-file, but ending the hunk rather than swallowing the line keeps
      // a surprise from being rendered as file content.
      cur = null;
    }
  }
  return { hunks, additions, deletions };
}
