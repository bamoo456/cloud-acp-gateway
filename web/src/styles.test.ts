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
    expect(cssRule(".msg.user .bubble")).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(cssRule(".msg.assistant")).toMatch(/max-width\s*:\s*100%/);
    expect(cssRule(".tool")).toMatch(/max-width\s*:\s*100%/);
    expect(cssRule(".diff")).toMatch(/max-width\s*:\s*100%/);
    expect(cssRule(".diff .path")).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  test("mobile header gives width priority to navigation and the folder chip", () => {
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*header \.conn\s*\{\s*display:\s*none;\s*\}/);
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
    // codex-dark's accent is near-white, so the glyph must flip dark there or
    // the arrow disappears into the circle.
    const sendRule = cssRule(".send");

    expect(sendRule).toMatch(/background\s*:\s*var\(--accent\)/);
    expect(sendRule).toMatch(/color\s*:\s*var\(--accent-text\)/);
    expect(cssRule(".send.stop")).toMatch(/color\s*:\s*var\(--bg\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--accent-text\s*:\s*#fff/);
    expect(styles).toMatch(/data-agent-skin="codex"[\s\S]*--accent\s*:\s*#ededea[\s\S]*--accent-text\s*:\s*var\(--bg\)/);
  });

  test("permission allow buttons use dedicated readable colors", () => {
    const allowRule = cssRule(".perm .opts button.allow");

    expect(allowRule).toMatch(/background\s*:\s*var\(--permission-allow-bg\)/);
    expect(allowRule).toMatch(/color\s*:\s*var\(--permission-allow-text\)/);
    expect(allowRule).toMatch(/border-color\s*:\s*var\(--permission-allow-bg\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--permission-allow-bg\s*:\s*var\(--agent-color,\s*var\(--accent\)\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*--permission-allow-text\s*:\s*#fff/);
    expect(styles).toMatch(/:root\[data-agent-skin="codex"\]\s*\{[\s\S]*--permission-allow-bg\s*:\s*var\(--agent-codex\)/);
  });

  test("opencode skin uses a neutral accent, not the default orange", () => {
    // opencode's brand is a near-black / near-white neutral; the default
    // --accent is the claude orange, so the opencode skin must override it
    // (otherwise every opencode session renders with the orange accent).
    expect(styles).toMatch(/data-agent-skin="opencode"[\s\S]*--accent\s*:\s*#1f1e1d[\s\S]*--permission-allow-bg\s*:\s*var\(--agent-opencode\)/);
    expect(styles).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*data-agent-skin="opencode"[\s\S]*--accent\s*:\s*#eeede9/);
  });
});
