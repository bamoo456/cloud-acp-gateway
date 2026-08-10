import { describe, test, expect, beforeEach } from "vitest";
import {
  hydrateRecentSessions,
  readRecentSessions,
  touchRecentSession,
  removeRecentSession,
  renameRecentSession,
} from "./recentSessions.ts";

describe("recent session storage", () => {
  // Recents now live on the gateway, mirrored in an in-memory cache. Reset the
  // cache between tests (the module isn't reloaded) by hydrating it empty.
  beforeEach(() => {
    hydrateRecentSessions([]);
  });

  test("stores cross-folder sessions newest first and dedupes by agent cwd session", () => {
    const first = touchRecentSession({
      agentName: "claude",
      cwd: "/repo-a",
      sessionId: "s1",
      title: "Repo A",
      lastActiveAt: "2026-06-10T01:00:00.000Z",
    });
    expect(first).toHaveLength(1);

    touchRecentSession({
      agentName: "claude",
      cwd: "/repo-b",
      sessionId: "s2",
      title: "Repo B",
      lastActiveAt: "2026-06-10T02:00:00.000Z",
    });
    touchRecentSession({
      agentName: "claude",
      cwd: "/repo-a",
      sessionId: "s1",
      title: "Repo A renamed",
      lastActiveAt: "2026-06-10T03:00:00.000Z",
    });

    expect(readRecentSessions()).toEqual([
      {
        agentName: "claude",
        cwd: "/repo-a",
        sessionId: "s1",
        title: "Repo A renamed",
        lastActiveAt: "2026-06-10T03:00:00.000Z",
      },
      {
        agentName: "claude",
        cwd: "/repo-b",
        sessionId: "s2",
        title: "Repo B",
        lastActiveAt: "2026-06-10T02:00:00.000Z",
      },
    ]);
  });

  test("removing a deleted conversation drops it under every agent and cwd", () => {
    const mk = (agentName: string, cwd: string, sessionId: string, n: number) => ({
      agentName, cwd, sessionId, title: sessionId,
      lastActiveAt: `2026-06-10T0${n}:00:00.000Z`,
    });
    // One conversation can be cached under both spellings of its folder (the
    // gateway realpaths, the client doesn't) and under two agents sharing a
    // provider. The gateway deleted all of them, so the cache must match.
    touchRecentSession(mk("claude", "/tmp/repo", "s1", 1));
    touchRecentSession(mk("claude", "/private/tmp/repo", "s1", 2));
    touchRecentSession(mk("claude-infra", "/tmp/repo", "s1", 3));
    touchRecentSession(mk("claude", "/tmp/repo", "s2", 4)); // a different conversation

    const left = removeRecentSession("s1");

    expect(left.map((it) => it.sessionId)).toEqual(["s2"]);
    expect(readRecentSessions()).toEqual(left);
    expect(removeRecentSession("s1")).toEqual(left);
  });

  test("renaming a conversation retitles it under every agent and cwd", () => {
    const mk = (agentName: string, cwd: string, sessionId: string, n: number) => ({
      agentName, cwd, sessionId, title: "old name",
      lastActiveAt: `2026-06-10T0${n}:00:00.000Z`,
    });
    // Same several-rows-per-conversation shape as the removal case above.
    // touchRecentSession rewrites exactly one of them, so a rename that stopped
    // there left the others showing the old name in Recent.
    touchRecentSession(mk("claude", "/tmp/repo", "s1", 1));
    touchRecentSession(mk("claude", "/private/tmp/repo", "s1", 2));
    touchRecentSession(mk("claude-infra", "/tmp/repo", "s1", 3));
    touchRecentSession(mk("claude", "/tmp/repo", "s2", 4)); // a different conversation

    const after = renameRecentSession("s1", "  My renamed chat  ");

    expect(after.filter((it) => it.sessionId === "s1").map((it) => it.title))
      .toEqual(["My renamed chat", "My renamed chat", "My renamed chat"]);
    expect(after.filter((it) => it.sessionId === "s2").map((it) => it.title)).toEqual(["old name"]);
    expect(readRecentSessions()).toEqual(after);
    // Clearing a rename hands the title back to the gateway's derived one, so the
    // cache is left alone rather than blanked.
    expect(renameRecentSession("s1", "   ")).toEqual(after);
  });

  test("hydrating ignores corrupt payloads", () => {
    expect(hydrateRecentSessions("{bad json" as unknown)).toEqual([]);
    expect(hydrateRecentSessions([{ agentName: "claude" }, null] as unknown)).toEqual([]);
    expect(readRecentSessions()).toEqual([]);
  });
});
