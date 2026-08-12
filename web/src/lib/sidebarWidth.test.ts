import { describe, expect, test, beforeEach, vi } from "vitest";
import {
  clampSidebarWidth, readSidebarWidth, saveSidebarWidth, isDesktopSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DESKTOP_SIDEBAR_QUERY,
} from "./sidebarWidth.ts";

describe("clampSidebarWidth", () => {
  test("keeps a width the window has room for", () => {
    expect(clampSidebarWidth(320, 1600)).toBe(320);
  });

  test("never leaves the chat column too narrow to read", () => {
    // 900px window: the sidebar may not take so much that the chat is a gutter.
    expect(clampSidebarWidth(470, 900)).toBe(900 - 460);
  });

  test("holds the floor even on a window with no room at all", () => {
    expect(clampSidebarWidth(400, 500)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(50, 1600)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test("caps at the maximum however wide the display is", () => {
    expect(clampSidebarWidth(3000, 5120)).toBe(MAX_SIDEBAR_WIDTH);
  });
});

describe("readSidebarWidth", () => {
  beforeEach(() => localStorage.clear());

  test("falls back to the default when nothing is stored", () => {
    expect(readSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  test("round-trips a width the drag committed", () => {
    saveSidebarWidth(360);
    expect(readSidebarWidth()).toBe(360);
  });

  test("stays independent of the file panel's stored width", () => {
    localStorage.setItem("acpg.filePanelWidth", "620");
    expect(readSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  test("junk in storage doesn't break the sidebar", () => {
    localStorage.setItem("acpg.sidebarWidth", "not a number");
    expect(readSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe("isDesktopSidebarWidth", () => {
  test("true at the column breakpoint, false below it", () => {
    const mq = vi.fn((query: string) => ({ matches: query === DESKTOP_SIDEBAR_QUERY }));
    vi.stubGlobal("matchMedia", mq);
    expect(isDesktopSidebarWidth()).toBe(true);

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    expect(isDesktopSidebarWidth()).toBe(false);
    vi.unstubAllGlobals();
  });

  test("no matchMedia (older embedder) reads as not-desktop", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isDesktopSidebarWidth()).toBe(false);
    vi.unstubAllGlobals();
  });
});
