import { describe, test, expect, vi, afterEach } from "vitest";
import {
  getHistory, getMessages, getDiscoveredHistory, listDir, getRunning, getInboxPending, putLockConfig, searchSessions,
} from "./api.ts";

function mockFetch(json: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(json) } as Response);
}
function lastFetchUrl(): string {
  return String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0]);
}
function mockResponse(response: Partial<Response>) {
  globalThis.fetch = vi.fn().mockResolvedValue(response as Response);
}
afterEach(() => vi.restoreAllMocks());

describe("api", () => {
  test("getHistory returns sessions array and builds the right URL", async () => {
    mockFetch({ sessions: [{ sessionId: "a", title: "T", updatedAt: "2026-01-01T00:00:00Z" }] });
    const out = await getHistory("claude", "/cwd");
    expect(out).toEqual([{ sessionId: "a", title: "T", updatedAt: "2026-01-01T00:00:00Z" }]);
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/history?agent=claude");
    expect(url).toContain("cwd=%2Fcwd");
    expect(url).toContain("limit=30");
  });

  test("getHistory returns [] when the field is missing", async () => {
    mockFetch({});
    expect(await getHistory("claude", "/x")).toEqual([]);
  });

  test("getDiscoveredHistory returns cwd-bearing sessions and builds the right URL", async () => {
    mockFetch({ sessions: [{ sessionId: "cli1", title: "CLI work", updatedAt: "2026-01-01T00:00:00Z", cwd: "/repo", source: "claude-cli" }] });
    const out = await getDiscoveredHistory("claude", 12);
    expect(out).toEqual([{ sessionId: "cli1", title: "CLI work", updatedAt: "2026-01-01T00:00:00Z", cwd: "/repo", source: "claude-cli" }]);
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/history/discovered?agent=claude");
    expect(url).toContain("limit=12");
  });

  test("getMessages returns the full payload", async () => {
    mockFetch({ messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }], total: 1, truncated: false });
    const r = await getMessages("claude", "/cwd", "sid");
    expect(r.messages).toHaveLength(1);
    expect(r.truncated).toBe(false);
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("/history/messages?agent=claude");
    expect(url).toContain("session=sid");
  });

  test("getMessages requests a tail page by default and reports where it starts", async () => {
    mockFetch({
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      total: 51, start: 50, truncated: true,
    });

    const r = await getMessages("claude", "/repo", "s1");

    expect(lastFetchUrl()).toContain("limit=50");
    expect(lastFetchUrl()).not.toContain("from=");
    expect(r.start).toBe(50);
    expect(r.total).toBe(51);
  });

  test("getMessages requests an absolute range when given one", async () => {
    mockFetch({ messages: [], total: 51, start: 10, truncated: true });

    await getMessages("claude", "/repo", "s1", { from: 10, to: 60 });

    expect(lastFetchUrl()).toContain("from=10");
    expect(lastFetchUrl()).toContain("to=60");
  });

  test("getMessages treats a gateway without paging support as fully loaded", async () => {
    mockFetch({ messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }], total: 1, truncated: false });

    const r = await getMessages("claude", "/repo", "s1");

    expect(r.start).toBe(0);
  });

  test("getMessages reports unavailable history instead of parsing an empty error body", async () => {
    mockResponse({ ok: false, status: 404, text: () => Promise.resolve("") });

    await expect(getMessages("codex", "/cwd", "missing")).rejects.toThrow(
      "Conversation history isn't available for this session yet.",
    );
  });

  test("getRunning passes the gateway-reported cwd through", async () => {
    mockResponse({ ok: true, json: () => Promise.resolve({ tasks: [{ agentName: "claude", sessionId: "s", state: "active", cwd: "/proj" }] }) });
    const tasks = await getRunning();
    expect(tasks).toEqual([{ agentName: "claude", sessionId: "s", state: "active", cwd: "/proj" }]);
  });

  test("getRunning yields no tasks when the gateway is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await getRunning()).toEqual([]);
  });

  test("getInboxPending returns an authoritative empty list on a successful empty response", async () => {
    mockResponse({ ok: true, json: () => Promise.resolve({ items: [] }) });
    expect(await getInboxPending()).toEqual([]);
  });

  test("getInboxPending returns null when pending state is unknown", async () => {
    mockResponse({ ok: false, status: 503 });
    expect(await getInboxPending()).toBeNull();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await getInboxPending()).toBeNull();
  });

  test("listDir returns the fs payload", async () => {
    mockFetch({ root: "/r", path: "/r/a", parent: "/r", dirs: [{ name: "x", git: true }] });
    const r = await listDir("/r/a");
    expect(r.path).toBe("/r/a");
    expect(r.dirs[0]).toEqual({ name: "x", git: true });
  });

  test("putLockConfig keeps lock preference writes alive across refresh", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    await putLockConfig(JSON.stringify({ saltB64: "s", hashB64: "h", iterations: 1 }));
    await putLockConfig(null);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/prefs/lock?config="),
      { method: "POST", keepalive: true },
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/prefs/lock"),
      { method: "DELETE", keepalive: true },
    );
  });

  test("searchSessions builds the query string and maps the envelope", async () => {
    mockFetch({
      results: [{ sessionId: "s1", source: "claude-cli", agentName: "claude", cwd: "/repo",
                  title: "T", updatedAt: "2026-08-01T00:00:00.000Z", hitCount: 2,
                  hits: [{ index: 7, role: "user", snippet: "…needle…", offsets: [[1, 7]] }] }],
      truncated: true, cursor: "abc", skipped: ["opencode"],
      scanned: { files: 3, bytes: 10, ms: 4 },
    });

    const r = await searchSessions("liquid glass", { all: true, agent: "claude", role: "user", cursor: "abc", limit: 20 });

    const url = lastFetchUrl();
    expect(url).toContain("/history/search?q=liquid%20glass");
    expect(url).toContain("&all=1");
    expect(url).toContain("&agent=claude");
    expect(url).toContain("&role=user");
    expect(url).toContain("&cursor=abc");
    expect(url).toContain("&limit=20");
    expect(r.results[0].hits[0].index).toBe(7);
    expect(r.truncated).toBe(true);
  });

  test("searchSessions omits absent filters and degrades to an empty envelope", async () => {
    mockFetch({});
    const r = await searchSessions("needle");
    expect(r.results).toEqual([]);
    expect(r.cursor).toBeNull();
  });

  test("searchSessions degrades wrong-typed but truthy fields instead of passing them through", async () => {
    mockFetch({
      results: "oops",
      skipped: { not: "an array" },
      scanned: "oops",
    });
    const r = await searchSessions("needle");
    expect(r.results).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.scanned).toEqual({ files: 0, bytes: 0, ms: 0 });
  });

  test("searchSessions fills in only the missing fields of a partial scanned object", async () => {
    mockFetch({ scanned: { files: 3 } });
    const r = await searchSessions("needle");
    expect(r.scanned).toEqual({ files: 3, bytes: 0, ms: 0 });
  });

  test("searchSessions fills in a missing per-result hits array", async () => {
    mockFetch({
      results: [{ sessionId: "s1", source: "claude-cli", agentName: "claude", cwd: "/repo",
                  title: "T", updatedAt: "2026-08-01T00:00:00.000Z", hitCount: 0 }],
    });
    const r = await searchSessions("needle");
    expect(r.results[0].hits).toEqual([]);
  });
});
