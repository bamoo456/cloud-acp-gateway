// The palette, as the reader's own choice (docs/ui-refactor/palette-compare.html
// is where the four were picked). Applied as `data-theme` on <html> and read by
// styles.css, which defines each one's neutral ramp for light AND dark — the
// theme chooses the ramp, the mode (below) chooses which end of it you get.
//
// "paper" is the default and sets no attribute, so an untouched install keeps
// exactly the tokens :root already declares.
//
// A chosen theme deliberately outranks the per-agent skin (styles.css puts the
// theme blocks after the skin blocks): switching agent must not repaint a page
// whose colours someone picked on purpose.
//
// localStorage rather than the gateway's cross-device prefs, for the same
// reason as the identity mode: a laptop in a bright room and a phone in bed
// want different answers.
export type Theme = "paper" | "slate" | "contrast" | "sepia";

// Light/dark is the other axis, and its own setting: the theme picks the ramp,
// the mode picks which end of it you get. "system" mirrors the OS (the old
// behaviour, still the default); "light"/"dark" pin it. Resolved here to a
// data-mode="dark" attribute (absence = light) so styles.css keys every dark
// block off one selector instead of a media query a setting can't override.
export type Mode = "system" | "light" | "dark";

export const MODE_OPTIONS: Array<{ id: Mode; label: string; description: string }> = [
  { id: "system", label: "System", description: "follow this device's setting" },
  { id: "light", label: "Light", description: "always the light palette" },
  { id: "dark", label: "Dark", description: "always the dark palette" },
];

const MODE_KEY = "acpg.mode";

export function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return MODE_OPTIONS.some((o) => o.id === v) ? v as Mode : "system";
  } catch {
    return "system";
  }
}

export function applyMode(value: Mode): void {
  try { localStorage.setItem(MODE_KEY, value); } catch { /* private mode / quota */ }
  if (typeof document === "undefined") return;
  const dark = value === "dark" ||
    (value === "system" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.dataset.mode = "dark";
  else delete document.documentElement.dataset.mode;
}

export const THEME_OPTIONS: Array<{ id: Theme; label: string; description: string }> = [
  { id: "paper", label: "Paper", description: "warm grey, the default" },
  { id: "slate", label: "Slate", description: "neutral, cooler — diffs read louder" },
  { id: "contrast", label: "Contrast", description: "white on black, deepened colours" },
  { id: "sepia", label: "Sepia", description: "warmer still, colours sat on the page" },
];

const KEY = "acpg.theme";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return THEME_OPTIONS.some((o) => o.id === v) ? v as Theme : "paper";
  } catch {
    return "paper";
  }
}

// Write-through, like applyIdentity: storing a choice without showing it has no
// use. "paper" clears the attribute rather than setting it.
export function applyTheme(value: Theme): void {
  try { localStorage.setItem(KEY, value); } catch { /* private mode / quota */ }
  if (typeof document === "undefined") return;
  if (value === "paper") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
}
