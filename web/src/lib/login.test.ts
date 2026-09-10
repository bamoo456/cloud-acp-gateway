import { describe, expect, it, vi, afterEach } from "vitest";
import { startLogin } from "./login.ts";

// The gateway answers 501 for an agent whose backing CLI it knows no login
// command for. Before this, startLogin ignored the status and the terminal then
// opened an SSE stream that failed with nothing to show — a dead Login button.
describe("startLogin", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("resolves quietly when the gateway accepts the start", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await expect(startLogin("claude")).resolves.toBeUndefined();
  });

  it("throws the gateway's error and hint on 501", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 501,
      json: () => Promise.resolve({
        error: 'no login command known for agent "cursor"',
        hint: "set ACPG_CURSOR_LOGIN_CMD",
      }),
    }));
    await expect(startLogin("cursor")).rejects.toThrow(
      /no login command known for agent "cursor" — set ACPG_CURSOR_LOGIN_CMD/,
    );
  });

  it("falls back to the status code when the body isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    }));
    await expect(startLogin("claude")).rejects.toThrow(/HTTP 502/);
  });
});
