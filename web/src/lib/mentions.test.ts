import { describe, test, expect } from "vitest";
import {
  activeMention, replaceMention, fileUri, makeMessageFile,
  makeAbsFile, makeRangeFile, describeFileUri,
} from "./mentions.ts";

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

describe("references attached from the file panel", () => {
  test("a panel pick and an '@' pick of one file produce the same URI", () => {
    // They must, or the composer's de-duplication (which keys on the URI) lets
    // one file on twice under two names.
    expect(makeAbsFile("/repo/web/src/App.tsx", "web/src/App.tsx").uri)
      .toBe(makeMessageFile("/repo", "web/src/App.tsx").uri);
  });

  test("the panel labels a file by its path, not by its URI", () => {
    expect(makeAbsFile("/repo/web/src/App.tsx", "web/src/App.tsx"))
      .toEqual({ name: "web/src/App.tsx", uri: "file:///repo/web/src/App.tsx" });
  });

  test("a range carries its lines, its label, and a URI unique to that range", () => {
    const f = makeRangeFile("/repo/a.ts", "a.ts", { start: 12, end: 20 }, "the lines");
    expect(f).toEqual({
      name: "a.ts", range: "12-20", uri: "file:///repo/a.ts#L12-L20", text: "the lines",
    });
    // Two ranges of one file are two attachments; the same range twice is one.
    expect(makeRangeFile("/repo/a.ts", "a.ts", { start: 30, end: 31 }, "other").uri)
      .not.toBe(f.uri);
    expect(makeRangeFile("/repo/a.ts", "a.ts", { start: 12, end: 20 }, "the lines").uri)
      .toBe(f.uri);
  });

  test("describeFileUri reads a chip back out of a URI", () => {
    expect(describeFileUri("file:///repo/web/src/App.tsx")).toEqual({ name: "App.tsx" });
    expect(describeFileUri("file:///repo/web/src/App.tsx#L12-L20"))
      .toEqual({ name: "App.tsx", range: "12-20" });
    expect(describeFileUri("file:///repo/a.ts#L7")).toEqual({ name: "a.ts", range: "7" });
  });

  test("describeFileUri falls back to the whole string when there is no path", () => {
    expect(describeFileUri("weird")).toEqual({ name: "weird" });
  });
});
