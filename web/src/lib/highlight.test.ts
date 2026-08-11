import { describe, expect, test } from "vitest";
import { highlightBlock, highlightDiffRows, highlightLanguageFor, highlightLines } from "./highlight.ts";
import type { DiffRow } from "./unified-diff.ts";

// Round-trips highlighted HTML through the DOM and checks it reads back as
// exactly the source text — the property that matters, since the actual
// token boundaries hljs picks aren't this file's business.
function textOf(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}

describe("highlightLanguageFor", () => {
  test("maps a known extension to its grammar", () => {
    expect(highlightLanguageFor("Main.java")).toBe("java");
    expect(highlightLanguageFor("src/app.tsx")).toBe("typescript");
    expect(highlightLanguageFor("config.toml")).toBe("ini");
    expect(highlightLanguageFor("README.md")).toBe("markdown");
  });

  test("a name-based grammar wins over guessing from the extension", () => {
    expect(highlightLanguageFor("deploy/Dockerfile")).toBe("dockerfile");
    expect(highlightLanguageFor("build/Makefile")).toBe("makefile");
  });

  test("an unrecognised or missing extension gets no grammar", () => {
    expect(highlightLanguageFor("build/out.wasm")).toBeUndefined();
    expect(highlightLanguageFor("LICENSE")).toBeUndefined();
  });
});

describe("highlightBlock", () => {
  test("colours known code and preserves every character", () => {
    const src = 'public class Main { String s = "hi"; }';
    const html = highlightBlock(src, "java");
    expect(html).not.toBeNull();
    expect(html).toContain("hljs-");
    expect(textOf(html!)).toBe(src);
  });

  test("declines an unregistered language", () => {
    expect(highlightBlock("anything", "not-a-real-language")).toBeNull();
  });

  test("declines input too large to colour cheaply", () => {
    const huge = "x = 1;\n".repeat(30_000); // well past the char cap
    expect(highlightBlock(huge, "javascript")).toBeNull();
  });

  test("tolerates a fragment cut mid-construct", () => {
    // An unterminated block comment — the shape a 512KB truncation cap or a
    // diff hunk boundary can produce. Must not throw.
    expect(() => highlightBlock("/* start of a comment that never closes", "java")).not.toThrow();
  });
});

describe("highlightLines", () => {
  test("keeps a token that spans lines coloured on every line it touches", () => {
    const src = ["/* a comment", "that spans", "three lines */", "int x = 1;"].join("\n");
    const lines = highlightLines(src, "java");
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(4);
    // Every line round-trips to its exact source text...
    lines!.forEach((l, i) => expect(textOf(l)).toBe(src.split("\n")[i]));
    // ...and the comment's colour class actually carries onto line 2, not just line 1.
    expect(lines![1]).toContain("hljs-comment");
  });

  test("empty input declines rather than colouring nothing", () => {
    // There's nothing to tokenize, and the caller's fallback (render the raw
    // text) is visually identical for an empty string anyway.
    expect(highlightLines("", "java")).toBeNull();
  });
});

describe("highlightDiffRows", () => {
  const rows: DiffRow[] = [
    { t: "ctx", text: "keep", oldLine: 1, newLine: 1 },
    { t: "del", text: "old line", oldLine: 2, newLine: null },
    { t: "add", text: "new line", oldLine: null, newLine: 2 },
  ];

  test("one entry per row, each round-tripping to that row's text", () => {
    const out = highlightDiffRows(rows, "typescript");
    expect(out).toHaveLength(3);
    out.forEach((html, i) => expect(textOf(html ?? "")).toBe(rows[i].text));
  });

  test("an unrecognised language just means every entry is null", () => {
    const out = highlightDiffRows(rows, "not-a-real-language");
    expect(out).toEqual([null, null, null]);
  });

  test("a comment opened on the deleted side doesn't bleed into the kept context", () => {
    // "keep" only exists once in the old blob ("keep\nold /* unterminated) and
    // once in the new blob ("keep\nnew line") — the two sides are highlighted
    // independently, so this must not throw or misalign rows.
    const withUnterminated: DiffRow[] = [
      { t: "ctx", text: "keep", oldLine: 1, newLine: 1 },
      { t: "del", text: "old /* unterminated", oldLine: 2, newLine: null },
      { t: "add", text: "new line", oldLine: null, newLine: 2 },
    ];
    const out = highlightDiffRows(withUnterminated, "java");
    expect(out).toHaveLength(3);
    out.forEach((html, i) => expect(textOf(html ?? "")).toBe(withUnterminated[i].text));
  });
});
