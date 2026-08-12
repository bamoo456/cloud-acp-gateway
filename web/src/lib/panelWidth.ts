// How wide the file panel is, on this device.
//
// Deliberately localStorage and NOT the cross-device `/prefs` store the text
// size and lock settings use. Those are preferences about the person; this is a
// measurement of the screen in front of them, and a width chosen on a 27" display
// is the wrong width on a laptop. Nothing is lost if it doesn't travel.

// Whatever a panel takes, the chat column must keep enough room to stay
// readable — shared by every panel instance, since it is a property of the
// chat, not of any one panel.
const MIN_CHAT_WIDTH = 460;

export interface PanelWidthSpec {
  key: string;      // localStorage key
  min: number;      // below this the panel's rows wrap into nonsense
  max: number;      // cap however wide the display is
  fallback: number; // width before the user has ever dragged
  query: string;    // the stylesheet's column-vs-sheet breakpoint
}

export function makePanelWidth(spec: PanelWidthSpec) {
  const clamp = (px: number, viewport = window.innerWidth): number => {
    // The upper bound is computed rather than fixed: what matters is that the
    // chat column keeps enough room, which depends on the window, not on a
    // constant. Only this panel's width counts against the window — the other
    // panel's is deliberately ignored, on both sides.
    const ceiling = Math.max(spec.min, Math.min(spec.max, viewport - MIN_CHAT_WIDTH));
    return Math.round(Math.min(Math.max(px, spec.min), ceiling));
  };
  return {
    clamp,
    read(): number {
      try {
        const raw = Number(localStorage.getItem(spec.key));
        // A stored width from a wider window is clamped on read, not discarded —
        // the intent ("wide") survives moving to a smaller screen.
        return Number.isFinite(raw) && raw > 0 ? clamp(raw) : spec.fallback;
      } catch {
        return spec.fallback; // private mode, or storage disabled
      }
    },
    save(px: number): void {
      try { localStorage.setItem(spec.key, String(Math.round(px))); } catch { /* not worth failing a drag over */ }
    },
    isDesktop(): boolean {
      return window.matchMedia?.(spec.query).matches ?? false;
    },
  };
}

export const MIN_PANEL_WIDTH = 300;
export const MAX_PANEL_WIDTH = 900;

export const DEFAULT_PANEL_WIDTH = 440;

// Below this the file panel is an overlay sheet rather than a column — the
// same breakpoint the stylesheet uses. Shared so the store's "open by
// default on desktop" check and the panel's own column-vs-sheet layout can't
// drift apart into two different widths meaning "desktop".
export const DESKTOP_PANEL_QUERY = "(min-width: 1100px)";

const filePanel = makePanelWidth({
  key: "acpg.filePanelWidth",
  min: MIN_PANEL_WIDTH,
  max: MAX_PANEL_WIDTH,
  fallback: DEFAULT_PANEL_WIDTH,
  query: DESKTOP_PANEL_QUERY,
});

export const clampPanelWidth = filePanel.clamp;
export const readPanelWidth = filePanel.read;
export const savePanelWidth = filePanel.save;
export const isDesktopPanelWidth = filePanel.isDesktop;
