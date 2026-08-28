import { describe, expect, test, beforeEach } from "vitest";
import { readFolderStates, saveFolderStates } from "./sessionsView.ts";

describe("folder open/shut states", () => {
  beforeEach(() => localStorage.clear());

  test("round-trips the chosen states", () => {
    saveFolderStates({ "/x/repo": "open", "/x/other": "shut" });
    expect(readFolderStates()).toEqual({ "/x/repo": "open", "/x/other": "shut" });
  });

  test("nothing stored means no overrides — every folder follows its default", () => {
    expect(readFolderStates()).toEqual({});
  });

  test("garbage and unknown values are dropped, not thrown", () => {
    localStorage.setItem("acpg.folderStates", "not json");
    expect(readFolderStates()).toEqual({});
    localStorage.setItem("acpg.folderStates", JSON.stringify({ "/a": "open", "/b": "sideways", "/c": 1 }));
    expect(readFolderStates()).toEqual({ "/a": "open" });
  });

  test("the retired flips format is ignored — a stale delta must not resurface as a state", () => {
    // Pre-fix builds stored a Set of keys under acpg.folderOverrides whose
    // meaning depended on each folder's default at read time. The new reader
    // must not consume it: those entries are exactly the ones that inverted.
    localStorage.setItem("acpg.folderOverrides", JSON.stringify(["/x/repo"]));
    expect(readFolderStates()).toEqual({});
  });
});
