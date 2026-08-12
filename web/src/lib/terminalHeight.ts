// How tall the bottom-docked terminal panel is, on this device.
//
// Deliberately localStorage and NOT the cross-device `/prefs` store the text
// size and lock settings use — same rationale as panelWidth.ts: this is a
// measurement of the screen in front of the person, not a preference about
// them, so nothing is lost if it doesn't travel.

// However tall the terminal gets, the app above it (topbar + thread +
// composer) must keep enough room to stay usable.
const MIN_CONTENT_HEIGHT = 200;

export const MIN_TERMINAL_HEIGHT = 160;
export const MAX_TERMINAL_HEIGHT = 900;
export const DEFAULT_TERMINAL_HEIGHT = 320;

const KEY = "acpg.terminalHeight";

export function clampTerminalHeight(px: number, viewport: number = window.innerHeight): number {
  const ceiling = Math.max(MIN_TERMINAL_HEIGHT, Math.min(MAX_TERMINAL_HEIGHT, viewport - MIN_CONTENT_HEIGHT));
  return Math.round(Math.min(Math.max(px, MIN_TERMINAL_HEIGHT), ceiling));
}

export function readTerminalHeight(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    // A stored height from a taller window is clamped on read, not discarded —
    // the intent ("tall") survives moving to a shorter screen.
    return Number.isFinite(raw) && raw > 0 ? clampTerminalHeight(raw) : DEFAULT_TERMINAL_HEIGHT;
  } catch {
    return DEFAULT_TERMINAL_HEIGHT; // private mode, or storage disabled
  }
}

export function saveTerminalHeight(px: number): void {
  try { localStorage.setItem(KEY, String(Math.round(px))); } catch { /* not worth failing a drag over */ }
}
