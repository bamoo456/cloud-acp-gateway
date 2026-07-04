import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Gateway } from "./gateway.ts";

// Regression for #81: a bad agent command makes ChildProcess emit an "error"
// event. Without a listener Node treats it as fatal and crashes the whole
// gateway. The agent must instead surface it as a channel failure and back off,
// keeping the process (and other agents) alive.
test("a bad agent command is surfaced as a failure, not a fatal crash", async () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-spawn-"));
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  const b = new Gateway(
    { bad: { cmd: "/definitely/not/a/command", args: [], cwd: process.cwd() } },
    ledgerDir,
  );
  try {
    // Triggers the real Agent spawn. Before the fix, the ENOENT "error" event
    // is unhandled and takes the test process down with it.
    b.channel("bad");
    // Give the async spawn failure a tick to fire.
    await new Promise((r) => setTimeout(r, 100));

    // The process is still alive (we got here), and the failure was reported
    // through our handler rather than thrown.
    assert.ok(
      errors.some((e) => e.includes("failed to spawn") && e.includes("/definitely/not/a/command")),
      `expected a 'failed to spawn' report, got: ${JSON.stringify(errors)}`,
    );
  } finally {
    // Cancels the pending backoff respawn so the test process can exit cleanly.
    b.killAll();
    console.error = origError;
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});
