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
    // .msg count tops out at the visible window. Assert the long-thread signals
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

test("conversation action menu opens with the expected actions + model submenu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".msg").length > 0);

  await page.click('button[title="Conversation menu"]');
  await expect(page.locator(".amenu")).toBeVisible();
  // Share was replaced by a CLI resume command (#35).
  await expect(page.locator(".amenu").getByText("Copy resume command")).toBeVisible();
  await expect(page.locator(".amenu").getByText("Text size")).toBeVisible();
  await expect(page.locator(".amenu").getByText("Permission mode")).toBeVisible();
  await expect(page.locator(".amenu").getByText("Auto-approve permissions")).toBeVisible();
  // model/mode/auto moved out of the composer into the menu
  await expect(page.locator("footer .crow .mode")).toHaveCount(0);

  // drill into the model submenu (its header only exists in that view)
  await page.locator(".amenu").getByText("Model", { exact: true }).click();
  await expect(page.locator(".amenu .ahead")).toContainText("Model");
  await expect(page.locator(".amenu .arow")).toHaveCount(1); // the one seeded model
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
  await page.waitForFunction(() => document.querySelectorAll(".msg.assistant .md").length > 0);

  const assistant = page.locator(".msg.assistant .md").first();
  const baseAssistantSize = await assistant.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const baseHeaderSize = await page.locator("header .title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  await page.click('button[title="Conversation menu"]');
  await expect(page.locator(".amenu").getByText("Text size")).toBeVisible();
  await page.locator(".amenu").getByText("Text size").click();
  await expect(page.locator(".amenu .ahead")).toContainText("Text size");
  await page.locator(".amenu").getByRole("button", { name: /Large/ }).click();

  const largeAssistantSize = await assistant.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const largeHeaderSize = await page.locator("header .title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(largeAssistantSize).toBeGreaterThan(baseAssistantSize);
  expect(largeHeaderSize).toBe(baseHeaderSize);
  // The choice was persisted to the gateway (our /prefs mock captured it).
  await expect.poll(() => storedTextSize).toBe("large");

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".msg.assistant .md").length > 0);
  const persistedAssistantSize = await page.locator(".msg.assistant .md").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(persistedAssistantSize).toBe(largeAssistantSize);
});

test("history panel is a persistent column on desktop, a toggle overlay on mobile", async ({ page }) => {
  await page.addInitScript(SEED_SSE(1));
  // desktop: panel is always visible, the clock toggle is hidden
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.locator("#panel")).toBeVisible();
  await expect(page.locator("button.sessions-btn")).toBeHidden();
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

  const sidebarNewChat = page.locator("#panel").getByRole("button", { name: "New chat" });
  await expect(sidebarNewChat).toBeVisible();
  await sidebarNewChat.click();

  await expect.poll(() => page.evaluate(() => (window as any).__sessionNewCalls?.map((p: any) => p.cwd))).toEqual([
    "",
    "/workspace",
    "/workspace",
  ]);
  await expect(page.locator("header .title")).toHaveText("Untitled");
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
  await page.waitForFunction(() => document.querySelectorAll(".msg").length > 0);
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
  await page.waitForFunction(() => document.querySelectorAll(".msg").length > 0);
  await expect(page.locator("#panel .all-section .sess-item .name")).toHaveText("Original title");

  await page.click('button[title="Conversation menu"]');
  await page.getByText("Rename", { exact: true }).click();
  await page.locator(".rename-input").fill("My renamed chat");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.locator("header .title")).toHaveText("My renamed chat");
  await expect(page.locator("#panel .all-section .sess-item .name")).toHaveText("My renamed chat"); // sidebar refreshed
  await expect(page.locator("#panel .recent-section .sess-item .name")).toHaveText("My renamed chat");
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

test("slash-command menu dismisses on an outside click", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(SEED_SSE(2));
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll(".msg").length > 0);

  await page.click('button[title="Slash commands"]');
  await expect(page.locator(".cmds.open")).toBeVisible();
  // clicking outside the menu (the thread) must close it
  await page.locator("main").click({ position: { x: 30, y: 90 } });
  await expect(page.locator(".cmds.open")).toHaveCount(0);
});
