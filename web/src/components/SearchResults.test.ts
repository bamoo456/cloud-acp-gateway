import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { SearchResponse } from "../lib/api.ts";

const envelope = (over: Partial<SearchResponse> = {}): SearchResponse => ({
  results: [{
    sessionId: "s1", source: "claude-cli", agentName: "claude", cwd: "/Users/me/repo",
    title: "Timeline work", updatedAt: "2026-08-01T00:00:00.000Z", hitCount: 4,
    hits: [{ index: 12, role: "user", snippet: "make the timeline liquid glass", offsets: [[18, 24]] }],
  }],
  truncated: false, cursor: null, skipped: [], scanned: { files: 1, bytes: 1, ms: 1 },
  ...over,
});

describe("SearchResults", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => { act(() => root?.unmount()); container.remove(); });

  const mount = async (props: Record<string, unknown>) => {
    const { SearchResults } = await import("./SearchResults.tsx");
    await act(async () => { root = createRoot(container); root.render(React.createElement(SearchResults, props as never)); });
  };

  test("renders a hit with the matched span marked", async () => {
    await mount({ response: envelope(), loading: false, rangeExplicit: false, onOpen: vi.fn(), onSearchAll: vi.fn(), onSearchOlder: vi.fn() });
    expect(container.textContent).toContain("Timeline work");
    expect(container.textContent).toContain("repo");
    expect(container.querySelector("mark")?.textContent).toBe("liquid");
  });

  test("opening a hit passes the session and its message index", async () => {
    const onOpen = vi.fn();
    await mount({ response: envelope(), loading: false, rangeExplicit: false, onOpen, onSearchAll: vi.fn(), onSearchOlder: vi.fn() });
    await act(async () => { container.querySelector<HTMLButtonElement>(".search-hit")!.click(); });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), 12);
  });

  test("truncated with no explicit range offers Search all", async () => {
    const onSearchAll = vi.fn(), onSearchOlder = vi.fn();
    await mount({ response: envelope({ truncated: true, cursor: "c1" }), loading: false, rangeExplicit: false, onOpen: vi.fn(), onSearchAll, onSearchOlder });
    await act(async () => { container.querySelector<HTMLButtonElement>(".search-more")!.click(); });
    expect(onSearchAll).toHaveBeenCalled();
    expect(onSearchOlder).not.toHaveBeenCalled();
  });

  test("truncated within an explicit range offers Continue older instead", async () => {
    const onSearchAll = vi.fn(), onSearchOlder = vi.fn();
    await mount({ response: envelope({ truncated: true, cursor: "c1" }), loading: false, rangeExplicit: true, onOpen: vi.fn(), onSearchAll, onSearchOlder });
    await act(async () => { container.querySelector<HTMLButtonElement>(".search-more")!.click(); });
    expect(onSearchOlder).toHaveBeenCalled();
    expect(onSearchAll).not.toHaveBeenCalled();
  });

  test("reports when a configured agent could not be searched", async () => {
    await mount({ response: envelope({ skipped: ["opencode"] }), loading: false, rangeExplicit: false, onOpen: vi.fn(), onSearchAll: vi.fn(), onSearchOlder: vi.fn() });
    expect(container.textContent).toContain("opencode");
  });

  // The two zero-result shapes below are the ones an early return on
  // `results.length === 0` swallowed: `skipped` exists precisely to explain a
  // thin result set, and a scan that spends its whole budget without matching
  // is a dead end unless the resume cursor is still reachable.
  const emptyPage = (over: Partial<SearchResponse> = {}) => envelope({ results: [], ...over });

  test("an empty result set still reports the agent that could not be searched", async () => {
    await mount({ response: emptyPage({ skipped: ["opencode"] }), loading: false, rangeExplicit: false, onOpen: vi.fn(), onSearchAll: vi.fn(), onSearchOlder: vi.fn() });
    expect(container.textContent).toContain("No messages match.");
    expect(container.textContent).toContain("opencode");
  });

  test("an empty page that ran out of budget still offers the resume escape", async () => {
    const onSearchOlder = vi.fn();
    await mount({ response: emptyPage({ truncated: true, cursor: "c1" }), loading: false, rangeExplicit: true, onOpen: vi.fn(), onSearchAll: vi.fn(), onSearchOlder });
    expect(container.querySelector(".search-more")!.textContent).toBe("繼續搜更早");
    await act(async () => { container.querySelector<HTMLButtonElement>(".search-more")!.click(); });
    expect(onSearchOlder).toHaveBeenCalled();
  });

  // The recency window is a scan budget, not a corpus boundary: finding nothing
  // inside the default window must not read as "it isn't there".
  test("no results inside the default window offers to widen to everything", async () => {
    const onSearchAll = vi.fn();
    await mount({ response: emptyPage(), loading: false, rangeExplicit: false, onOpen: vi.fn(), onSearchAll, onSearchOlder: vi.fn() });
    expect(container.querySelector(".search-more")!.textContent).toBe("搜尋全部");
    await act(async () => { container.querySelector<HTMLButtonElement>(".search-more")!.click(); });
    expect(onSearchAll).toHaveBeenCalled();
  });

  test("no results inside a range the user picked offers no widening", async () => {
    await mount({ response: emptyPage(), loading: false, rangeExplicit: true, onOpen: vi.fn(), onSearchAll: vi.fn(), onSearchOlder: vi.fn() });
    expect(container.textContent).toContain("No messages match.");
    expect(container.querySelector(".search-more")).toBeNull();
  });

  // Truncation already owns the widening button; the empty-state affordance must
  // not stack a second identical one underneath it.
  test("an empty truncated default-window page offers exactly one escape", async () => {
    await mount({ response: emptyPage({ truncated: true, cursor: "c1" }), loading: false, rangeExplicit: false, onOpen: vi.fn(), onSearchAll: vi.fn(), onSearchOlder: vi.fn() });
    expect(container.querySelectorAll(".search-more")).toHaveLength(1);
    expect(container.querySelector(".search-more")!.textContent).toBe("搜尋全部");
  });
});
