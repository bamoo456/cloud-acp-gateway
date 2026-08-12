import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileIndex } from "./file-index.ts";

function makeRepo(files: string[]): { dir: string; run: (...a: string[]) => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fi-")));
  const run = (...args: string[]) => void execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x\n");
  }
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return { dir, run };
}

describe("FileIndex git corpus", () => {
  test("serves tracked paths with precomputed lowercase and basename arrays", async () => {
    const { dir } = makeRepo(["A.ts", "src/Deep/B.TSX"]);
    const idx = new FileIndex();
    const c = await idx.corpusGit(dir);
    assert.deepEqual([...c.paths].sort(), ["A.ts", "src/Deep/B.TSX"]);
    const i = c.paths.indexOf("src/Deep/B.TSX");
    assert.equal(c.lower[i], "src/deep/b.tsx");
    assert.equal(c.bases[i], "b.tsx");
    assert.equal(c.fromGit, true);
    assert.equal(c.pending, true, "no status snapshot yet: untracked half missing");
  });

  test("a second call reuses the corpus object; a git index change rebuilds it", async () => {
    const { dir, run } = makeRepo(["a.ts"]);
    const idx = new FileIndex();
    const c1 = await idx.corpusGit(dir);
    assert.equal(await idx.corpusGit(dir), c1, "unchanged index → same object, no re-list");
    fs.writeFileSync(path.join(dir, "b.ts"), "x\n");
    run("add", "b.ts"); // rewrites .git/index → mtime/size change
    const c2 = await idx.corpusGit(dir);
    assert.notEqual(c2, c1);
    assert.ok(c2.paths.includes("b.ts"));
  });

  test("noteStatus merges untracked in, subtracts worktree deletions, and marks changed", async () => {
    const { dir } = makeRepo(["kept.ts", "gone.ts"]);
    const idx = new FileIndex();
    await idx.corpusGit(dir);
    idx.noteStatus(dir, [
      { path: "new.ts", status: "untracked" },
      { path: "gone.ts", status: "deleted" },
      { path: "kept.ts", status: "modified" },
    ]);
    const c = await idx.corpusGit(dir);
    assert.equal(c.pending, false);
    assert.ok(c.paths.includes("new.ts"), "untracked joined the corpus without any --others walk");
    assert.ok(!c.paths.includes("gone.ts"), "worktree-deleted no longer listed (it would 404 on open)");
    assert.ok(c.changed.has("kept.ts") && c.changed.has("new.ts"));
  });

  test("noteStatus for an unknown root is a no-op, not a crash", () => {
    new FileIndex().noteStatus("/nowhere", [{ path: "x", status: "untracked" }]);
  });

  test("evicts the least-recently-used root beyond the cap", async () => {
    const repos = [makeRepo(["a.ts"]), makeRepo(["b.ts"]), makeRepo(["c.ts"]), makeRepo(["d.ts"])];
    const idx = new FileIndex();
    const first = await idx.corpusGit(repos[0].dir);
    for (const r of repos.slice(1)) await idx.corpusGit(r.dir);
    // Root 0 was evicted (cap is 3): asking again rebuilds rather than reusing.
    assert.notEqual(await idx.corpusGit(repos[0].dir), first);
  });
});

describe("FileIndex walk corpus", () => {
  test("lists files under a non-git folder, honoring the ignore list and depth", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fw-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/a.ts"), "x");
    fs.writeFileSync(path.join(dir, "node_modules/x/b.js"), "x");
    const idx = new FileIndex();
    const c = await idx.corpusWalk(dir);
    assert.deepEqual(c.paths, ["src/a.ts"]);
    assert.equal(c.fromGit, false);
    assert.equal(c.pending, false);
  });

  test("caches within the TTL and re-walks after it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fw-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "x");
    let clock = 0;
    const idx = new FileIndex(() => clock);
    const c1 = await idx.corpusWalk(dir);
    fs.writeFileSync(path.join(dir, "b.ts"), "x");
    clock = 10_000; // inside TTL: stale by design
    assert.equal(await idx.corpusWalk(dir), c1);
    clock = 40_000; // past TTL (30s): fresh walk sees b.ts
    const c2 = await idx.corpusWalk(dir);
    assert.ok(c2.paths.includes("b.ts"));
  });
});
