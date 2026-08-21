import { describe, expect, test } from "vitest";
import { groupByFolder, latestWithPinned, splitByAge, hideFolders, type GroupableRow } from "./sessionGroups.ts";

const HOME = "/Users/dev";
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 7, 14, 12, 0);

function row(key: string, cwd: string, hoursAgo: number, flags: { running?: boolean; needsYou?: boolean } = {}): GroupableRow<string> {
  return { key, cwd, when: NOW - hoursAgo * HOUR, running: !!flags.running, needsYou: !!flags.needsYou, data: key };
}

describe("latestWithPinned", () => {
  test("a three-hour-old session that needs you outranks a one-hour-old idle one", () => {
    // The plan's own acceptance case (§5): waiting on an Allow must not sink
    // out of sight for being quiet — that is why the phone was opened.
    const { pinned, rest } = latestWithPinned([
      row("idle-1h", "/a", 1),
      row("needs-3h", "/a", 3, { needsYou: true }),
    ]);

    expect(pinned.map((r) => r.key)).toEqual(["needs-3h"]);
    expect(rest.map((r) => r.key)).toEqual(["idle-1h"]);
  });

  test("needs-you sits above running, and the rest is strict recency", () => {
    const { pinned, rest } = latestWithPinned([
      row("old", "/a", 30),
      row("running-5h", "/a", 5, { running: true }),
      row("recent", "/a", 1),
      row("needs-9h", "/a", 9, { needsYou: true }),
    ]);

    expect(pinned.map((r) => r.key)).toEqual(["needs-9h", "running-5h"]);
    expect(rest.map((r) => r.key)).toEqual(["recent", "old"]);
  });
});

describe("groupByFolder", () => {
  test("one folder spelled several ways is one group", () => {
    const groups = groupByFolder([
      row("a", "/Users/dev/git/repo", 1),
      row("b", "~/git/repo", 2),
      row("c", "/Users/dev/git/repo/", 3),
    ], "/elsewhere", HOME);

    const repo = groups.find((g) => g.label === "repo")!;
    expect(repo.rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  test("the folder you are working in is always first", () => {
    const groups = groupByFolder([
      row("hot", "/Users/dev/other", 0, { needsYou: true, running: true }),
      row("mine", "/Users/dev/here", 40),
    ], "~/here", HOME);

    expect(groups[0].label).toBe("here");
  });

  test("then needs-you, then running, then recency", () => {
    const groups = groupByFolder([
      row("q", "/Users/dev/quiet", 1),
      row("r", "/Users/dev/runs", 20, { running: true }),
      row("n", "/Users/dev/waits", 30, { needsYou: true }),
      row("s", "/Users/dev/stale", 90),
    ], "/Users/dev/cur", HOME);

    expect(groups.map((g) => g.label)).toEqual(["cur", "waits", "runs", "quiet", "stale"]);
  });

  test("the current folder appears even with no sessions in it yet", () => {
    const groups = groupByFolder([row("a", "/Users/dev/other", 1)], "/Users/dev/empty", HOME);

    expect(groups[0]).toMatchObject({ label: "empty", current: true, rows: [] });
  });

  test("a folder is marked running / needs-you if any row in it is", () => {
    const [g] = groupByFolder([
      row("a", "/Users/dev/repo", 1),
      row("b", "/Users/dev/repo", 2, { needsYou: true }),
    ], "/Users/dev/repo", HOME);

    expect(g).toMatchObject({ needsYou: true, running: false });
    // and inside a folder the same ordering applies
    expect(g.rows.map((r) => r.key)).toEqual(["b", "a"]);
  });
});

describe("splitByAge", () => {
  test("a session exactly one hour old is still fresh, not older", () => {
    const { fresh, older } = splitByAge([row("edge", "/a", 1)], NOW);
    expect(fresh.map((r) => r.key)).toEqual(["edge"]);
    expect(older).toEqual([]);
  });

  test("no usable timestamp lands in older, not fresh", () => {
    const noTime: GroupableRow<string> = {
      key: "no-time", cwd: "/a", when: 0, running: false, needsYou: false, data: "no-time",
    };
    const { fresh, older } = splitByAge([noTime], NOW);
    expect(fresh).toEqual([]);
    expect(older.map((r) => r.key)).toEqual(["no-time"]);
  });

  test("splits fresh from older around the window", () => {
    const { fresh, older } = splitByAge([row("recent", "/a", 0.5), row("stale", "/a", 3)], NOW);
    expect(fresh.map((r) => r.key)).toEqual(["recent"]);
    expect(older.map((r) => r.key)).toEqual(["stale"]);
  });
});

describe("hideFolders", () => {
  test("hides the exact folder chosen", () => {
    const rows = [
      row("a", "/Users/dev/scratch", 1),
      row("b", "/Users/dev/other", 1),
    ];
    const out = hideFolders(rows, ["/Users/dev/scratch"], "/elsewhere", HOME);
    expect(out.map((r) => r.key)).toEqual(["b"]);
  });

  test("hiding a parent folder hides everything under it", () => {
    const rows = [
      row("a", "/Users/dev/git/worktrees/foo", 1),
      row("b", "/Users/dev/git/repo", 1),
    ];
    const out = hideFolders(rows, ["/Users/dev/git/worktrees"], "/elsewhere", HOME);
    expect(out.map((r) => r.key)).toEqual(["b"]);
  });

  test("hiding /x/repo does NOT hide /x/repo-2 (no substring matching)", () => {
    const rows = [
      row("a", "/Users/dev/repo", 1),
      row("b", "/Users/dev/repo-2", 1),
    ];
    const out = hideFolders(rows, ["/Users/dev/repo"], "/elsewhere", HOME);
    expect(out.map((r) => r.key)).toEqual(["b"]);
  });

  test("a hidden entry spelled with ~ still hides the folder spelled absolutely", () => {
    const rows = [row("a", "/Users/dev/scratch", 1)];
    const out = hideFolders(rows, ["~/scratch"], "/elsewhere", HOME);
    expect(out).toEqual([]);
  });

  test("never hides the folder you are currently working in", () => {
    const rows = [row("mine", "/Users/dev/here", 1)];
    const out = hideFolders(rows, ["/Users/dev/here"], "/Users/dev/here", HOME);
    expect(out.map((r) => r.key)).toEqual(["mine"]);
  });

  test("an empty list is a no-op", () => {
    const rows = [row("a", "/Users/dev/anything", 1)];
    expect(hideFolders(rows, [], "/elsewhere", HOME)).toBe(rows);
  });
});
