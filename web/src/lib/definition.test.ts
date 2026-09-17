import { describe, expect, it } from "vitest";
import { isDefinitionPath, offsetToLineColumn } from "./definition.ts";

describe("isDefinitionPath", () => {
  it("matches Java files only", () => {
    expect(isDefinitionPath("src/Main.java")).toBe(true);
    expect(isDefinitionPath("src/Main.JAVA")).toBe(true);
    expect(isDefinitionPath("src/app.ts")).toBe(false);
    expect(isDefinitionPath("Main.javascript")).toBe(false);
  });
});

describe("offsetToLineColumn", () => {
  it("counts the first character as line 1, column 1", () => {
    expect(offsetToLineColumn("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
  });
  it("advances lines and resets columns past newlines", () => {
    expect(offsetToLineColumn("ab\ncd", 3)).toEqual({ line: 2, column: 1 });
    expect(offsetToLineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
  it("clamps out-of-range offsets", () => {
    expect(offsetToLineColumn("ab", 99)).toEqual({ line: 1, column: 3 });
    expect(offsetToLineColumn("ab", -5)).toEqual({ line: 1, column: 1 });
  });
});
