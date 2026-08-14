// How much of the agent's brand colour the reader wants to see
// (docs/ui-refactor-plan.md §1.2). Three modes, applied as `data-identity` on
// <html> and read by styles.css:
//
//   mono — the default. Identity is a mono wordmark; the screen has no brand
//          colour at all, so ink / amber / red / green each keep one meaning.
//   dot  — the wordmark plus a 7px block of the agent's colour, which helps
//          pick an agent out of a mixed list without tinting anything else.
//   hue  — the old behaviour, kept for anyone who wants it: the brand colour
//          takes over the accent again, including Allow / Send / Review.
//
// localStorage rather than the gateway's cross-device prefs, for the same
// reason the sessions view is local: it is a per-screen taste, not an account
// setting.
export type Identity = "mono" | "dot" | "hue";

export const IDENTITY_OPTIONS: Array<{ id: Identity; label: string; description: string }> = [
  { id: "mono", label: "Wordmark", description: "no brand colour anywhere" },
  { id: "dot", label: "Wordmark + dot", description: "the agent's colour, in 7px" },
  { id: "hue", label: "Full colour", description: "the agent tints buttons too" },
];

const KEY = "acpg.identity";

export function readIdentity(): Identity {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dot" || v === "hue" ? v : "mono";
  } catch {
    return "mono";
  }
}

// Write-through: there is no reason to ever store the choice without showing
// it, so one call does both. `mono` clears the attribute rather than setting it,
// which keeps the default state of <html> the plain one.
export function applyIdentity(value: Identity): void {
  try { localStorage.setItem(KEY, value); } catch { /* private mode / quota */ }
  if (typeof document === "undefined") return;
  if (value === "mono") delete document.documentElement.dataset.identity;
  else document.documentElement.dataset.identity = value;
}
