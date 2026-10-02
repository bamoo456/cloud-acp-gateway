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

function writeFakeLsp(dir: string, hangDefinition: boolean): { bin: string; stamp: string; log: string } {
  const stamp = path.join(dir, "stamp");
  const log = path.join(dir, "log");
  fs.writeFileSync(stamp, "");
  fs.writeFileSync(log, "");
  const bin = path.join(dir, "fake-lsp");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(stamp)}, String(process.pid) + "\\n");
const hang = ${hangDefinition ? "true" : "false"};
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
    fs.appendFileSync(log, String(msg.method || "") + "\\n");
    if (msg.method === "initialize") reply(msg.id, { capabilities: {} });
    else if (msg.method === "textDocument/definition" && !hang) reply(msg.id, []);
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

test("a definition timeout cancels, kills the analyzer, and counts as a timeout", async () => {
  const dir = tmp();
  const { bin, stamp } = writeFakeLsp(dir, true);
  setBifrostBinaryForTest(bin);
  const repo = gitRepo();
  const abs = path.join(repo, "A.java");
  const hits = await bifrostDefinition(repo, abs, 0, 0, dir, 80);
  assert.deepEqual(hits, []);
  assert.equal(bifrostStats().timeouts, 1);
  // $/cancelRequest is best-effort on the same stdin; SIGTERM is what unsticks
  // the pipe. The log may not contain the cancel if the process died first.
  const [pid] = pids(stamp);
  assert.ok(pid > 0);
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(alive(pid), false);
});

test("overlapping definition requests spawn one analyzer", async () => {
  const dir = tmp();
  const { bin, stamp } = writeFakeLsp(dir, false);
  setBifrostBinaryForTest(bin);
  const repo = gitRepo();
  const abs = path.join(repo, "A.java");
  await Promise.all([
    bifrostDefinition(repo, abs, 0, 0, dir, 2000),
    bifrostDefinition(repo, abs, 0, 0, dir, 2000),
  ]);
  assert.equal(pids(stamp).length, 1);
});
