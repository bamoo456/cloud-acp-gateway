import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// The branch window is a floating overlay: where it sits, that it stays inside
// the viewport when dragged, and that it becomes a full-screen sheet on a phone
// are all layout facts jsdom cannot answer (no layout engine), so the unit tests
// cover the store/render logic and this covers the browser half.

// Branch the open conversation from the button beside send. Two clicks: the
// first arms the confirm, the second forks.
async function branch(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("footer .cm-editor")).toBeVisible();
  const btn = page.locator("footer .branch-btn");
  await btn.click();
  await expect(page.locator(".branch-hint")).toBeVisible();
  await expect(page.locator(".branch-win")).toBeHidden(); // one click does not fork
  await btn.click();
  await expect(page.locator(".branch-win")).toBeVisible();
  // The window opens optimistically, on a provisional session, and swaps in the
  // real one when session/fork answers — wait for the composer that replaces the
  // waiting strip, or every geometry assert below races that swap.
  await expect(page.locator(".branch-win footer .cm-editor")).toBeVisible();
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
  // The parent thread is still there behind it: the window floats over its
  // parent rather than replacing it.
  await expect(page.locator("#main")).toBeVisible();

  const before = (await card.boundingBox())!;
  expect(before.x + before.width).toBeLessThanOrEqual(1280);
  expect(before.y + before.height).toBeLessThanOrEqual(900);
  // Global floating: it defaults over the file panel column (open at this width)
  // and is the topmost thing there — anchored under the panels instead, it took
  // no clicks at all.
  const panel = (await page.locator("#files").boundingBox())!;
  expect(before.x + before.width).toBeGreaterThan(panel.x);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".branch-win") !== null,
    { x: before.x + 40, y: before.y + 20 });
  expect(hit).toBe(true);

  // Drag the header to the very corner of the viewport: the card wants to go
  // further left and up than there is room for, so this is the clamp under test.
  // Landing there also proves the drag is not confined to the chat column — it
  // ends up over the sessions list.
  // (The pointer stays inside the viewport — a browser does not dispatch pointer
  // events at negative coordinates, so dragging "off screen" would test nothing.)
  const head = card.locator(".branch-win-head");
  const hb = (await head.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 10 });
  await page.mouse.up();

  const after = (await card.boundingBox())!;
  expect(after.x).toBeLessThan(before.x);   // it really moved
  expect(after.x).toBeCloseTo(0, 0);        // and stopped at the viewport edge
  expect(after.y).toBeCloseTo(0, 0);
  const sidebar = (await page.locator("#panel").boundingBox())!;
  expect(after.x).toBeLessThan(sidebar.x + sidebar.width); // now over the sessions column

  // Escape closes it, and the branch survives as an ordinary conversation.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("the card resizes by its own grip, down to a floor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("about:blank");
  await branch(page);

  const card = page.locator(".branch-win");
  await expect(card).toHaveCSS("resize", "both");
  const before = (await card.boundingBox())!;

  // Drag the browser's grip (the card's bottom-right corner) inward. It stops at
  // the min-width/min-height floor rather than collapsing to a sliver.
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down();
  await page.mouse.move(before.x + 60, before.y + 40, { steps: 10 });
  await page.mouse.up();

  const after = (await card.boundingBox())!;
  expect(after.width).toBeLessThan(before.width);
  expect(after.height).toBeLessThan(before.height);
  expect(after.width).toBeGreaterThanOrEqual(300);
  expect(after.height).toBeGreaterThanOrEqual(240);
  // Still usable at that size: the thread and its composer are both there.
  await expect(card.locator(".branch-win-body")).toBeVisible();
  await expect(card.locator("footer .cm-editor")).toBeVisible();
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
  // No drag handle and nothing to resize at this width — the sheet is not a
  // window you move around or reshape, it is the whole screen.
  await expect(page.locator(".branch-win-head")).toHaveCSS("cursor", "auto");
  await expect(page.locator(".branch-win")).toHaveCSS("resize", "none");
});
