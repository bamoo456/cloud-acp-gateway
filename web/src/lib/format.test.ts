import { describe, expect, test } from "vitest";
import { isInside, relativeTo } from "./format.ts";

describe("relativeTo", () => {
  test("drops the folder prefix a whole list shares", () => {
    expect(relativeTo("/repo/web/src/App.tsx", "/repo")).toBe("web/src/App.tsx");
  });

  test("keeps the absolute path for a file outside the folder", () => {
    // A "../../" chain is unreadable in a narrow column; the real path at least
    // says where the file is.
    expect(relativeTo("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts");
  });

  test("a trailing slash on the folder doesn't leave a leading one on the file", () => {
    expect(relativeTo("/repo/a.ts", "/repo/")).toBe("a.ts");
  });

  test("a sibling folder with a shared prefix is not treated as inside", () => {
    expect(relativeTo("/repo-two/a.ts", "/repo")).toBe("/repo-two/a.ts");
  });

  test("no folder to compare against leaves the path alone", () => {
    expect(relativeTo("/repo/a.ts", "")).toBe("/repo/a.ts");
  });
});

describe("isInside", () => {
  test("a file under the root is inside it", () => {
    expect(isInside("/Users/me/repo/a.ts", "/Users/me")).toBe(true);
  });

  test("the everyday failure: /tmp against a home-directory root", () => {
    expect(isInside("/tmp/shot.png", "/Users/me")).toBe(false);
  });

  test("a sibling that merely shares the prefix is not inside", () => {
    expect(isInside("/Users/meme/a.ts", "/Users/me")).toBe(false);
  });

  test("an unknown root claims nothing", () => {
    // The config didn't say, so no row should be marked unopenable.
    expect(isInside("/tmp/a.png", "")).toBe(false);
  });
});
