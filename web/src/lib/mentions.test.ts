import { describe, test, expect } from "vitest";
import { activeMention, replaceMention, fileUri, makeMessageFile } from "./mentions.ts";

describe("activeMention", () => {
  test("detects an @ token ending at the caret", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("@src", 4)).toEqual({ start: 0, query: "src" });
    expect(activeMention("hi @src/app", 11)).toEqual({ start: 3, query: "src/app" });
  });

  test("only triggers at a word boundary (start or after whitespace)", () => {
    expect(activeMention("a@b", 3)).toBeNull();      // mid-word (email-like)
    expect(activeMention("foo@bar", 7)).toBeNull();
    expect(activeMention("see\n@x", 6)).toEqual({ start: 4, query: "x" }); // after a newline
  });

  test("no token when there is no @ before the caret", () => {
    expect(activeMention("hello", 5)).toBeNull();
    expect(activeMention("@x ", 3)).toBeNull();       // caret after the whitespace
  });

  test("uses the token bounded by the caret, not the rest of the line", () => {
    // caret sits after "@sr" — the query is "sr", ignoring "c.tsx" past the caret
    expect(activeMention("@src.tsx", 3)).toEqual({ start: 0, query: "sr" });
  });
});

describe("replaceMention", () => {
  test("removes the token (empty replacement) and reports the caret", () => {
    const m = activeMention("hi @src done", 7)!; // caret right after "@src"
    expect(replaceMention("hi @src done", m, 7, "")).toEqual({ text: "hi  done", caret: 3 });
  });

  test("substitutes a path string (fallback mode)", () => {
    const m = activeMention("@a", 2)!;
    expect(replaceMention("@a", m, 2, "src/App.tsx ")).toEqual({ text: "src/App.tsx ", caret: 12 });
  });
});

describe("fileUri / makeMessageFile", () => {
  test("builds a file:// uri joining cwd and the relative path", () => {
    expect(fileUri("/repo", "src/App.tsx")).toBe("file:///repo/src/App.tsx");
    expect(fileUri("/repo/", "/src/App.tsx")).toBe("file:///repo/src/App.tsx"); // dedupes slashes
  });

  test("makeMessageFile carries the relative name and the uri", () => {
    expect(makeMessageFile("/repo", "src/x.ts")).toEqual({ name: "src/x.ts", uri: "file:///repo/src/x.ts" });
  });
});
