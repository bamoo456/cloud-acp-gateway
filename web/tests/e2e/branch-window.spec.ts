import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// The branch window is a floating overlay: where it sits, that it stays inside
// the viewport when dragged, and that it becomes a full-screen sheet on a phone
// are all layout facts jsdom cannot answer (no layout engine), so the unit tests
// cover the store/render logic and this covers the browser half.

// Open the conversation menu and branch the open conversation.
async function branch(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("footer .cm-editor")).toBeVisible();
  await page.click('button[title="Conversation menu"]');
  await page.click(".arow:has-text('Branch conversation')");
  await expect(page.locator(".branch-win")).toBeVisible();
  // Both forms animate in (a slide-up sheet, a popped card). Measuring the box
  // mid-animation reads the start of the transform, not where it lands, so wait
  // the animation out before asserting on geometry.
  await page.locator(".branch-win").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

test("the branch window floats inside the viewport and drags without escaping it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("about:blank");
  await branch(page);

  const card = page.locator(".branch-win");
  // Its own composer, targeting the branch — not the app's, which is outside it.
  await expect(card.locator("footer .cm-editor")).toBeVisible();
  // The parent thread is still there behind it: the window floats over its
  // parent rather than replacing it.
  await expect(page.locator("#main")).toBeVisible();

  // It lives in the conversation column, clear of the file panel column beside
  // it — a card floating over that panel would be both wrong and unclickable.
  const column = (await page.locator(".content").boundingBox())!;
  const before = (await card.boundingBox())!;
  expect(before.x).toBeGreaterThanOrEqual(column.x);
  expect(before.x + before.width).toBeLessThanOrEqual(column.x + column.width + 1);
  // Nothing is on top of it: the header is what a click at that point hits.
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".branch-win") !== null,
    { x: before.x + 40, y: before.y + 20 });
  expect(hit).toBe(true);

  // Drag the header at the very corner of the viewport: the card wants to go
  // further left and up than there is room for, so this is the clamp under test.
  // (The pointer stays inside the viewport — a browser does not dispatch pointer
  // events at negative coordinates, so dragging "off screen" would test nothing.)
  const head = card.locator(".branch-win-head");
  const hb = (await head.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 10 });
  await page.mouse.up();

  const after = (await card.boundingBox())!;
  expect(after.x).toBeLessThan(before.x);            // it really moved
  expect(after.x).toBeCloseTo(column.x, 0);          // and stopped at its column's edge
  expect(after.y).toBeCloseTo(column.y, 0);

  // Escape closes it, and the branch survives as an ordinary conversation.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("on a phone the branch is a full-screen sheet over the thread", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("about:blank");
  await branch(page);

  const box = (await page.locator(".branch-win").boundingBox())!;
  // Sub-pixel tolerance: the sheet is sized by layout, not by integers.
  expect(box.width).toBeCloseTo(390, 0);
  expect(box.height).toBeCloseTo(844, 0);
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.y).toBeCloseTo(0, 0);
  // No drag handle at this width — the sheet is not a window you move around.
  await expect(page.locator(".branch-win-head")).toHaveCSS("cursor", "auto");
});
