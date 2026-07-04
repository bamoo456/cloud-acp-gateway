import { defineConfig, devices } from "@playwright/test";

// Layout regression tests drive the REAL built app (vite dev server) with a
// mocked WebSocket, so no gateway/agent backend is needed. jsdom (vitest) can't
// be used here — it has no layout engine, so getBoundingClientRect() is all zero.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5174", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
