import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "./unified-diff.ts";

const sample = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  "+two and a half",
  " three",
  " four",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  test("keeps the file header out of the rendered rows", () => {
    const d = parseUnifiedDiff(sample);
    expect(d.hunks).toHaveLength(1);
    // The "+++ b/src/a.ts" line would otherwise render as an added line of code.
    expect(d.hunks[0].rows.map((r) => r.text)).toEqual([
      "one", "two", "TWO", "two and a half", "three", "four",
    ]);
    expect(d.hunks[0].header).toBe("@@ -1,4 +1,5 @@");
  });

  test("numbers both sides, leaving the gutter blank where a line doesn't exist", () => {
    const rows = parseUnifiedDiff(sample).hunks[0].rows;
    expect(rows.map((r) => [r.t, r.oldLine, r.newLine])).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
      ["ctx", 4, 5],
    ]);
  });

  test("counts additions and deletions", () => {
    const d = parseUnifiedDiff(sample);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
  });

  test("handles several hunks, restarting the line numbers at each header", () => {
    const d = parseUnifiedDiff([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -40,2 +40,3 @@ function tail()",
      " y",
      "+z",
      " w",
    ].join("\n"));
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[1].header).toContain("function tail()");
    expect(d.hunks[1].rows[0]).toEqual({ t: "ctx", text: "y", oldLine: 40, newLine: 40 });
    expect(d.hunks[1].rows[1]).toEqual({ t: "add", text: "z", oldLine: null, newLine: 41 });
    expect(d.hunks[1].rows[2]).toEqual({ t: "ctx", text: "w", oldLine: 41, newLine: 42 });
  });

  test("a single-line hunk header (no count) still parses", () => {
    const d = parseUnifiedDiff(["@@ -0,0 +1 @@", "+only"].join("\n"));
    expect(d.hunks[0].rows).toEqual([{ t: "add", text: "only", oldLine: null, newLine: 1 }]);
  });

  test("'\\ No newline at end of file' is dropped without shifting line numbers", () => {
    const d = parseUnifiedDiff([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+B",
      "\\ No newline at end of file",
    ].join("\n"));
    expect(d.hunks[0].rows).toEqual([
      { t: "ctx", text: "a", oldLine: 1, newLine: 1 },
      { t: "del", text: "b", oldLine: 2, newLine: null },
      { t: "add", text: "B", oldLine: null, newLine: 2 },
    ]);
  });

  test("an empty or header-only diff yields no hunks rather than throwing", () => {
    expect(parseUnifiedDiff("")).toEqual({ hunks: [], additions: 0, deletions: 0 });
    expect(parseUnifiedDiff("diff --git a/x b/x\nindex 00..11\n").hunks).toEqual([]);
  });

  test("blank context lines inside a hunk keep their place", () => {
    const d = parseUnifiedDiff(["@@ -1,3 +1,3 @@", " a", "", "-c", "+C"].join("\n"));
    expect(d.hunks[0].rows.map((r) => [r.t, r.text])).toEqual([
      ["ctx", "a"], ["ctx", ""], ["del", "c"], ["add", "C"],
    ]);
  });
});
