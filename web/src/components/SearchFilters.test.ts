import { describe, test, expect } from "vitest";
import { filtersToOptions, DEFAULT_FILTERS } from "./SearchFilters.tsx";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");

describe("filtersToOptions", () => {
  test("defaults send no explicit bounds — the server's 14-day default applies", () => {
    expect(filtersToOptions(DEFAULT_FILTERS, "/repo", NOW)).toEqual({});
  });

  test("30d sends an explicit since", () => {
    const o = filtersToOptions({ ...DEFAULT_FILTERS, window: "30d" }, "/repo", NOW);
    expect(o.since).toBe(new Date(NOW - 30 * 86400000).toISOString());
    expect(o.all).toBeUndefined();
  });

  test("all sends all=1 and no since", () => {
    const o = filtersToOptions({ ...DEFAULT_FILTERS, window: "all" }, "/repo", NOW);
    expect(o.all).toBe(true);
    expect(o.since).toBeUndefined();
  });

  test("custom sends both bounds and ignores a blank one", () => {
    const o = filtersToOptions({ ...DEFAULT_FILTERS, window: "custom", since: "2026-07-01", until: "" }, "/repo", NOW);
    // The user picked a day on THEIR calendar, so the bound is local midnight —
    // asserted as calendar fields so this holds in every timezone the console runs in.
    const since = new Date(o.since!);
    expect([since.getFullYear(), since.getMonth(), since.getDate()]).toEqual([2026, 6, 1]);
    expect([since.getHours(), since.getMinutes(), since.getSeconds()]).toEqual([0, 0, 0]);
    expect(o.until).toBeUndefined();
  });

  // The server's `until` is an INCLUSIVE upper bound (`recencyMs > untilMs` skips,
  // src/gateway.ts:1279), so a bound at the start of the chosen day would return
  // nothing from that day — a filter that reads as broken.
  test("a custom until covers the whole day it names, not just its first instant", () => {
    const o = filtersToOptions({ ...DEFAULT_FILTERS, window: "custom", since: "2026-07-01", until: "2026-07-15" }, "/repo", NOW);
    const until = new Date(o.until!);
    expect([until.getFullYear(), until.getMonth(), until.getDate()]).toEqual([2026, 6, 15]);
    expect([until.getHours(), until.getMinutes(), until.getSeconds()]).toEqual([23, 59, 59]);
    // Something that happened late on the 15th must still fall under the bound.
    expect(Date.parse(o.until!)).toBeGreaterThan(new Date(2026, 6, 15, 23, 30).getTime());
  });

  test("a malformed custom date is dropped rather than sent as an invalid bound", () => {
    const o = filtersToOptions({ ...DEFAULT_FILTERS, window: "custom", since: "2026-07-01", until: "nonsense" }, "/repo", NOW);
    expect(o.until).toBeUndefined();
    expect(o.since).toBeDefined();
  });

  test("folderOnly scopes to the current cwd and mineOnly restricts the role", () => {
    const o = filtersToOptions({ ...DEFAULT_FILTERS, folderOnly: true, mineOnly: true }, "/repo", NOW);
    expect(o.cwd).toBe("/repo");
    expect(o.role).toBe("user");
  });

  test("an agent choice is forwarded, and the all-agents choice is not", () => {
    expect(filtersToOptions({ ...DEFAULT_FILTERS, agent: "codex" }, "/repo", NOW).agent).toBe("codex");
    expect(filtersToOptions(DEFAULT_FILTERS, "/repo", NOW).agent).toBeUndefined();
  });
});
