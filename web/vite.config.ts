import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const GATEWAY = process.env.ACPG_DEV_TARGET ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Unit tests live under src/. The Playwright layout specs (tests/e2e/*.spec.ts)
    // need a real browser and must not be picked up by vitest's jsdom runner.
    include: ["src/**/*.test.ts"],
  },
  server: {
    proxy: {
      "/acp": { target: GATEWAY, ws: true, changeOrigin: true },
      "/history": { target: GATEWAY, changeOrigin: true },
      "/fs": { target: GATEWAY, changeOrigin: true },
      "/healthz": { target: GATEWAY, changeOrigin: true },
    },
  },
});
