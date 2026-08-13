import { describe, expect, test } from "vitest";
import { formatUntil, isInside, relativeTo } from "./format.ts";

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

describe("formatUntil", () => {
  // resetsAt is Unix seconds, not milliseconds — feeding it as ms would render
  // every window as already reset.
  const now = 1_700_000_000_000;
  const inMinutes = (m: number) => now / 1000 + m * 60;

  test("under an hour reads in minutes", () => {
    expect(formatUntil(inMinutes(12), now)).toBe("12m");
  });

  test("the two coarsest units only: hours drop the seconds, days drop the minutes", () => {
    expect(formatUntil(inMinutes(92), now)).toBe("1h 32m");
    expect(formatUntil(inMinutes(33 * 60), now)).toBe("1d 9h");
  });

  test("a whole unit doesn't trail an empty one", () => {
    expect(formatUntil(inMinutes(120), now)).toBe("2h");
    expect(formatUntil(inMinutes(48 * 60), now)).toBe("2d");
  });

  test("an elapsed window has nothing to count down to", () => {
    expect(formatUntil(inMinutes(-5), now)).toBe("");
    expect(formatUntil(inMinutes(0), now)).toBe("");
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
