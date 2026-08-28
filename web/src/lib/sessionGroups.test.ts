import { describe, expect, test } from "vitest";
import { groupByFolder, latestWithPinned, splitByAge, hideFolders, type GroupableRow } from "./sessionGroups.ts";

const HOME = "/Users/dev";
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 7, 14, 12, 0);

function row(key: string, cwd: string, hoursAgo: number, flags: { running?: boolean; needsYou?: boolean; unread?: boolean; pinned?: boolean; archived?: boolean } = {}): GroupableRow<string> {
  return {
    key, cwd, when: NOW - hoursAgo * HOUR, running: !!flags.running,
    needsYou: !!flags.needsYou, unread: !!flags.unread, pinned: !!flags.pinned,
    archived: !!flags.archived, data: key,
  };
}

describe("latestWithPinned", () => {
  test("a pinned session outranks one that needs you, and never lands in rest", () => {
    // The whole point of a pin: it is the one ordering signal the reader set by
    // hand, so nothing the gateway reports about another session may displace it.
    const { pinned, rest } = latestWithPinned([
      row("idle-1h", "/a", 1),
      row("needs-3h", "/a", 3, { needsYou: true }),
      row("pinned-40h", "/a", 40, { pinned: true }),
    ]);

    expect(pinned.map((r) => r.key)).toEqual(["pinned-40h", "needs-3h"]);
    expect(rest.map((r) => r.key)).toEqual(["idle-1h"]);
  });


  test("an archived session sinks below every ordinary one in rest", () => {
    const { rest } = latestWithPinned([
      row("arch-fresh", "/a", 0, { archived: true }),
      row("idle-40h", "/a", 40),
      row("idle-1h", "/a", 1),
    ]);

    expect(rest.map((r) => r.key)).toEqual(["idle-1h", "idle-40h", "arch-fresh"]);
  });

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

  test("unread reaches the folder header without reordering the folders", () => {
    // The dot is the only thing unread earns: a finished turn is something to
    // read, not something to interrupt you, so the list stays in recency order
    // (unlike needs-you and running, which do jump).
    const groups = groupByFolder([
      row("fresh", "/Users/dev/quiet", 1),
      row("done", "/Users/dev/read-me", 20, { unread: true }),
    ], "/Users/dev/cur", HOME);

    expect(groups.map((g) => g.label)).toEqual(["cur", "quiet", "read-me"]);
    expect(groups.find((g) => g.label === "read-me")!.unread).toBe(true);
    expect(groups.find((g) => g.label === "quiet")!.unread).toBe(false);
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

  test("archived rows sink to the bottom of their folder, pin or no pin", () => {
    // What archiving means in the folder view: out of the way, still reachable.
    // It outranks the pin because it is the later explicit choice.
    const [g] = groupByFolder([
      row("arch-pinned", "/a", 1, { archived: true, pinned: true }),
      row("old", "/a", 40),
      row("arch-fresh", "/a", 0, { archived: true }),
      row("new", "/a", 2),
    ], "/a", HOME);

    // Ranking still applies INSIDE the archived tail — a pin isn't discarded by
    // archiving, it just stops hoisting the row over the unarchived ones.
    expect(g.rows.map((r) => r.key)).toEqual(["new", "old", "arch-pinned", "arch-fresh"]);
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
      key: "no-time", cwd: "/a", when: 0, running: false, needsYou: false, unread: false, pinned: false, data: "no-time",
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

describe("sort by name", () => {
  test("groups sort alphabetically, ignoring every hoist — activity, pins, even the current folder", () => {
    const groups = groupByFolder([
      row("z-busy", "/Users/dev/zeta", 0, { running: true, needsYou: true }),
      row("m-pin", "/Users/dev/mid", 40, { pinned: true }),
      row("a-stale", "/Users/dev/alpha", 90),
    ], "/Users/dev/zeta", HOME, "name");

    expect(groups.map((g) => g.label)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("rows inside a folder keep the activity order", () => {
    const groups = groupByFolder([
      row("old", "/Users/dev/repo", 40),
      row("pin", "/Users/dev/repo", 50, { pinned: true }),
      row("new", "/Users/dev/repo", 1),
    ], "", HOME, "name");

    expect(groups[0].rows.map((r) => r.key)).toEqual(["pin", "new", "old"]);
  });
});

describe("pins in the folder view", () => {
  test("a pinned row sorts to the top of its folder, and its folder above quieter ones", () => {
    const groups = groupByFolder([
      row("fresh", "/Users/dev/quiet", 0.5),
      row("stale", "/Users/dev/repo", 40),
      row("pin", "/Users/dev/repo", 50, { pinned: true }),
    ], "", HOME);

    expect(groups.map((g) => g.key)).toEqual(["/users/dev/repo", "/users/dev/quiet"]);
    expect(groups[0].hasPinned).toBe(true);
    expect(groups[0].rows.map((r) => r.key)).toEqual(["pin", "stale"]);
    expect(groups[1].hasPinned).toBe(false);
  });
});
