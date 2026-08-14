import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// Two conversations under the same agent: chat in #1 (seeded), start #2 from
// the "New chat" button, switch back to #1 via the sidebar session list.
// The thread must NOT reload from /history and must keep its messages intact.
test("switching back to a background conversation is instant and loss-free", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // Count any /history/messages requests — the hot-path must produce zero.
  let historyMessagesCalls = 0;
  await page.route(/\/history\/messages/, (r) => {
    historyMessagesCalls++;
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [], total: 0, truncated: false }) });
  });
  // The sidebar builds its list from the gateway's own conversation list, not
  // from whatever happens to be live in this tab — so sess-1 has to be in it to
  // be clickable at all. That it is *also* live is the whole point: clicking a
  // listed conversation this tab already holds must not go back to the gateway.
  await page.route(/\/history\?/, (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sessions: [{ sessionId: "sess-1", title: "Chat one", updatedAt: new Date().toISOString() }] }),
    }),
  );

  // The seed now hands out incrementing session ids: first session/new → sess-1
  // (with a seeded conversation), second → sess-2 (empty).
  await page.addInitScript(SEED_SSE(2));
  await page.goto("/");

  // Wait for sess-1 conversation to render.
  await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0);
  const firstCount = await page.locator(".turn").count();
  expect(firstCount).toBeGreaterThan(0);

  // Confirm we're on sess-1.
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("session"))).toBe("sess-1");

  // Start a second chat (same agent). "New chat" is the crumb's button since P4.
  await page.getByRole("button", { name: "New chat" }).click();
  // URL should move off sess-1 (provisional id, then sess-2 once resolved).
  await expect
    .poll(() => page.evaluate(() => new URL(location.href).searchParams.get("session")))
    .not.toBe("sess-1");

  // Capture the call count before switching back — should not change.
  const callsBeforeSwitchBack = historyMessagesCalls;

  // The list shows sessions the current agent has recently been active in,
  // grouped by folder since P4. sess-1 was active with a conversation, so it
  // appears there. sess-2 has no content yet, so it is not listed — the first
  // (and only) entry is sess-1. Click it to switch back.
  const sessions = page.locator("#panel .sess-list");
  await expect(sessions).toBeVisible();
  const sess1Item = sessions.locator(".sess-item").first();
  await expect(sess1Item).toBeVisible();
  await sess1Item.click();

  // Back on sess-1: URL, messages, no empty state, no history fetch.
  await expect
    .poll(() => page.evaluate(() => new URL(location.href).searchParams.get("session")))
    .toBe("sess-1");

  // No "Joining conversation…" / "Ready to code?" empty state — content is live.
  await expect(page.locator(".thread .empty")).toHaveCount(0);

  // All original messages preserved — no reload flush.
  expect(await page.locator(".turn").count()).toBe(firstCount);

  // Critical assertion: the hot path hit /history/messages zero additional times.
  expect(historyMessagesCalls).toBe(callsBeforeSwitchBack);
});
