import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitTokens } from "./git-exec.ts";

function makeRepo(files: string[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-gx-")));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x\n");
  }
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return dir;
}

describe("gitTokens", () => {
  test("streams NUL-separated ls-files output into whole tokens", async () => {
    const repo = makeRepo(["a.ts", "src/b.ts", "src/深い/設計 稿.png"]);
    const r = await gitTokens(repo, ["ls-files", "-z", "--cached"], 10_000);
    assert.equal(r.code, 0);
    assert.equal(r.failed, false);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.tokens.sort(), ["a.ts", "src/b.ts", "src/深い/設計 稿.png"]);
  });
  test("caps at maxTokens, kills the child, and says so", async () => {
    const repo = makeRepo(["a.ts", "b.ts", "c.ts", "d.ts"]);
    const r = await gitTokens(repo, ["ls-files", "-z", "--cached"], 2);
    assert.equal(r.truncated, true);
    assert.equal(r.tokens.length, 2);
  });
  test("a non-repo directory reports git's failure code, not a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-gx-plain-"));
    const r = await gitTokens(dir, ["ls-files", "-z", "--cached"], 10);
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.tokens, []);
  });
});
