import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  bifrostDefinition, bifrostStats, resetBifrostForTest, setBifrostBinaryForTest,
} from "./bifrost.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "acpg-bf-"));

afterEach(() => resetBifrostForTest());

// workspace/symbol (the warm-up) answers [] at once unless hung; definition
// answers [] after delayDefinitionMs unless hung.
function writeFakeLsp(
  dir: string,
  opts: { hangDefinition?: boolean; hangSymbol?: boolean; delayDefinitionMs?: number } = {},
): { bin: string; stamp: string; log: string } {
  const stamp = path.join(dir, "stamp");
  const log = path.join(dir, "log");
  fs.writeFileSync(stamp, "");
  fs.writeFileSync(log, "");
  const bin = path.join(dir, "fake-lsp");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(stamp)}, String(process.pid) + "\\n");
const hang = ${opts.hangDefinition ? "true" : "false"};
const hangSymbol = ${opts.hangSymbol ? "true" : "false"};
const delay = ${opts.delayDefinitionMs ?? 0};
const log = ${JSON.stringify(log)};
let buf = Buffer.alloc(0);
function reply(id, result) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
  process.stdout.write("Content-Length: " + payload.length + "\\r\\n\\r\\n");
  process.stdout.write(payload);
}
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const headEnd = buf.indexOf("\\r\\n\\r\\n");
    if (headEnd < 0) return;
    const head = buf.subarray(0, headEnd).toString("ascii");
    const m = /content-length:\\s*(\\d+)/i.exec(head);
    if (!m) { buf = buf.subarray(headEnd + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < headEnd + 4 + len) return;
    const msg = JSON.parse(buf.subarray(headEnd + 4, headEnd + 4 + len).toString("utf8"));
    buf = buf.subarray(headEnd + 4 + len);
    fs.appendFileSync(log, process.pid + " " + String(msg.method || "") + "\\n");
    if (msg.method === "initialize") reply(msg.id, { capabilities: {} });
    else if (msg.method === "workspace/symbol" && !hangSymbol) reply(msg.id, []);
    else if (msg.method === "textDocument/definition" && !hang) setTimeout(() => reply(msg.id, []), delay);
  }
});
`);
  fs.chmodSync(bin, 0o755);
  return { bin, stamp, log };
}

function gitRepo(): string {
  const repo = tmp();
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "A.java"), "class A {}\n");
  run("add", "-A");
  run("commit", "-q", "-m", "initial");
  return repo;
}

function pids(stamp: string): number[] {
  return fs.readFileSync(stamp, "utf8").trim().split("\n").filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

// A short budget can expire before the fake has started and answered the
// warm-up; "indexing" leaves the process alone, so just ask again.
async function firstAnswer(repo: string, abs: string, dir: string, budget: number, ceiling?: number) {
  let out: Awaited<ReturnType<typeof bifrostDefinition>> = "indexing";
  for (let i = 0; i < 20 && out === "indexing"; i++) out = await bifrostDefinition(repo, abs, 0, 0, dir, budget, ceiling);
  return out;
}

const definitionsSent = (log: string) =>
  fs.readFileSync(log, "utf8").split("\n").filter((l) => l.endsWith(" textDocument/definition")).length;

test("a lookup past its budget is a miss, keeps the analyzer, and holds the next click", async () => {
  const dir = tmp();
  const { bin, stamp, log } = writeFakeLsp(dir, { delayDefinitionMs: 600 });
  setBifrostBinaryForTest(bin);
  const repo = gitRepo();
  const abs = path.join(repo, "A.java");
  assert.deepEqual(await firstAnswer(repo, abs, dir, 150), []);
  assert.equal(bifrostStats().timeouts, 1);
  // Behind it: not queued at the analyzer, where it would time out too.
  assert.equal(await bifrostDefinition(repo, abs, 0, 0, dir, 150), "indexing");
  assert.equal(definitionsSent(log), 1);
  assert.equal(bifrostStats().indexing >= 1, true);
  const [pid] = pids(stamp);
  assert.equal(alive(pid), true);
  // Once the slow lookup answers, the next click reaches the analyzer.
  await new Promise((r) => setTimeout(r, 700));
  await bifrostDefinition(repo, abs, 0, 0, dir, 150);
  assert.equal(definitionsSent(log), 2);
  assert.deepEqual(pids(stamp), [pid]);
});

test("a lookup past the ceiling kills the analyzer and warms a replacement", async () => {
  const dir = tmp();
  const { bin, stamp, log } = writeFakeLsp(dir, { hangDefinition: true });
  setBifrostBinaryForTest(bin);
  const repo = gitRepo();
  const abs = path.join(repo, "A.java");
  assert.deepEqual(await firstAnswer(repo, abs, dir, 100, 400), []);
  const [pid] = pids(stamp);
  assert.equal(alive(pid), true);
  // $/cancelRequest is best-effort on the same stdin; SIGTERM is what unsticks
  // the pipe. The log may not contain the cancel if the process died first.
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
  // The respawn is warmed without another request.
  const warmed = () => pids(stamp).length === 2 && fs.readFileSync(log, "utf8").includes(`${pids(stamp)[1]} workspace/symbol`);
  await until(warmed);
  assert.ok(warmed(), "expected a second, warmed analyzer");
  assert.equal(alive(pids(stamp)[1]), true);
});

test("a definition during the warm-up answers indexing and leaves the analyzer running", async () => {
  const dir = tmp();
  const { bin, stamp, log } = writeFakeLsp(dir, { hangSymbol: true });
  setBifrostBinaryForTest(bin);
  const repo = gitRepo();
  const abs = path.join(repo, "A.java");
  const t0 = Date.now();
  const out = await bifrostDefinition(repo, abs, 0, 0, dir, 150);
  const elapsed = Date.now() - t0;
  assert.equal(out, "indexing");
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  const s = bifrostStats();
  assert.equal(s.indexing, 1);
  assert.equal(s.timeouts, 0);
  assert.equal(s.misses, 0);
  await until(() => pids(stamp).length === 1);
  const [pid] = pids(stamp);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(pid), true);
  assert.equal(pids(stamp).length, 1);
  assert.ok(!fs.readFileSync(log, "utf8").includes("textDocument/definition"));
});

test("overlapping definition requests spawn one analyzer", async () => {
  const dir = tmp();
  const { bin, stamp } = writeFakeLsp(dir);
  setBifrostBinaryForTest(bin);
  const repo = gitRepo();
  const abs = path.join(repo, "A.java");
  await Promise.all([
    bifrostDefinition(repo, abs, 0, 0, dir, 2000),
    bifrostDefinition(repo, abs, 0, 0, dir, 2000),
  ]);
  // Both can answer "indexing" before a loaded runner has started the fake.
  await until(() => pids(stamp).length > 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pids(stamp).length, 1);
});
