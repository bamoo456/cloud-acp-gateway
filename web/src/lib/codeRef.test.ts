import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Answers re-render on every streamed chunk, so the same reference is looked
// at many times — the cache is what keeps that from being a request per token.
describe("resolveRef", () => {
  let resolveWorkspaceRef: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    resolveWorkspaceRef = vi.fn().mockResolvedValue({ abs: "/repo/src/app.ts", path: "src/app.ts" });
    vi.doMock("./api.ts", () => ({ resolveWorkspaceRef }));
  });

  afterEach(() => { vi.doUnmock("./api.ts"); vi.useRealTimers(); });

  test("asks the gateway once per (cwd, path), and answers later lookups synchronously", async () => {
    const { resolveRef, lookupRef } = await import("./codeRef.ts");
    expect(lookupRef("/repo", "src/app.ts")).toBeUndefined();

    const [a, b] = await Promise.all([resolveRef("/repo", "src/app.ts"), resolveRef("/repo", "src/app.ts")]);
    expect(a).toEqual({ abs: "/repo/src/app.ts", path: "src/app.ts" });
    expect(b).toBe(a);
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(1);

    expect(lookupRef("/repo", "src/app.ts")).toEqual(a);
    await resolveRef("/repo", "src/app.ts");
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(1);

    // A miss is an answer too — "e.g" recurs in every reply — but not for
    // good: the file may exist by the time the reference is rendered again.
    vi.useFakeTimers();
    resolveWorkspaceRef.mockResolvedValue(null);
    expect(await resolveRef("/repo", "e.g")).toBeNull();
    await resolveRef("/repo", "e.g");
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(lookupRef("/repo", "e.g")).toBeUndefined();
    await resolveRef("/repo", "e.g");
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(3);
    // Another folder is another question.
    await resolveRef("/other", "src/app.ts");
    expect(resolveWorkspaceRef).toHaveBeenLastCalledWith("/other", "src/app.ts");
  });
});
