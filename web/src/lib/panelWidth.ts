// How wide the file panel is, on this device.
//
// Deliberately localStorage and NOT the cross-device `/prefs` store the text
// size and lock settings use. Those are preferences about the person; this is a
// measurement of the screen in front of them, and a width chosen on a 27" display
// is the wrong width on a laptop. Nothing is lost if it doesn't travel.

const KEY = "acpg.filePanelWidth";

// Below MIN the two-line file rows wrap into nonsense. The upper bound is
// computed rather than fixed: what matters is that the chat column keeps enough
// room to stay readable, which depends on the window, not on a constant.
export const MIN_PANEL_WIDTH = 300;
export const MAX_PANEL_WIDTH = 900;
const MIN_CHAT_WIDTH = 460;

export const DEFAULT_PANEL_WIDTH = 440;

// Below this the file panel is an overlay sheet rather than a column — the
// same breakpoint the stylesheet uses. Shared so the store's "open by
// default on desktop" check and the panel's own column-vs-sheet layout can't
// drift apart into two different widths meaning "desktop".
export const DESKTOP_PANEL_QUERY = "(min-width: 1100px)";

export function isDesktopPanelWidth(): boolean {
  return window.matchMedia?.(DESKTOP_PANEL_QUERY).matches ?? false;
}

export function clampPanelWidth(px: number, viewport = window.innerWidth): number {
  const ceiling = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewport - MIN_CHAT_WIDTH));
  return Math.round(Math.min(Math.max(px, MIN_PANEL_WIDTH), ceiling));
}

export function readPanelWidth(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    // A stored width from a wider window is clamped on read, not discarded —
    // the intent ("wide") survives moving to a smaller screen.
    return Number.isFinite(raw) && raw > 0 ? clampPanelWidth(raw) : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH; // private mode, or storage disabled
  }
}

export function savePanelWidth(px: number): void {
  try { localStorage.setItem(KEY, String(Math.round(px))); } catch { /* not worth failing a drag over */ }
}
