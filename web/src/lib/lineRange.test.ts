import { describe, test, expect } from "vitest";
import {
  rangeFromOffsets, offsetsOfLines, sliceLines, formatRange, rangeFragment, parseRangeFragment,
} from "./lineRange.ts";

const FILE = ["one", "two", "three", "four"].join("\n");

describe("rangeFromOffsets", () => {
  test("snaps a part-line selection out to the whole lines it touches", () => {
    // "wo\nthr" — starts mid-line 2, ends mid-line 3.
    expect(rangeFromOffsets(FILE, 5, 12)).toEqual({ start: 2, end: 3 });
  });

  test("a selection inside one line is that one line", () => {
    expect(rangeFromOffsets(FILE, 1, 2)).toEqual({ start: 1, end: 1 });
  });

  test("dragging past the end of a line does not take the next one", () => {
    // Through the newline that closes line 2, stopping at line 3 column 0.
    // Counting that as 2-3 would attach a line nobody highlighted.
    expect(rangeFromOffsets(FILE, 4, 8)).toEqual({ start: 2, end: 2 });
  });

  test("reads the same whichever way the selection was dragged", () => {
    expect(rangeFromOffsets(FILE, 12, 5)).toEqual(rangeFromOffsets(FILE, 5, 12));
  });

  test("a caret is not a selection", () => {
    expect(rangeFromOffsets(FILE, 6, 6)).toBeNull();
    expect(rangeFromOffsets("", 0, 0)).toBeNull();
  });

  test("offsets beyond the text clamp to it rather than inventing lines", () => {
    expect(rangeFromOffsets(FILE, 0, 9_999)).toEqual({ start: 1, end: 4 });
    expect(rangeFromOffsets(FILE, -5, 3)).toEqual({ start: 1, end: 1 });
  });
});

describe("offsetsOfLines", () => {
  test("covers the named lines, newline included, and inverts rangeFromOffsets", () => {
    expect(offsetsOfLines(FILE, { start: 2, end: 3 })).toEqual([4, 14]);
    expect(FILE.slice(4, 14)).toBe("two\nthree\n");
    expect(rangeFromOffsets(FILE, 4, 14)).toEqual({ start: 2, end: 3 });
    // The last line has no newline to include.
    expect(offsetsOfLines(FILE, { start: 4, end: 4 })).toEqual([14, 18]);
    // A range past the end stops at the end rather than failing.
    expect(offsetsOfLines(FILE, { start: 3, end: 9 })).toEqual([8, 18]);
  });

  test("a line the text does not reach is nowhere, not the last line", () => {
    expect(offsetsOfLines(FILE, { start: 5, end: 5 })).toBeNull();
    expect(offsetsOfLines("one\ntwo\n", { start: 3, end: 3 })).toBeNull();
    expect(offsetsOfLines("", { start: 1, end: 1 })).toBeNull();
  });
});

describe("sliceLines", () => {
  test("returns exactly the lines the range names", () => {
    expect(sliceLines(FILE, { start: 2, end: 3 })).toBe("two\nthree");
    expect(sliceLines(FILE, { start: 1, end: 1 })).toBe("one");
    expect(sliceLines(FILE, { start: 4, end: 4 })).toBe("four");
  });

  test("keeps blank lines inside the range", () => {
    expect(sliceLines("a\n\nb", { start: 1, end: 3 })).toBe("a\n\nb");
  });
});

describe("the URI fragment", () => {
  test("a range round-trips through its fragment", () => {
    const range = { start: 412, end: 427 };
    expect(rangeFragment(range)).toBe("#L412-L427");
    expect(parseRangeFragment("file:///r/a.ts" + rangeFragment(range))).toEqual(range);
  });

  test("one line is written once, not as a range onto itself", () => {
    expect(rangeFragment({ start: 7, end: 7 })).toBe("#L7");
    expect(formatRange({ start: 7, end: 7 })).toBe("7");
    expect(parseRangeFragment("file:///r/a.ts#L7")).toEqual({ start: 7, end: 7 });
  });

  test("a URI without a range has none", () => {
    expect(parseRangeFragment("file:///r/a.ts")).toBeNull();
    // A "#" that isn't a line reference — a file whose name contains one.
    expect(parseRangeFragment("file:///r/a#b.ts")).toBeNull();
    expect(parseRangeFragment("")).toBeNull();
  });

  test("a backwards or zero range is not a range", () => {
    expect(parseRangeFragment("file:///r/a.ts#L20-L10")).toBeNull();
    expect(parseRangeFragment("file:///r/a.ts#L0")).toBeNull();
  });
});
