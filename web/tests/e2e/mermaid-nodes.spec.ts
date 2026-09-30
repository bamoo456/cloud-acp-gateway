import { test, expect } from "@playwright/test";
import { SEED_SSE } from "./seed-sse.ts";

// The unit tests map a diagram's nodes against a FAKE mermaid: jsdom has no
// getBBox, so nothing there draws an SVG. What only a browser can answer is
// whether the id the parser reports (`flowchartNodes`) is still the id the
// renderer wrote onto the <g> — the whole mapping rests on that pair, and a
// stand-in cannot disagree with itself. The same run proves the other half of
// strict mode: a source that asks for links gets none.
const REPLY = [
  "Here is the flow.",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[Resolver] --> B[Renderer]",
  '  click A href "javascript:alert(1)"',
  '  click A callback "steal"',
  '  click B href "https://evil.example"',
  "```",
  "",
  "```acp-nodes",
  '{ "A": { "path": "src/app.ts", "line": 12, "endLine": 20, "label": "the resolver" } }',
  "```",
].join("\n");

// What the gateway injects into index.html. Vite dev leaves the placeholder, and
// a session with no cwd resolves no references at all.
const CFG = JSON.stringify({
  token: "t", defaultAgent: "claude", agents: [{ name: "claude", cwd: "/repo" }], fsRoot: "/",
});

test("a diagram's nodes carry the metadata's reference, and its links are dropped", async ({ page }) => {
  await page.route("**/prefs", (r) => r.fulfill({ json: { textSize: null, lock: null, recentSessions: [], recentFolders: [] } }));
  await page.route("**/workspace/resolve*", (r) => r.fulfill({ json: { abs: "/repo/src/app.ts", path: "src/app.ts" } }));
  await page.route("http://localhost:5174/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace("__ACPG_CFG__", CFG) });
  });
  await page.addInitScript(SEED_SSE(1, REPLY));

  await page.goto("/");
  const figure = page.locator(".md-mermaid").last();
  await expect(figure.locator("svg")).toBeVisible();

  // The node the metadata named, mapped and resolved: the id match held against
  // the real renderer.
  const node = figure.locator("g.node.acp-node.resolved");
  await expect(node).toHaveCount(1);
  await expect(node).toHaveAttribute("data-path", "src/app.ts");
  await expect(node).toHaveAttribute("data-line", "12");
  await expect(node).toHaveAttribute("role", "link");
  // Neither node the source asked to link is a link. strict mode drops a
  // callback's URL but keeps a plain href, so this is the assertion only a real
  // renderer can make — and the reason renderMermaid unwraps them (see unclick).
  // `[href]` alone would miss the xlink:href an SVG anchor carries.
  expect(await figure.locator("a, [*|href]").count()).toBe(0);
  expect(await figure.locator(".clickable").count()).toBe(0);
  await expect(page.locator(".acp-node-list .md-ref.resolved")).toHaveCount(1);
});
