import { describe, expect, test, beforeEach } from "vitest";
import {
  clampPanelWidth, readPanelWidth, savePanelWidth,
  DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH,
} from "./panelWidth.ts";

describe("clampPanelWidth", () => {
  test("keeps a width the window has room for", () => {
    expect(clampPanelWidth(520, 1600)).toBe(520);
  });

  test("never leaves the chat column too narrow to read", () => {
    // 1200px window: the panel may not take so much that the chat is a gutter.
    expect(clampPanelWidth(1100, 1200)).toBe(1200 - 460);
  });

  test("holds the floor even on a window with no room at all", () => {
    expect(clampPanelWidth(800, 500)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(50, 1600)).toBe(MIN_PANEL_WIDTH);
  });

  test("caps at the maximum however wide the display is", () => {
    expect(clampPanelWidth(3000, 5120)).toBe(MAX_PANEL_WIDTH);
  });
});

describe("readPanelWidth", () => {
  beforeEach(() => localStorage.clear());

  test("falls back to the default when nothing is stored", () => {
    expect(readPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  test("round-trips a width the drag committed", () => {
    savePanelWidth(560);
    expect(readPanelWidth()).toBe(560);
  });

  test("a width stored on a wider display is clamped, not thrown away", () => {
    savePanelWidth(880);
    // jsdom's window is 1024 wide, so 880 would leave the chat 144px.
    expect(readPanelWidth()).toBe(clampPanelWidth(880));
    expect(readPanelWidth()).toBeLessThan(880);
  });

  test("junk in storage doesn't break the panel", () => {
    localStorage.setItem("acpg.filePanelWidth", "not a number");
    expect(readPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });
});
