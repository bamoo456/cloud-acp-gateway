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

async function waitForJson(file: string): Promise<Record<string, string | undefined>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string | undefined>;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("concurrent agents receive distinct profile env without mutating the gateway env", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-spawn-env-"));
  const ledgerDir = path.join(dir, "ledger");
  fs.mkdirSync(ledgerDir);
  const script = path.join(dir, "capture-env.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    'fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), codexHome: process.env.CODEX_HOME, inherited: process.env.ACPG_TEST_INHERITED, profile: process.env.ACPG_TEST_PROFILE }));',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  const homeA = path.join(dir, "codex-a");
  const homeB = path.join(dir, "codex-b");
  const realDir = fs.realpathSync(dir);
  const outputA = path.join(dir, "a.json");
  const outputB = path.join(dir, "b.json");
  const previousInherited = process.env.ACPG_TEST_INHERITED;
  const previousHome = process.env.CODEX_HOME;
  process.env.ACPG_TEST_INHERITED = "inherited-by-both";
  const gateway = new Gateway({
    personal: {
      cmd: process.execPath,
      args: [script, outputA],
      cwd: realDir,
      env: { CODEX_HOME: homeA, ACPG_TEST_PROFILE: "personal" },
    },
    work: {
      cmd: process.execPath,
      args: [script, outputB],
      cwd: realDir,
      env: { CODEX_HOME: homeB, ACPG_TEST_PROFILE: "work" },
    },
  }, ledgerDir);
  try {
    gateway.channel("personal");
    gateway.channel("work");
    const [capturedA, capturedB] = await Promise.all([waitForJson(outputA), waitForJson(outputB)]);
    assert.deepEqual(capturedA, {
      cwd: realDir,
      codexHome: homeA,
      inherited: "inherited-by-both",
      profile: "personal",
    });
    assert.deepEqual(capturedB, {
      cwd: realDir,
      codexHome: homeB,
      inherited: "inherited-by-both",
      profile: "work",
    });
    assert.equal(process.env.ACPG_TEST_PROFILE, undefined);
    assert.equal(process.env.ACPG_TEST_INHERITED, "inherited-by-both");
    assert.equal(process.env.CODEX_HOME, previousHome);

    fs.rmSync(outputA);
    assert.equal(gateway.restartAgent("personal"), true);
    const restartedA = await waitForJson(outputA);
    assert.deepEqual(restartedA, capturedA, "restart preserves the personal profile environment");
  } finally {
    gateway.killAll();
    if (previousInherited === undefined) delete process.env.ACPG_TEST_INHERITED;
    else process.env.ACPG_TEST_INHERITED = previousInherited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
