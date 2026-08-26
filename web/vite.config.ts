import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const GATEWAY = process.env.ACPG_DEV_TARGET ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  // esbuild's es2020 lowering of logical assignment (`x ||= {}`) miscompiles
  // when the target binding is otherwise dead: it drops the `let` and emits
  // `void 0 || (n = {})`, an assignment to an undeclared name that throws in a
  // strict-mode module. xterm.js hits this in its DECRQM handler, so the first
  // `CSI ? Ps $ p` a full-screen program sends (vim, on startup) killed the
  // parser and froze the terminal. Vite's default target ("modules") floors at
  // es2020 for Firefox 78; es2022 matches tsconfig and skips the lowering.
  build: { target: "es2022" },
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
      "/uploads": { target: GATEWAY, changeOrigin: true },
      "/terminal": { target: GATEWAY, changeOrigin: true },
      "/healthz": { target: GATEWAY, changeOrigin: true },
    },
  },
});
