import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLogin, registerLoginAgent } from "./login.ts";

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
