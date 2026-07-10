import { describe, test, expect, vi, afterEach } from "vitest";
import { getHistory, getMessages, getDiscoveredHistory, listDir, getRunning, putLockConfig } from "./api.ts";

function mockFetch(json: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(json) } as Response);
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
});
