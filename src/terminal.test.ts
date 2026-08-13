import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleTerminal } from "./terminal.ts";
import { handleRequest } from "./gateway.ts";

// Minimal req/res doubles — enough for the routing/validation paths that don't
// spawn a PTY (status, method checks, unknown route), mirroring login.test.ts.
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

test("handleTerminal serves /terminal/status without starting a shell", () => {
  const { res, status, body } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/status"), res, "/terminal/status", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 200);
  // No tab has been opened in this process, so there is nothing to report.
  assert.deepEqual(JSON.parse(body()), { sessions: [] });
});

test("handleTerminal rejects non-POST on /terminal/start", () => {
  const { res, status } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/start?id=t1"), res, "/terminal/start", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 405);
});

// Everything but /terminal/status addresses one tab, so a request that names no
// tab — or names one that was never started — must not fall through to some
// other session. Neither spawns a shell.
test("handleTerminal rejects a missing or malformed id with 400", () => {
  for (const url of ["/terminal/stop", "/terminal/stop?id=", "/terminal/stop?id=has spaces", "/terminal/stop?id=" + "x".repeat(65)]) {
    const { res, status, body } = fakeRes();
    const handled = handleTerminal(fakeReq(url, "POST"), res, "/terminal/stop", 1024);
    assert.equal(handled, true, url);
    assert.equal(status(), 400, url);
    assert.match(body(), /bad or missing id/);
  }
});

test("handleTerminal treats /terminal/rename as one of the id-scoped routes", () => {
  // Renaming a tab that doesn't exist is a 404 like every other id route, not a
  // silent no-op that leaves the client thinking the name stuck.
  const { res, status } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/rename?id=never-started", "POST"), res, "/terminal/rename", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 404);
});

test("handleTerminal 404s an id with no live shell behind it", () => {
  const { res, status, body } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/stop?id=never-started", "POST"), res, "/terminal/stop", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 404);
  assert.match(body(), /unknown terminal/);
});

test("handleTerminal ignores an unknown /terminal/* path", () => {
  const { res } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/nope"), res, "/terminal/nope", 1024);
  assert.equal(handled, false);
});

// The kill switch lives one layer up, in gateway.ts's route dispatch
// (terminalEnabled stops wrapping the /terminal/* block at ACPG_TERMINAL=off)
// — handleTerminal itself has no allowlist to unit-test against, unlike
// login.ts's knownAgents. So this exercises the real HTTP surface via
// handleRequest, same as gateway.e2e.test.ts's startHttpServer helper.
//
// The npm `test` script pins ACPG_TERMINAL=off, alongside the other ambient
// config it neutralizes. That pin is what this test asserts against: the
// terminal is ON by default, so an unset value would leave the route mounted
// and this test would fail rather than silently pass.
const authHeader = (user: string, pass: string) =>
  "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");

function startHttpServer(): Promise<{ authed: (p: string) => Promise<Response>; close: () => Promise<void> }> {
  const srv = http.createServer(handleRequest);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const authed = (p: string) => fetch(base + p, {
        headers: { authorization: authHeader(process.env.ACPG_AUTH_USER ?? "", process.env.ACPG_AUTH_TOKEN ?? "") },
      });
      resolve({ authed, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

test("with ACPG_TERMINAL=off, /terminal/* 404s through the real gateway", async () => {
  assert.equal((process.env.ACPG_TERMINAL ?? "").toLowerCase(), "off",
    "the test script must pin ACPG_TERMINAL=off — the terminal is on by default, so there is no kill switch to test otherwise");
  const { authed, close } = await startHttpServer();
  try {
    const r = await authed("/terminal/status");
    assert.equal(r.status, 404);
  } finally {
    await close();
  }
});
