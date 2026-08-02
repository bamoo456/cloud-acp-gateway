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
});
