import { describe, test, expect } from "vitest";
import { toggleWrap, continueList } from "./markdown-edit.ts";

describe("toggleWrap", () => {
  test("wraps a selection and keeps it selected", () => {
    // wrap "world" (chars 6..11) in **
    expect(toggleWrap("hello world", 6, 11, "**")).toEqual({ text: "hello **world**", selStart: 8, selEnd: 13 });
  });

  test("inserts an empty pair at a collapsed caret, parking it between", () => {
    expect(toggleWrap("ab", 1, 1, "`")).toEqual({ text: "a``b", selStart: 2, selEnd: 2 });
  });

  test("unwraps when the markers sit inside the selection", () => {
    // selecting "**world**" toggles back to "world"
    expect(toggleWrap("hello **world**", 6, 15, "**")).toEqual({ text: "hello world", selStart: 6, selEnd: 11 });
  });

  test("unwraps when the markers sit just outside the selection", () => {
    // caret-selection is "world"; the ** are immediately around it
    expect(toggleWrap("hello **world**", 8, 13, "**")).toEqual({ text: "hello world", selStart: 6, selEnd: 11 });
  });

  test("handles single-char markers (italic, code)", () => {
    expect(toggleWrap("x", 0, 1, "*")).toEqual({ text: "*x*", selStart: 1, selEnd: 2 });
    expect(toggleWrap("*x*", 1, 2, "*")).toEqual({ text: "x", selStart: 0, selEnd: 1 });
  });
});

describe("continueList", () => {
  test("continues a bullet list, re-emitting the marker", () => {
    const r = continueList("- one", 5)!;
    expect(r.text).toBe("- one\n- ");
    expect(r.selStart).toBe(8);
    expect(r.selEnd).toBe(8);
  });

  test("preserves indentation and bullet style", () => {
    expect(continueList("  * item", 8)!.text).toBe("  * item\n  * ");
    expect(continueList("+ item", 6)!.text).toBe("+ item\n+ ");
  });

  test("increments an ordered list number", () => {
    expect(continueList("1. first", 8)!.text).toBe("1. first\n2. ");
    expect(continueList("3. third", 8)!.text).toBe("3. third\n4. ");
    expect(continueList("9) nine", 7)!.text).toBe("9) nine\n10) ");
  });

  test("terminates the list when the current item is empty", () => {
    // "- " with nothing typed -> Enter ends the list with a bare newline
    const r = continueList("- ", 2)!;
    expect(r.text).toBe("\n");
    expect(r.selStart).toBe(1);
  });

  test("continues a blockquote", () => {
    expect(continueList("> quoted", 8)!.text).toBe("> quoted\n> ");
  });

  test("returns null when the caret is not on a list/quote line", () => {
    expect(continueList("plain text", 10)).toBeNull();
    expect(continueList("hello", 5)).toBeNull();
  });

  test("uses the line the caret is on, not the whole text", () => {
    const text = "intro\n- one";
    expect(continueList(text, text.length)!.text).toBe("intro\n- one\n- ");
  });
});
