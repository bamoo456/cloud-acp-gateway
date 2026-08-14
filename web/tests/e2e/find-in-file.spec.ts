import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// The viewer's find bar paints through the CSS Custom Highlight API and scrolls
// by measuring the match's Range — neither of which jsdom can answer, so the
// unit tests cover the offsets and this covers the browser half.
const LINES = Array.from({ length: 400 }, (_, i) =>
  i === 380 ? "const needle = 'deep down';" : `const line${i} = ${i};`).join("\n");

test("find-in-file paints the match and scrolls to it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.route("**/prefs", (r) => r.fulfill({ json: { textSize: null, lock: null, recentSessions: [], recentFolders: [] } }));
  await page.route("**/workspace/changes**", (r) => r.fulfill({
    json: { repo: "/repo", truncated: false, files: [{ path: "src/big.ts", abs: "/repo/src/big.ts", status: "modified", staged: false, additions: 1, deletions: 0 }] },
  }));
  await page.route("**/workspace/outputs**", (r) => r.fulfill({ json: [] }));
  await page.route("**/workspace/tree**", (r) => r.fulfill({ json: { abs: "/repo", path: "", truncated: false, entries: [] } }));
  await page.route("**/review/draft**", (r) => r.fulfill({ json: { scope: "working", comments: [], counts: {}, persisted: true } }));
  await page.route("**/workspace/diff**", (r) => r.fulfill({ json: { path: "src/big.ts", status: "modified", binary: false, truncated: false, diff: "" } }));
  await page.route("**/workspace/file**", (r) => r.fulfill({
    json: { path: "src/big.ts", abs: "/repo/src/big.ts", kind: "text", size: LINES.length, modifiedAt: new Date().toISOString(), text: LINES, truncated: false },
  }));

  await page.goto("/");
  await page.click('button[title="Files and changes"]');
  await page.locator("button.wf-row", { hasText: "big.ts" }).click();
  await expect(page.locator("pre.wf-text")).toBeVisible();

  const before = await page.locator(".wf-body").evaluate((el) => el.scrollTop);
  await page.click('button[title="Find in this file"]');
  await page.locator(".wf-search input").fill("needle");

  await expect(page.locator(".wf-search .n")).toHaveText("1/1");
  const after = await page.locator(".wf-body").evaluate((el) => el.scrollTop);
  expect(after).toBeGreaterThan(before + 100);

  // The highlight actually reached the engine, and it covers the query.
  const painted = await page.evaluate(() => {
    const reg = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
    const cur = [...(reg.get("wf-find-current") ?? [])];
    return { registered: [...reg.keys()], text: cur.map((r) => r.toString()) };
  });
  expect(painted.registered).toContain("wf-find-current");
  expect(painted.text).toEqual(["needle"]);

  // A query that hits every line still counts them all, up to the cap.
  await page.locator(".wf-search input").fill("const");
  await expect(page.locator(".wf-search .n")).toHaveText("1/400");
});
