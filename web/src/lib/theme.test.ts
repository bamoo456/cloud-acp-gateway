import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyMode, readMode } from "./theme.ts";

describe("colour mode", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.mode;
  });

  const stubSystemDark = (matches: boolean) =>
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches }));

  test("defaults to system, and junk in storage reads as system too", () => {
    expect(readMode()).toBe("system");
    localStorage.setItem("acpg.mode", "hotdog");
    expect(readMode()).toBe("system");
  });

  test("system resolves through the OS preference", () => {
    stubSystemDark(true);
    applyMode("system");
    expect(document.documentElement.dataset.mode).toBe("dark");

    stubSystemDark(false);
    applyMode("system");
    expect(document.documentElement.dataset.mode).toBeUndefined();
  });

  test("a pinned mode ignores the OS and round-trips through storage", () => {
    stubSystemDark(false);
    applyMode("dark");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(readMode()).toBe("dark");

    stubSystemDark(true);
    applyMode("light");
    expect(document.documentElement.dataset.mode).toBeUndefined();
    expect(readMode()).toBe("light");
  });

  test("no matchMedia (older embedder) reads system as light", () => {
    vi.stubGlobal("matchMedia", undefined);
    applyMode("system");
    expect(document.documentElement.dataset.mode).toBeUndefined();
  });
});
