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

  test("a derived (seed) title never replaces a recorded one", () => {
    // The regression this guards: touchSessionActivity runs on every frame of a
    // running turn and has to DERIVE a title (the transcript's first user message)
    // whenever the in-memory session carries none — after a deep-link join, an
    // agent restart, or on a second device. Letting that derived title through
    // reverts a renamed conversation to its old name mid-turn.
    touchRecentSession({
      agentName: "claude", cwd: "/repo", sessionId: "s1",
      title: "My renamed chat", lastActiveAt: "2026-06-10T01:00:00.000Z",
    });

    const after = touchRecentSession({
      agentName: "claude", cwd: "/repo", sessionId: "s1",
      title: "fix the flaky test please", lastActiveAt: "2026-06-10T02:00:00.000Z",
    }, true);

    expect(after[0].title).toBe("My renamed chat");
    expect(after[0].lastActiveAt).toBe("2026-06-10T02:00:00.000Z"); // recency still moves
  });

  test("a seed title carries across the other spellings of a conversation's folder", () => {
    // The recorded title belongs to the conversation, not to one (agent, cwd) row —
    // so a first touch under a second spelling of the folder must adopt the name
    // already on record instead of seeding a duplicate row with the derived one.
    touchRecentSession({
      agentName: "claude", cwd: "/tmp/repo", sessionId: "s1",
      title: "My renamed chat", lastActiveAt: "2026-06-10T01:00:00.000Z",
    });

    const after = touchRecentSession({
      agentName: "claude-infra", cwd: "/private/tmp/repo", sessionId: "s1",
      title: "fix the flaky test please", lastActiveAt: "2026-06-10T02:00:00.000Z",
    }, true);

    expect(after.map((it) => it.title)).toEqual(["My renamed chat", "My renamed chat"]);
  });

  test("a seed title still names a conversation with nothing on record", () => {
    // Only the OVERWRITE is blocked. A brand-new conversation has no recorded name,
    // so the derived first message is exactly what should label it — and the
    // "Untitled" placeholder must not count as a name that blocks a later one.
    const seeded = touchRecentSession({
      agentName: "claude", cwd: "/repo", sessionId: "s1",
      title: "fix the flaky test please", lastActiveAt: "2026-06-10T01:00:00.000Z",
    }, true);
    expect(seeded[0].title).toBe("fix the flaky test please");

    touchRecentSession({
      agentName: "claude", cwd: "/repo", sessionId: "s2",
      title: "", lastActiveAt: "2026-06-10T02:00:00.000Z",
    }, true);
    const after = touchRecentSession({
      agentName: "claude", cwd: "/repo", sessionId: "s2",
      title: "and now it has a first message", lastActiveAt: "2026-06-10T03:00:00.000Z",
    }, true);
    expect(after.find((it) => it.sessionId === "s2")!.title).toBe("and now it has a first message");
  });

  test("hydrating ignores corrupt payloads", () => {
    expect(hydrateRecentSessions("{bad json" as unknown)).toEqual([]);
    expect(hydrateRecentSessions([{ agentName: "claude" }, null] as unknown)).toEqual([]);
    expect(readRecentSessions()).toEqual([]);
  });
});
