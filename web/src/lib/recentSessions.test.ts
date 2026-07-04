import { describe, test, expect, beforeEach } from "vitest";
import {
  hydrateRecentSessions,
  readRecentSessions,
  touchRecentSession,
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

  test("hydrating ignores corrupt payloads", () => {
    expect(hydrateRecentSessions("{bad json" as unknown)).toEqual([]);
    expect(hydrateRecentSessions([{ agentName: "claude" }, null] as unknown)).toEqual([]);
    expect(readRecentSessions()).toEqual([]);
  });
});
