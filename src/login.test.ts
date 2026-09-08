import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSession, handleLogin, registerLoginAgent } from "./login.ts";

// Minimal req/res doubles — enough for the routing/validation paths that don't
// spawn a PTY (status + the unknown-agent rejection).
function fakeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}
function fakeRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) { status = code; return res; },
    write(chunk: string) { body += chunk; return true; },
    end(chunk?: string) { if (chunk) body += chunk; return res; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

test("handleLogin rejects an unregistered agent with 404 and spawns nothing", () => {
  const { res, status, body } = fakeRes();
  const handled = handleLogin(fakeReq("/login/status?agent=not-a-real-agent"), res, "/login/status", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 404);
  assert.match(body(), /unknown agent/);
});

test("handleLogin serves /login/status for a registered agent without starting a PTY", () => {
  registerLoginAgent("test-claude", "claude");
  const { res, status, body } = fakeRes();
  const handled = handleLogin(fakeReq("/login/status?agent=test-claude"), res, "/login/status", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 200);
  // status() reports a never-started session: not running, no recorded exit.
  assert.deepEqual(JSON.parse(body()), { running: false, lastExit: null });
});

test("handleLogin runs the default ?agent=claude through the allowlist too", () => {
  // A missing ?agent= falls back to "claude", but that name is never registered
  // in this test process, so it must still be rejected — the default isn't an
  // implicit bypass of the allowlist.
  const { res, status } = fakeRes();
  handleLogin(fakeReq("/login/status"), res, "/login/status", 1024);
  assert.equal(status(), 404);
});

test("a login PTY receives the registered agent env and cwd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-login-env-"));
  const script = path.join(dir, "capture-login-env.mjs");
  const output = path.join(dir, "env.json");
  const realDir = fs.realpathSync(dir);
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    'fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), codexHome: process.env.CODEX_HOME, inherited: process.env.ACPG_TEST_INHERITED, profile: process.env.ACPG_TEST_PROFILE }));',
  ].join("\n"));
  const name = `fixtureLogin${Date.now()}`;
  const cmdKey = `ACPG_${name.toUpperCase()}_LOGIN_CMD`;
  const argsKey = `ACPG_${name.toUpperCase()}_LOGIN_ARGS`;
  const home = path.join(dir, "codex-home");
  const previous = new Map([
    [cmdKey, process.env[cmdKey]],
    [argsKey, process.env[argsKey]],
    ["ACPG_TEST_INHERITED", process.env.ACPG_TEST_INHERITED],
    ["CODEX_HOME", process.env.CODEX_HOME],
  ]);
  process.env[cmdKey] = process.execPath;
  process.env[argsKey] = `${script} ${output}`;
  process.env.ACPG_TEST_INHERITED = "inherited-by-login";
  registerLoginAgent(name, "codex", { CODEX_HOME: home, ACPG_TEST_PROFILE: "login" }, realDir);
  const session = getSession(name);
  try {
    session.start();
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(output) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(output), true, "fixture login command ran");
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      cwd: realDir,
      codexHome: home,
      inherited: "inherited-by-login",
      profile: "login",
    });
    assert.equal(process.env.ACPG_TEST_PROFILE, undefined);
  } finally {
    session.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
