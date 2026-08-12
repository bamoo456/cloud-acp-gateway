// How wide the sessions sidebar is, on this device. Same storage rationale as
// panelWidth.ts: a screen measurement, not a person preference.

import { makePanelWidth } from "./panelWidth.ts";

// Below MIN the session titles truncate into nonsense; MAX keeps the column a
// list, not a second reading pane. 284 is the stylesheet's fixed column width,
// kept as the untouched default.
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 284;

// Where #panel becomes a persistent left column — the stylesheet's breakpoint,
// NOT the file panel's 1100px (that one is about the right column only).
export const DESKTOP_SIDEBAR_QUERY = "(min-width: 860px)";

const sidebar = makePanelWidth({
  key: "acpg.sidebarWidth",
  min: MIN_SIDEBAR_WIDTH,
  max: MAX_SIDEBAR_WIDTH,
  fallback: DEFAULT_SIDEBAR_WIDTH,
  query: DESKTOP_SIDEBAR_QUERY,
});

export const clampSidebarWidth = sidebar.clamp;
export const readSidebarWidth = sidebar.read;
export const saveSidebarWidth = sidebar.save;
export const isDesktopSidebarWidth = sidebar.isDesktop;
