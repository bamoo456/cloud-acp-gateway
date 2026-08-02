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
    expect(o.since).toBe(new Date("2026-07-01").toISOString());
    expect(o.until).toBeUndefined();
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
