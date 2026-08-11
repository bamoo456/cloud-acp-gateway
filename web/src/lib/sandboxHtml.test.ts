import { describe, expect, test } from "vitest";
import { sandboxHtml } from "./sandboxHtml.ts";

// The property that matters isn't "does the string contain <meta...>" — it's
// "does the browser actually treat it as a CSP", which requires it to be a
// real child of <head>. Parse it back out rather than pattern-match the string.
function cspMeta(html: string): Element | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
}

describe("sandboxHtml", () => {
  test("inserts right after an existing <head>", () => {
    const out = sandboxHtml("<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>");
    expect(cspMeta(out)).not.toBeNull();
    // The title survives untouched — this only inserts, never rewrites.
    expect(out).toContain("<title>t</title>");
  });

  test("adds a <head> after <html> when there isn't one", () => {
    const out = sandboxHtml("<html><body>hi</body></html>");
    expect(cspMeta(out)).not.toBeNull();
    expect(out).toContain("hi");
  });

  test("wraps a bare fragment with no <html> at all", () => {
    const out = sandboxHtml("<p>just a fragment</p>");
    expect(cspMeta(out)).not.toBeNull();
    expect(out).toContain("<p>just a fragment</p>");
  });

  test("a <head> with attributes still matches", () => {
    const out = sandboxHtml('<html><head lang="en"><title>t</title></head><body></body></html>');
    expect(cspMeta(out)).not.toBeNull();
  });

  test("case doesn't matter", () => {
    const out = sandboxHtml("<HTML><HEAD></HEAD><body>hi</body></HTML>");
    expect(cspMeta(out)).not.toBeNull();
  });

  test("the policy blocks network egress and framing", () => {
    const out = sandboxHtml("<html><head></head><body></body></html>");
    const content = cspMeta(out)!.getAttribute("content") ?? "";
    expect(content).toContain("connect-src 'none'");
    expect(content).toContain("frame-src 'none'");
    expect(content).toContain("form-action 'none'");
  });
});
