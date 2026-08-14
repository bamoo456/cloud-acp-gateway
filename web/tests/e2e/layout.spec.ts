import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// Regression test for the composer being pushed off-screen on long threads.
// Root cause was the header/main/footer flex column living on <body> while React
// mounts into #root; a long thread grew #root past the viewport and the composer
// (footer) scrolled out of view. The composer must stay pinned and <main> must be
// the scroll container instead.

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

async function metrics(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main")!;
    const footer = document.querySelector("footer")!;
    const ta = document.querySelector("footer .cm-editor")!;
    const fb = footer.getBoundingClientRect();
    const tb = ta.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const send = document.querySelector("footer .send")?.getBoundingClientRect();
    return {
      vh,
      footerBottom: Math.round(fb.bottom),
      composerVisible: fb.bottom <= vh + 1 && fb.top >= 0,
      textareaVisible: tb.bottom <= vh + 1 && tb.top >= 0,
      mainScrollable: main.scrollHeight > main.clientHeight + 1,
      // the composer's send button must stay within the viewport horizontally —
      // a long model name must not push the controls off the right edge
      sendInView: send ? (send.right <= vw + 1 && send.left >= 0) : false,
      docOverflowX: document.documentElement.scrollWidth - vw,
    };
  });
}

for (const vp of VIEWPORTS) {
  test(`composer stays pinned on a long thread (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.addInitScript(SEED_SSE(40));
    await page.goto("/");

    // The thread windows older messages (only the latest slice mounts), so a raw
    // .turn count tops out at the visible window. Assert the long-thread signals
    // directly: the "earlier messages" hint is present AND <main> overflows.
    await page.waitForFunction(() => {
      const main = document.querySelector("main");
      return !!document.querySelector(".earlier-hint") && !!main && main.scrollHeight > main.clientHeight + 1;
    });

    const m = await metrics(page);
    expect(m.mainScrollable, "the thread must scroll inside <main>, not grow the page").toBe(true);
    expect(m.composerVisible, "the composer (footer) must stay within the viewport").toBe(true);
    expect(m.textareaVisible, "the reply textarea must be reachable").toBe(true);
    expect(m.footerBottom, "footer bottom should sit at the viewport edge").toBeLessThanOrEqual(vp.height + 1);
    expect(m.sendInView, "the send button must stay within the viewport (no composer-row overflow)").toBe(true);
    expect(m.docOverflowX, "no horizontal page overflow").toBeLessThanOrEqual(0);
  });
}

test("conversation action menu opens with the expected actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0);

  await page.click('button[title="Conversation menu"]');
  await expect(page.locator(".amenu")).toBeVisible();
  // Share was replaced by a CLI resume command (#35).
  await expect(page.locator(".amenu").getByText("Copy resume command")).toBeVisible();
  await expect(page.locator(".amenu").getByText("Text size")).toBeVisible();
  await expect(page.locator(".amenu").getByText("Auto-approve permissions")).toBeVisible();
  await expect(page.locator(".amenu").getByText("Rename", { exact: true })).toBeVisible();

  // What is NOT here is the point: P3 moved "what is running" — agent, model,
  // thinking level, permission mode — out of both the composer row and this
  // menu, into the engine dock above the composer. The menu is settings and
  // conversation actions only.
  await expect(page.locator("footer .crow .mode")).toHaveCount(0);
  await expect(page.locator(".amenu").getByText("Model", { exact: true })).toHaveCount(0);
  await expect(page.locator(".amenu").getByText("Permission mode")).toHaveCount(0);
});

// The rename field was unreachable on a phone. The action sheet renders inside
// <header>, which is a stacking context (position:relative + z-index:30), so
// anything above 30 at the root paints over it — the bottom tab bar was z-40 and
// covered the sheet's lower edge, input and Save both. Playwright's actionability
// check is the assertion here: a click on a covered element fails.
test("the rename field and its Save button are tappable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0);

  await page.click('button[title="Conversation menu"]');
  await page.locator(".amenu").getByRole("button", { name: "Rename", exact: true }).click();
  const input = page.locator(".amenu .rename-input");
  await input.click();
  await input.fill("named on the phone");
  await page.locator(".amenu .rename-body .btn").click();

  await expect(page.locator("header .crumb-path .ttl")).toHaveText("named on the phone");
});

test("text size menu scales chat text and persists", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  // Text size now persists on the gateway (shared across devices), not in
  // localStorage. There's no real gateway here, so emulate GET/POST /prefs with a
  // Node-side variable — this survives the reload below, proving persistence.
  let storedTextSize: string | null = null;
  await page.route("**/prefs", (route) =>
    route.fulfill({ json: { textSize: storedTextSize, lock: null, recentSessions: [], recentFolders: [] } }));
  await page.route("**/prefs/text-size**", (route) => {
    storedTextSize = new URL(route.request().url()).searchParams.get("value");
    route.fulfill({ json: { textSize: storedTextSize } });
  });
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".turn.agent .body .md").length > 0);

  const assistant = page.locator(".turn.agent .body .md").first();
  const baseAssistantSize = await assistant.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const baseHeaderSize = await page.locator("header .crumb-path .ttl").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  await page.click('button[title="Conversation menu"]');
  await expect(page.locator(".amenu").getByText("Text size")).toBeVisible();
  await page.locator(".amenu").getByText("Text size").click();
  await expect(page.locator(".amenu .ahead")).toContainText("Text size");
  await page.locator(".amenu").getByRole("button", { name: /Large/ }).click();

  const largeAssistantSize = await assistant.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const largeHeaderSize = await page.locator("header .crumb-path .ttl").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(largeAssistantSize).toBeGreaterThan(baseAssistantSize);
  expect(largeHeaderSize).toBe(baseHeaderSize);
  // The choice was persisted to the gateway (our /prefs mock captured it).
  await expect.poll(() => storedTextSize).toBe("large");

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".turn.agent .body .md").length > 0);
  const persistedAssistantSize = await page.locator(".turn.agent .body .md").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(persistedAssistantSize).toBe(largeAssistantSize);
});

test("history panel is a collapsible column on desktop, a toggle overlay on mobile", async ({ page }) => {
  await page.addInitScript(SEED_SSE(1));
  // desktop: panel is an expanded column, the clock button collapses it
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.locator("#panel")).toBeVisible();
  await expect(page.locator("button.sessions-btn")).toBeVisible();
  await page.click("button.sessions-btn");
  await expect(page.locator("#panel")).toBeHidden();
  await page.click("button.sessions-btn");
  await expect(page.locator("#panel")).toBeVisible();
  // mobile: panel hidden until the clock toggle is tapped
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#panel")).toBeHidden();
  await expect(page.locator("button.sessions-btn")).toBeVisible();
  await page.click("button.sessions-btn");
  await expect(page.locator("#panel")).toBeVisible();
});

test("sidebar can start a new chat in the current folder", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(/\/history\?/, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [] }) }));
  // The browser seeds its page stack from cfg.fsRoot (here the dev-server default "/"),
  // so the "workspace" dir under it resolves to "/workspace".
  await page.route(/\/fs\?/, (r) => {
    const path = new URL(r.request().url()).searchParams.get("path") || "";
    if (path.endsWith("/workspace")) {
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ root: "/", path: "/workspace", parent: "/", dirs: [] }),
      });
    }
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ root: "/", path: "/", parent: null, dirs: [{ name: "workspace", git: true }] }),
    });
  });
  // SSE+POST seed that records every session/new's params (no conversation seeding)
  // and hands out incrementing session ids — the SSE analogue of the general seed.
  await page.addInitScript(`
(() => {
  const calls = [];
  window.__sessionNewCalls = calls;
  let nextSession = 0;
  const enc = new TextEncoder();
  let controller = null;
  let seq = 0;
  const push = (obj) => {
    if (!controller) return;
    seq += 1;
    controller.enqueue(enc.encode("id:" + seq + "\\ndata:" + JSON.stringify(obj) + "\\n\\n"));
  };
  const handle = (m) => {
    if (m.id == null || !m.method) return;
    if (m.method === "initialize") {
      push({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
      return;
    }
    if (m.method === "session/new") {
      calls.push(m.params);
      nextSession += 1;
      push({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-" + nextSession } });
      return;
    }
    push({ jsonrpc: "2.0", id: m.id, result: {} });
  };
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    if (method === "POST" && url.indexOf("/acp/rpc") >= 0) {
      let m = null; try { m = JSON.parse((init && init.body) || "{}"); } catch (e) {}
      if (m) handle(m);
      return Promise.resolve(new Response("", { status: 202 }));
    }
    if (url.indexOf("/acp/sse") >= 0) {
      const stream = new ReadableStream({ start(c) {
        controller = c;
        c.enqueue(enc.encode("event: ready\\ndata:{\\"conn\\":\\"c0\\"}\\n\\n"));
      } });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }
    return _fetch(input, init);
  };
})();
`);
  await page.goto("/");
  await expect(page.locator("#panel")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__sessionNewCalls?.length ?? 0)).toBe(1);

  await page.locator("#panel .folder-bar").click();
  // The folder bar now opens the picker (pinned/recent); drill into the browser.
  await page.getByRole("button", { name: /Browse all folders/ }).click();
  await page.locator("#fb .dir", { hasText: "workspace" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__sessionNewCalls?.map((p: any) => p.cwd))).toEqual([
    "",
    "/workspace",
  ]);

  // "New chat" is the crumb's own button since P4 — the sidebar lists folders
  // and their conversations, and starts none. What is under test is unchanged:
  // whichever cwd the folder bar is showing is the cwd session/new carries.
  const newChat = page.getByRole("button", { name: "New chat" });
  await expect(newChat).toBeVisible();
  await newChat.click();

  await expect.poll(() => page.evaluate(() => (window as any).__sessionNewCalls?.map((p: any) => p.cwd))).toEqual([
    "",
    "/workspace",
    "/workspace",
  ]);
  await expect(page.locator("header .crumb-path .ttl")).toHaveText("Untitled");
});

test("mobile folder picker keeps the Use this folder action reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  const historySessions = Array.from({ length: 8 }, (_, i) => ({
    sessionId: `hist-${i}`,
    title: `Recent folder test conversation ${i + 1}`,
    updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
  }));
  await page.route(/\/history\?/, (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: historySessions }),
  }));
  await page.route(/\/fs\?/, (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      root: "/Users/me",
      path: "/Users/me/git/my-apps/cloud-acp-gateway",
      parent: "/Users/me/git/my-apps",
      dirs: ["data", "dist", "docs", "node_modules", "public", "src", "web"].map((name) => ({ name, git: false })),
    }),
  }));
  await page.addInitScript(SEED_SSE(1));
  await page.goto("/");

  await page.click("button.sessions-btn");
  await expect(page.locator("#panel")).toBeVisible();
  await page.locator("#panel .folder-bar").click();
  // The folder bar opens the picker; the drill-down browser holds "Use this folder".
  await page.getByRole("button", { name: /Browse all folders/ }).click();

  const useFolder = page.getByRole("button", { name: "Use this folder" });
  await expect(useFolder).toBeVisible();
  const m = await useFolder.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, viewportHeight: window.innerHeight };
  });
  expect(m.top, "Use this folder should not be above the viewport").toBeGreaterThanOrEqual(0);
  expect(m.bottom, "Use this folder should stay above the mobile viewport bottom").toBeLessThanOrEqual(m.viewportHeight);
});

test("the URL tracks the active session (for refresh / share)", async ({ page }) => {
  await page.addInitScript(SEED_SSE(1));
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0);
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe("sess-1");
});

test("rename updates the header title AND the sidebar entry, and POSTs it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); // desktop: sidebar is visible
  await page.addInitScript(SEED_SSE(1));
  let title = "Original title";
  let posted: string | null = null;
  await page.route(/\/history\?/, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [{ sessionId: "sess-1", title, updatedAt: new Date().toISOString() }] }) }));
  await page.route(/\/history\/rename/, (r) => {
    posted = new URL(r.request().url()).searchParams.get("title");
    title = posted ?? title; // the backend would now serve the new title
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0);
  // P4 replaced the flat all/recent lists with one folder-grouped list, so the
  // conversation now appears exactly once — the rename has to reach that row.
  await expect(page.locator("#panel .sess-item .name")).toHaveText("Original title");

  await page.click('button[title="Conversation menu"]');
  await page.getByText("Rename", { exact: true }).click();
  await page.locator(".rename-input").fill("My renamed chat");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.locator("header .crumb-path .ttl")).toHaveText("My renamed chat");
  await expect(page.locator("#panel .sess-item .name")).toHaveText("My renamed chat"); // sidebar refreshed
  expect(posted).toBe("My renamed chat");
});

test("a ?session= deep-link shows a loading state while joining", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // delay the history fetch so the loading state is clearly observable
  await page.route(/\/history\/messages/, async (r) => {
    await new Promise((res) => setTimeout(res, 400));
    await r.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [], total: 0, truncated: false }) });
  });
  await page.addInitScript(SEED_SSE(1));
  await page.goto("/?session=sess-1&cwd=/home/user/workspace");
  await expect(page.locator(".thread .empty h2")).toHaveText("Joining conversation…");
});

test("Esc cancels the folder browser", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(SEED_SSE(1));
  await page.route(/\/fs\?/, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ root: "/r", path: "/r", parent: null, dirs: [] }) }));
  await page.goto("/");
  await page.locator("#panel .folder-bar").click();
  await page.getByRole("button", { name: /Browse all folders/ }).click();
  await expect(page.locator("#fb")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#fb")).toHaveCount(0);
});

// The usage strip is the only shrinkable segment in the status bar (its
// siblings are nowrap, so they never give a pixel back) — every other segment
// is therefore paid for out of the quota's width. On a phone a big diffstat
// alone pushed all four quota windows off the right edge, into a scroll nobody
// can see: the strip read "ctx 56%" and nothing else. The diffstat and a
// healthy "connected" drop below 640px so the quota fits.
test("the quota windows stay on screen on a phone, behind a big diffstat", async ({ page }) => {
  const CWD = "/home/user/workspace";
  await page.route(/\/usage\/limits/, (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      status: "ok",
      windows: {
        // Four windows at their widest: "100%" is one digit more than a normal
        // reading, and Opus/Sonnet carry the longest labels.
        five_hour: { rateLimitType: "five_hour", utilization: 0.36 },
        seven_day: { rateLimitType: "seven_day", utilization: 0.57 },
        seven_day_opus: { rateLimitType: "seven_day_opus", utilization: 0.84 },
        seven_day_sonnet: { rateLimitType: "seven_day_sonnet", utilization: 1 },
      },
    }),
  }));
  await page.route(/\/workspace\/changes/, (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      repo: CWD,
      files: Array.from({ length: 500 }, (_, i) => ({
        path: `src/f${i}.ts`, status: "modified",
        additions: i === 0 ? 94358 : 0, deletions: i === 0 ? 7162 : 0,
      })),
    }),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(1));
  await page.goto(`/?cwd=${encodeURIComponent(CWD)}`);

  await expect(page.locator(".usage-strip .u-seg")).toHaveCount(4);
  await expect(page.locator(".statusbar .sb-diff")).toBeHidden();
  await expect(page.locator(".statusbar .conn")).toBeHidden();
  const strip = await page.locator(".usage-strip").evaluate((el) => ({
    scroll: el.scrollWidth, client: el.clientWidth,
  }));
  expect(strip.scroll, "every quota window must fit without a hidden sideways scroll")
    .toBeLessThanOrEqual(strip.client + 1);

  // Desktop has the room for all of it, and keeps it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".statusbar .sb-diff")).toBeVisible();
  await expect(page.locator(".statusbar .conn")).toHaveText("connected");
});

// iOS zooms the page in when a field under 16px takes focus, and never zooms
// back out — so on a phone the composer and every panel field have a 16px
// floor. The composer sat at 15.5px (14px on the "small" text size) and the
// search box at 15px, which meant tapping either one left the layout zoomed.
test("no field a phone can focus sits under 16px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/history\?/, (r) => r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: [{ sessionId: "sess-1", title: "A chat", updatedAt: new Date().toISOString() }] }),
  }));
  await page.addInitScript(SEED_SSE(1));
  await page.goto("/");
  await expect(page.locator(".composer .cm-content")).toBeVisible();
  await page.click("button.sessions-btn"); // mounts the sidebar's search field

  const fields = await page.evaluate(() =>
    [...document.querySelectorAll("input:not([type=file]), textarea, .cm-content")].map((el) => ({
      what: el.getAttribute("placeholder") || el.className || el.tagName,
      size: parseFloat(getComputedStyle(el).fontSize),
    })));
  expect(fields.length, "the composer and the search field must both be mounted").toBeGreaterThanOrEqual(2);
  for (const f of fields) expect(f.size, `${f.what} is below the iOS zoom threshold`).toBeGreaterThanOrEqual(16);

  // Desktop keeps its own smaller sizes — the floor is a phone rule only.
  await page.setViewportSize({ width: 1280, height: 800 });
  const composer = await page.locator(".composer .cm-content").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(composer).toBeLessThan(16);
});

// A 390px column holds about 30 monospace characters. A code block that scrolls
// sideways therefore shows a third of every line, with no affordance saying the
// rest exists — tool output read as clipped garbage on a phone. It wraps now;
// the desktop keeps its columns, which is why the second half of this test
// asserts the overflow is still there at 1280.
test("a code block wraps on a phone and still scrolls on a desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(1));
  await page.goto("/");

  const pre = page.locator(".turn.agent .body .md pre").last();
  await expect(pre).toBeVisible();
  const phone = await pre.evaluate((el) => ({
    scroll: el.scrollWidth, client: el.clientWidth, right: Math.round(el.getBoundingClientRect().right),
  }));
  expect(phone.scroll, "no line may hide past the right edge of the block")
    .toBeLessThanOrEqual(phone.client + 1);
  expect(phone.right, "and the block itself must stay on screen").toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktop = await pre.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(desktop.scroll, "a wide screen keeps the block's own columns intact")
    .toBeGreaterThan(desktop.client);
});

test("slash-command menu dismisses on an outside click", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0);

  await page.click('button[title="Slash commands"]');
  await expect(page.locator(".cmds.open")).toBeVisible();
  // clicking outside the menu (the thread) must close it
  await page.locator("main").click({ position: { x: 30, y: 90 } });
  await expect(page.locator(".cmds.open")).toHaveCount(0);
});

// The engine dock puts the permission mode at one end of a row and the model /
// thinking level at the other. Both chips are `flex: 0 1 auto`, so at 390px they
// shrank together: the mode was cut to "Au…" while the model still read
// "Default (recommende…", and the spacer between them collapsed to zero, leaving
// the two borders touching.
test("the engine dock reads at 390px instead of crushing both chips", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(1));
  await page.goto("/");
  await expect(page.locator(".dock .mchip").first()).toBeVisible();

  const measure = () => page.evaluate(() => {
    const chip = document.querySelector(".dock .mchip:not(.mchip-mode)")!;
    const mode = document.querySelector(".dock .mchip-mode")!;
    const model = chip.querySelector(".am")!;
    return {
      gap: Math.round(chip.getBoundingClientRect().left - mode.getBoundingClientRect().right),
      modelClipped: model.scrollWidth - model.clientWidth,
      modeClipped: mode.scrollWidth - mode.clientWidth,
      // Dropped at every width, not just here: the composer's placeholder says
      // "Reply to <agent>" on a desktop too.
      agentInChip: chip.querySelector(".wm") !== null,
    };
  });

  const phone = await measure();
  expect(phone.gap, "the two chips must not end up border to border").toBeGreaterThanOrEqual(8);
  expect(phone.modelClipped, "the model name is the one fact with nowhere else to appear").toBe(0);
  expect(phone.modeClipped, "and the permission mode must stay readable").toBe(0);
  expect(phone.agentInChip).toBe(false);

  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await measure()).agentInChip).toBe(false);
});
