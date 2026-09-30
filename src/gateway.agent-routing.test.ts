import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-agent-routing-")));
const fsRoot = path.join(fixture, "root");
const cwd = path.join(fsRoot, "project");
const homePersonal = path.join(fixture, "home-personal");
const homeWork = path.join(fixture, "home-work");
const codexHomePersonal = path.join(homePersonal, ".codex");
const codexHomeWork = path.join(homeWork, ".codex");
const ledgerDir = path.join(fixture, "ledger");
const fakeCodex = path.join(fixture, "codex-acp");
const agentsFile = path.join(fixture, "agents.json");
for (const dir of [fsRoot, cwd, homePersonal, homeWork, codexHomePersonal, codexHomeWork, ledgerDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(fakeCodex, "#!/bin/sh\n");
fs.chmodSync(fakeCodex, 0o755);

function writeRollout(home: string, sessionId: string, title: string, text: string): void {
  const dir = path.join(home, "sessions", "2026", "09", "01");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`), [
    { type: "session_meta", payload: { id: sessionId, cwd, timestamp: "2026-09-01T10:00:00.000Z", source: "cli" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({
    id: sessionId, thread_name: title, updated_at: "2026-09-01T10:00:00.000Z",
  }) + "\n");
}

writeRollout(codexHomePersonal, "PERSONAL-SESSION", "Personal account", "personal marker");
writeRollout(codexHomeWork, "WORK-SESSION", "Work account", "work marker");
fs.writeFileSync(path.join(codexHomePersonal, "auth.json"), JSON.stringify({ tokens: { access_token: "personal-token" } }));
fs.writeFileSync(path.join(codexHomeWork, "auth.json"), JSON.stringify({ tokens: { access_token: "work-token" } }));
fs.writeFileSync(agentsFile, JSON.stringify({
  personal: { cmd: fakeCodex, args: [], cwd, env: { HOME: homePersonal } },
  work: { cmd: fakeCodex, args: [], cwd, env: { HOME: homeWork } },
}));

const changedEnv = new Map<string, string | undefined>();
const configuredEnv: Record<string, string> = {
  ACPG_AGENTS_FILE: agentsFile,
  ACPG_AUTH_USER: "routing-user",
  ACPG_AUTH_TOKEN: "routing-token",
  ACPG_CONSOLE: "on",
  ACPG_DEFAULT_AGENT: "personal",
  ACPG_FS_ROOT: fsRoot,
  ACPG_LEDGER_DIR: ledgerDir,
  ACPG_NO_LISTEN: "1",
  ACPG_TERMINAL: "off",
  ACPG_TLS: "off",
};
for (const [key, value] of Object.entries(configuredEnv)) {
  changedEnv.set(key, process.env[key]);
  process.env[key] = value;
}
changedEnv.set("CODEX_HOME", process.env.CODEX_HOME);
process.env.CODEX_HOME = "";

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!target.startsWith("https://chatgpt.com/")) return nativeFetch(input, init);
  const token = new Headers(init?.headers).get("authorization");
  const usedPercent = token === "Bearer personal-token" ? 12 : 87;
  return new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 18000 } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const authHeader = "Basic " + Buffer.from("routing-user:routing-token", "utf8").toString("base64");
let handleRequest: typeof import("./gateway.ts").handleRequest | undefined;

async function startHttpServer(): Promise<{ get: (route: string) => Promise<Response>; close: () => Promise<void> }> {
  if (!handleRequest) {
    handleRequest = (await import("./gateway.ts")).handleRequest;
    delete process.env.CODEX_HOME;
  }
  const server = http.createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    get: (route) => nativeFetch(base + route, { headers: { authorization: authHeader } }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("HTTP history, search, and quota routes select named Codex HOME profiles", async () => {
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    server = await startHttpServer();
    const personalHistory = await server.get(`/history?agent=personal&cwd=${encodeURIComponent(cwd)}`);
    assert.equal(personalHistory.status, 200);
    const personalBody = await personalHistory.json() as { sessions: Array<{ sessionId: string; title: string }> };
    assert.deepEqual(personalBody.sessions.map((s) => [s.sessionId, s.title]), [["PERSONAL-SESSION", "Personal account"]]);

    const workMessages = await server.get(`/history/messages?agent=work&cwd=${encodeURIComponent(cwd)}&session=WORK-SESSION`);
    assert.equal(workMessages.status, 200);
    const workBody = await workMessages.json() as { messages: Array<{ blocks: Array<{ text?: string }> }> };
    assert.deepEqual(workBody.messages.flatMap((message) => message.blocks.map((block) => block.text)), ["work marker"]);

    const search = await server.get(`/history/search?agent=work&q=${encodeURIComponent("work marker")}&all=1`);
    assert.equal(search.status, 200);
    const searchBody = await search.json() as { results: Array<{ sessionId: string; agentName: string }> };
    assert.deepEqual(searchBody.results.map((row) => [row.sessionId, row.agentName]), [["WORK-SESSION", "work"]]);

    const personalUsage = await server.get("/usage/limits?kind=codex&agent=personal");
    const workUsage = await server.get("/usage/limits?kind=codex&agent=work");
    assert.equal(personalUsage.status, 200);
    assert.equal(workUsage.status, 200);
    const personalQuota = await personalUsage.json() as { status: string; windows: Record<string, { utilization: number }> };
    const workQuota = await workUsage.json() as { status: string; windows: Record<string, { utilization: number }> };
    assert.equal(personalQuota.status, "ok");
    assert.equal(workQuota.status, "ok");
    assert.equal(personalQuota.windows.five_hour.utilization, 0.12);
    assert.equal(workQuota.windows.five_hour.utilization, 0.87);

    const unknownAgent = await server.get("/usage/limits?kind=codex&agent=missing");
    assert.equal(unknownAgent.status, 400);
    const mismatchedAgent = await server.get("/usage/limits?kind=claude&agent=work");
    assert.equal(mismatchedAgent.status, 400);

    for (const agent of ["constructor", "__proto__", "toString"]) {
      const encodedAgent = encodeURIComponent(agent);
      const invalidUsage = await server.get(`/usage/limits?kind=codex&agent=${encodedAgent}`);
      assert.equal(invalidUsage.status, 400, `usage should reject unconfigured agent ${agent}`);
      const invalidHistory = await server.get(`/history?agent=${encodedAgent}&cwd=${encodeURIComponent(cwd)}`);
      assert.equal(invalidHistory.status, 400, `history should reject unconfigured agent ${agent}`);
    }

    const ambiguous = await server.get("/usage/limits?kind=codex");
    assert.equal(ambiguous.status, 200);
    assert.deepEqual(await ambiguous.json(), { status: "unavailable", reason: "ambiguous-agent" });
    process.env.CODEX_HOME = codexHomePersonal;
    const kindOnly = await server.get("/usage/limits?kind=codex");
    assert.equal(kindOnly.status, 200);
    const kindOnlyQuota = await kindOnly.json() as { status: string; windows: Record<string, { utilization: number }> };
    assert.equal(kindOnlyQuota.status, "ok");
    assert.equal(kindOnlyQuota.windows.five_hour.utilization, 0.12);
  } finally {
    await server?.close();
    globalThis.fetch = nativeFetch;
    for (const [key, value] of changedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
