import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("global styles", () => {
  test("action menu stays within the viewport and scrolls", () => {
    const rule = cssRule(".amenu");

    expect(rule).toMatch(/max-height\s*:/);
    expect(rule).toMatch(/overflow-y\s*:\s*auto/);
  });

  test("chat content cannot widen the mobile viewport", () => {
    expect(cssRule(".thread")).toMatch(/width\s*:\s*min\(760px,\s*100%\)/);
    expect(cssRule(".thread")).toMatch(/min-width\s*:\s*0/);
    expect(cssRule(".turn.user .body")).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(cssRule(".turn")).toMatch(/max-width\s*:\s*100%/);
    expect(cssRule(".tool")).toMatch(/max-width\s*:\s*100%/);
    expect(cssRule(".diff")).toMatch(/max-width\s*:\s*100%/);
    expect(cssRule(".diff .path")).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  test("the crumb gives width to the path, and cuts the parents first", () => {
    // The connection moved to the status bar, so the crumb no longer has to
    // drop it on a phone — what it drops instead is the folder's parents, which
    // are context; the folder itself and the session title stay.
    expect(styles).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.crumb-path \.up\s*\{\s*display:\s*none;\s*\}/);
    expect(cssRule(".crumb-path b")).toMatch(/flex\s*:\s*0 0 auto/);
  });

  test("desktop columns reset the mobile sheet max-height", () => {
    // The mobile sheet rules cap #panel/#files with a 100dvh-based max-height;
    // the desktop column overrides set height: 100% but inherit that cap, which
    // leaves an overflow-hidden dead strip at the bottom of each column.
    expect(styles).toMatch(/@media \(min-width: 860px\)[\s\S]*?#panel \{[^}]*max-height:\s*none/);
    expect(styles).toMatch(/@media \(min-width: 1100px\)[\s\S]*?#files \{[^}]*max-height:\s*none/);
  });

  test("the expanded files panel fills the window instead of pinning left", () => {
    // A fixed box with inset:0 but the column rule's width still applied is
    // over-constrained: `right` is dropped and the panel lands 440px wide
    // against the left edge.
    const rule = cssRule("#files.expanded");

    expect(rule).toMatch(/position\s*:\s*fixed/);
    expect(rule).toMatch(/inset\s*:\s*0/);
    expect(rule).toMatch(/width\s*:\s*auto/);
    expect(rule).toMatch(/max-width\s*:\s*none/);
    expect(rule).toMatch(/max-height\s*:\s*none/);
  });

  test("button reset neutralizes native control appearance so icons center on iOS", () => {
    // iOS Safari renders native-appearance <button>s with internal content
    // insets and ignores grid/flex centering, which knocks the send arrow
    // off-center inside its circle. The reset must opt out of native styling.
    const rule = cssRule("button");

    expect(rule).toMatch(/-webkit-appearance\s*:\s*none/);
    expect(rule).toMatch(/(?<!-webkit-)appearance\s*:\s*none/);
  });

  test("send button glyph contrasts with the accent in every skin", () => {
    // The send button fills with --accent and draws its glyph in --accent-text.
    // Both derive from ink/on-ink, which derive from text/bg — so every skin and
    // both themes get a readable pair without an override of their own.
    const sendRule = cssRule(".send");

    expect(sendRule).toMatch(/background\s*:\s*var\(--accent\)/);
    expect(sendRule).toMatch(/color\s*:\s*var\(--accent-text\)/);
    // Stop is the same control outlined, not a fifth colour meaning.
    expect(cssRule(".send.stop")).toMatch(/background\s*:\s*transparent/);
    expect(cssRule(".send.stop")).toMatch(/color\s*:\s*var\(--text\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--ink\s*:\s*var\(--text\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--on-ink\s*:\s*var\(--bg\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--accent-text\s*:\s*var\(--on-ink\)/);
  });

  test("the primary action is ink and never takes the agent's hue", () => {
    // Allow / Send / Review are not agent-specific concepts, so the primary
    // action must not change colour with the answering agent (plan §1.1).
    const allowRule = cssRule(".perm .opts button.allow");

    expect(allowRule).toMatch(/background\s*:\s*var\(--permission-allow-bg\)/);
    expect(allowRule).toMatch(/color\s*:\s*var\(--permission-allow-text\)/);
    expect(allowRule).toMatch(/border-color\s*:\s*var\(--permission-allow-bg\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--accent\s*:\s*var\(--ink\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--permission-allow-bg\s*:\s*var\(--accent\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--permission-allow-text\s*:\s*var\(--accent-text\)/);
    // No skin may re-point the accent (or the Allow button) at a brand colour.
    for (const skin of ["codex", "opencode"]) {
      const blocks = styles.match(new RegExp(`\\[data-agent-skin="${skin}"\\]\\s*\\{[^}]*\\}`, "g")) ?? [];
      for (const block of blocks) {
        expect(block).not.toMatch(/--accent\s*:/);
        expect(block).not.toMatch(/--permission-allow/);
      }
    }
  });

  test('data-identity="hue" is the one way back to a per-agent accent', () => {
    // The old behaviour is kept, but behind an explicit opt-in rather than as
    // the default (plan §1.2).
    const hue = cssRule(':root[data-identity="hue"]');

    expect(hue).toMatch(/--accent\s*:\s*var\(--agent-color/);
    expect(hue).toMatch(/--accent-text\s*:\s*#fff/);
  });

  test("exactly one bar reserves the home-indicator inset", () => {
    // Three stacked bars each adding env(safe-area-inset-bottom) is ~100px of
    // dead space on an iPhone. Whichever one is last owns it: the tab bar on a
    // phone, the status bar (or the terminal) from the desktop breakpoint up.
    // (the bare `.tabbar` rule only hides it; the one that matters is the
    // phone-breakpoint one that turns it on)
    expect(styles).toMatch(/\.tabbar \{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/);
    expect(styles).toMatch(/@media \(max-width: 859px\) \{\s*\.statusbar, \.term-panel \{ padding-bottom: 0/);
    expect(cssRule("#root:has(.statusbar) footer")).toMatch(/padding-bottom:\s*8px/);
  });

  test("green means diff + and nothing else", () => {
    // --ok is the diff-added colour. Anything else wearing it (a healthy
    // connection, a copied confirmation, an agent tick) is a second meaning for
    // the same colour, which is what plan §1.1 removes.
    const allowed = [
      ".diff .add::before", ".wf-mark.wf-git.added, .wf-mark.wf-git.untracked",
      ".wf-counts .add", ".udiff-stat .add", ".udiff-row.add .sign",
      ".statusbar .sb-seg b.add", ".wf-stat b.add",
    ];
    const offenders = styles.split("\n")
      .filter((line) => line.includes("var(--ok)"))
      .filter((line) => !allowed.some((sel) => line.includes(sel)))
      // the token's own declaration
      .filter((line) => !/--ok\s*:/.test(line));

    expect(offenders).toEqual([]);
  });

  test("a finished tool call is silent — no badge, no colour", () => {
    expect(cssRule(".tool .tstatus.completed")).toMatch(/display\s*:\s*none/);
    // Amber is "needs you"; a running tool is ink.
    expect(cssRule(".tool .tstatus.in_progress, .tool .tstatus.pending")).toMatch(/color\s*:\s*var\(--text\)/);
    expect(cssRule(".tool .tstatus")).not.toMatch(/background\s*:/);
  });

  test("nothing outside the identity dot is tinted by --agent-color", () => {
    // The chat column's 3px rail and the composer's ring both used to carry it.
    // Only the .idot and the explicit "hue" opt-in may read the agent's colour.
    const tinted = [...styles.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, , body]) => body.includes("var(--agent-color"))
      .map(([, selector]) => selector.trim().split("\n").pop()!.trim());

    expect(tinted.sort()).toEqual(['.idot', ':root[data-identity="hue"]']);
  });
});
