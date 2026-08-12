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
  assert.deepEqual(JSON.parse(body()), { running: false, lastExit: null });
});

test("handleTerminal rejects non-POST on /terminal/start", () => {
  const { res, status } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/start"), res, "/terminal/start", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 405);
});

test("handleTerminal rejects non-POST on /terminal/stop", () => {
  const { res, status } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/stop"), res, "/terminal/stop", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 405);
});

test("handleTerminal rejects non-POST on /terminal/resize", () => {
  const { res, status } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/resize"), res, "/terminal/resize", 1024);
  assert.equal(handled, true);
  assert.equal(status(), 405);
});

test("handleTerminal ignores an unknown /terminal/* path", () => {
  const { res } = fakeRes();
  const handled = handleTerminal(fakeReq("/terminal/nope"), res, "/terminal/nope", 1024);
  assert.equal(handled, false);
});

// Gating lives one layer up, in gateway.ts's route dispatch (terminalEnabled
// only wraps the /terminal/* block when ACPG_TERMINAL=on) — handleTerminal
// itself has no allowlist to unit-test against, unlike login.ts's knownAgents.
// So this exercises the real HTTP surface via handleRequest, same as
// gateway.e2e.test.ts's startHttpServer helper. The npm `test` script pins
// ACPG_TERMINAL=off, alongside the other ambient config it neutralizes — the
// gateway reads a developer's .env at import, and one that legitimately turns
// the terminal on must not silently turn this gating test into a no-op.
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

test("without ACPG_TERMINAL=on, /terminal/* 404s through the real gateway", async () => {
  assert.notEqual((process.env.ACPG_TERMINAL ?? "").toLowerCase(), "on",
    "ACPG_TERMINAL must not be 'on' here — otherwise this stops testing the gate");
  const { authed, close } = await startHttpServer();
  try {
    const r = await authed("/terminal/status");
    assert.equal(r.status, 404);
  } finally {
    await close();
  }
});
