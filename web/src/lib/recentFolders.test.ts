import { describe, test, expect, beforeEach } from "vitest";
import {
  hydrateRecentFolders,
  readRecentFolders,
  touchRecentFolder,
} from "./recentFolders.ts";

describe("recent folder storage", () => {
  // Recents now live on the gateway, mirrored in an in-memory cache. Reset the
  // cache between tests (the module isn't reloaded) by hydrating it empty.
  beforeEach(() => {
    hydrateRecentFolders([]);
  });

  test("stores folders newest first and dedupes by path", () => {
    touchRecentFolder("/repo-a", "2026-06-10T01:00:00.000Z");
    touchRecentFolder("/repo-b", "2026-06-10T02:00:00.000Z");
    touchRecentFolder("/repo-a", "2026-06-10T03:00:00.000Z");

    expect(readRecentFolders()).toEqual([
      { path: "/repo-a", lastUsedAt: "2026-06-10T03:00:00.000Z" },
      { path: "/repo-b", lastUsedAt: "2026-06-10T02:00:00.000Z" },
    ]);
  });

  test("caps the list at 20 entries", () => {
    for (let i = 0; i < 25; i++) {
      touchRecentFolder(`/repo-${i}`, `2026-06-10T01:00:${String(i).padStart(2, "0")}.000Z`);
    }
    const list = readRecentFolders();
    expect(list).toHaveLength(20);
    expect(list[0].path).toBe("/repo-24");
  });

  test("hydrating ignores corrupt payloads", () => {
    expect(hydrateRecentFolders("{bad json" as unknown)).toEqual([]);
    expect(hydrateRecentFolders([{ path: 1 }, null, { lastUsedAt: "x" }] as unknown)).toEqual([]);
    expect(readRecentFolders()).toEqual([]);
  });
});
