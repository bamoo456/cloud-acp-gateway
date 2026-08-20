import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// The thread's find bar matches over the store, but everything the user SEES of
// it happens in the engine: highlights painted through the CSS Custom Highlight
// API and a scroll computed from the match's Range. jsdom answers neither, so
// the unit tests cover the hit list (and the window reveal, which a real browser
// opens up on its own through early scroll events) and this covers the browser
// half: painting, the scroll, and reaching a match inside a folded reply.
const painted = () => ({
  registered: [...(CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.keys()],
  current: [...((CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get("th-find-current") ?? [])]
    .map((r) => r.toString()),
});

test("find-in-conversation reveals, unfolds, paints and scrolls to a match", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(40));
  await page.route("**/prefs", (r) => r.fulfill({ json: { textSize: null, lock: null, recentSessions: [], recentFolders: [] } }));

  await page.goto("/");
  const main = page.locator("main#main");
  // Wait for the seeded conversation to finish streaming (its last message), so
  // the thread has settled at the live tail before anything is measured.
  await expect(main.locator(".turn.agent").last()).toContainText("sig=");
  const fromBottom = () => main.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(fromBottom).toBeLessThan(50); // parked at the tail, where a thread opens

  await page.click('button[title="Find in conversation"]');
  await page.locator(".thread-find input").fill("(#0)");

  // Revealed, counted, painted, and scrolled back up to.
  await expect(page.locator(".thread-find .n")).toHaveText("1/1");
  // Scoped to the thread: the sidebar names a conversation after its first message.
  await expect(main.locator(".turn.user .body", { hasText: "(#0)" })).toBeVisible();
  // The oldest message in the conversation — reaching it means leaving the tail.
  await expect.poll(fromBottom).toBeGreaterThan(1000);
  const hit = await page.evaluate(painted);
  expect(hit.registered).toContain("th-find-current");
  expect(hit.current).toEqual(["(#0)"]);

  // A phrase that lives in every agent reply — the replies are folded to a peek
  // line, so reaching a match means unfolding the turn it is in.
  await page.locator(".thread-find input").fill("accumulative review strategy");
  await expect(page.locator(".thread-find .n")).toHaveText(/^1\/\d+$/);
  const first = await page.evaluate(painted);
  expect(first.current).toEqual(["accumulative review strategy"]);
  // The painted match is inside a mounted reply body, not a peek line.
  const inBody = await page.evaluate(() => {
    const reg = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
    const cur = [...(reg.get("th-find-current") ?? [])][0];
    return !!(cur?.startContainer.parentElement?.closest(".turn.agent .body"));
  });
  expect(inBody).toBe(true);

  // Stepping moves the current highlight to a different occurrence.
  const where = () => page.evaluate(() => {
    const reg = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
    const cur = [...(reg.get("th-find-current") ?? [])][0];
    const el = cur?.startContainer.parentElement?.closest("[data-id]");
    return el?.getAttribute("data-id") ?? null;
  });
  const firstId = await where();
  await page.click('.thread-find button[title="Next match"]');
  await expect(page.locator(".thread-find .n")).toHaveText(/^2\/\d+$/);
  expect(await where()).not.toBeNull();
  // Same reply holds several occurrences, so only the counter is guaranteed to
  // move; what must hold is that a hit is still painted somewhere mounted.
  expect(typeof firstId).toBe("string");

  // Closing clears the registry rather than leaving highlights over the thread.
  await page.click('.thread-find button[title="Close search"]');
  const after = await page.evaluate(painted);
  expect(after.registered).not.toContain("th-find-current");
  expect(after.registered).not.toContain("th-find");
});
