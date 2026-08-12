import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changes, fileDiff, preview, repoRoot, outputFolder,
  parseStatusZ, parseNumstatZ, looksBinary, inlineImageType, sortTreeEntries,
  MAX_TEXT_BYTES, MAX_OUTPUT_FILES, type TreeEntry,
} from "./workspace.ts";

// A throwaway checkout per suite run. `changes`/`fileDiff` shell out to real
// git, so the fixture has to be a real repo — parsing tests below cover the
// output shapes git only produces for paths we can't easily create here
// (spaces, non-ASCII, copies).
function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-ws-")));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "kept.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  run("add", "-A");
  run("commit", "-q", "-m", "initial");
  return dir;
}

describe("parseStatusZ", () => {
  test("reads the porcelain status columns into one status per file", () => {
    const out = " M src/a.ts\0A  src/new.ts\0 D old.ts\0?? scratch.png\0";
    assert.deepEqual(parseStatusZ(out), [
      { path: "src/a.ts", oldPath: undefined, status: "modified", staged: false },
      { path: "src/new.ts", oldPath: undefined, status: "added", staged: true },
      { path: "old.ts", oldPath: undefined, status: "deleted", staged: false },
      { path: "scratch.png", oldPath: undefined, status: "untracked", staged: false },
    ]);
  });

  test("consumes a rename's origin record instead of reading it as a status line", () => {
    // Without the ++i in the parser, "src/old.ts" would come back as a bogus
    // entry whose status was read out of the middle of a filename.
    const out = "R  src/new.ts\0src/old.ts\0 M other.ts\0";
    assert.deepEqual(parseStatusZ(out), [
      { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", staged: true },
      { path: "other.ts", oldPath: undefined, status: "modified", staged: false },
    ]);
  });

  test("keeps paths with spaces and non-ASCII intact (why -z is used)", () => {
    const out = "?? docs/設計 稿.png\0";
    assert.deepEqual(parseStatusZ(out).map((f) => f.path), ["docs/設計 稿.png"]);
  });

  test("a staged add edited again in the worktree still reads as an add", () => {
    assert.equal(parseStatusZ("AM src/a.ts\0")[0].status, "added");
  });
});

describe("parseNumstatZ", () => {
  test("reads line counts, and the rename form's trailing path pair", () => {
    const out = "3\t1\tsrc/a.ts\0" + "10\t0\t\0src/old.ts\0src/new.ts\0";
    assert.deepEqual(parseNumstatZ(out), [
      { path: "src/a.ts", oldPath: undefined, additions: 3, deletions: 1, binary: false },
      { path: "src/new.ts", oldPath: "src/old.ts", additions: 10, deletions: 0, binary: false },
    ]);
  });

  test("flags git's binary marker instead of reading '-' as a count", () => {
    const [row] = parseNumstatZ("-\t-\tlogo.png\0");
    assert.equal(row.binary, true);
    assert.equal(row.additions, 0);
    assert.equal(row.deletions, 0);
  });
});

describe("looksBinary", () => {
  test("a NUL byte settles it", () => {
    assert.equal(looksBinary(Buffer.from("plain text")), false);
    assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])), true);
  });

  test("UTF-8 text is not mistaken for binary", () => {
    assert.equal(looksBinary(Buffer.from("預覽這個檔案\n// ok\n", "utf8")), false);
  });

  test("an empty file is text, not binary", () => {
    assert.equal(looksBinary(Buffer.alloc(0)), false);
  });
});

describe("inlineImageType", () => {
  test("allows raster images, case-insensitively", () => {
    assert.equal(inlineImageType("/tmp/shot.PNG"), "image/png");
    assert.equal(inlineImageType("/tmp/a.jpeg"), "image/jpeg");
  });

  test("refuses SVG — it is script-capable XML served from the console origin", () => {
    assert.equal(inlineImageType("/tmp/icon.svg"), null);
    assert.equal(inlineImageType("/tmp/page.html"), null);
    assert.equal(inlineImageType("/tmp/notes.txt"), null);
  });
});

describe("changes", () => {
  test("lists modified, added, deleted and untracked files with line counts", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "kept.txt"), "one\ntwo\nthree\nfour\n");
    fs.writeFileSync(path.join(dir, "fresh.md"), "# new\n");
    fs.rmSync(path.join(dir, "gone.txt"));

    const r = await changes(dir);
    assert.equal(r.repo, dir);
    assert.equal(r.truncated, false);
    const byPath = new Map(r.files.map((f) => [f.path, f] as const));
    assert.equal(byPath.get("kept.txt")?.status, "modified");
    assert.equal(byPath.get("kept.txt")?.additions, 1);
    assert.equal(byPath.get("kept.txt")?.deletions, 0);
    assert.equal(byPath.get("fresh.md")?.status, "untracked");
    assert.equal(byPath.get("gone.txt")?.status, "deleted");
    // Every entry carries the absolute path the other endpoints address it by.
    assert.equal(byPath.get("kept.txt")?.abs, path.join(dir, "kept.txt"));
  });

  test("a folder that isn't a checkout reports no repo rather than failing", async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-plain-")));
    const r = await changes(plain);
    assert.equal(r.repo, null);
    assert.deepEqual(r.files, []);
    assert.equal(r.reason, "not-a-repo");
  });

  test("finds the repo root from a subdirectory, and paths stay root-relative", async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "web", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "web", "src", "App.tsx"), "export {}\n");
    assert.equal(await repoRoot(path.join(dir, "web")), dir);
    const r = await changes(path.join(dir, "web"));
    assert.equal(r.repo, dir);
    assert.ok(r.files.some((f) => f.path === "web/src/App.tsx"));
  });
});

describe("fileDiff", () => {
  test("diffs a tracked file against HEAD, covering staged and unstaged work alike", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "kept.txt"), "one\nTWO\nthree\n");
    execFileSync("git", ["add", "kept.txt"], { cwd: dir, stdio: "pipe" });
    fs.appendFileSync(path.join(dir, "kept.txt"), "four\n");

    const d = await fileDiff(dir, path.join(dir, "kept.txt"));
    assert.equal(d.path, "kept.txt");
    assert.equal(d.status, "modified");
    assert.equal(d.binary, false);
    assert.match(d.diff, /^\+TWO$/m);   // staged edit
    assert.match(d.diff, /^\+four$/m);  // unstaged edit
    assert.match(d.diff, /^-two$/m);
  });

  test("an untracked file diffs as entirely new instead of reading as unchanged", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "fresh.md"), "# new\nbody\n");
    const d = await fileDiff(dir, path.join(dir, "fresh.md"));
    assert.equal(d.status, "untracked");
    assert.match(d.diff, /^\+# new$/m);
    assert.match(d.diff, /^\+body$/m);
  });

  test("a deleted file diffs as removed lines", async () => {
    const dir = makeRepo();
    fs.rmSync(path.join(dir, "gone.txt"));
    const d = await fileDiff(dir, path.join(dir, "gone.txt"));
    assert.equal(d.status, "deleted");
    assert.match(d.diff, /^-bye$/m);
  });

  test("a binary file is flagged rather than returned as an unreadable diff", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    const d = await fileDiff(dir, path.join(dir, "blob.bin"));
    assert.equal(d.binary, true);
    assert.equal(d.diff, "");
  });

  test("a checkout with no commits yet diffs its tracked files as new", async () => {
    // `git diff HEAD` errors outright here — the fallback is what keeps the
    // panel usable in a repo whose first commit hasn't happened.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-empty-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir, stdio: "pipe" });
    const d = await fileDiff(dir, path.join(dir, "a.txt"));
    assert.equal(d.status, "added");
    assert.match(d.diff, /^\+hello$/m);
  });
});

describe("preview", () => {
  test("returns text with its size and mtime", async () => {
    const dir = makeRepo();
    const p = await preview(path.join(dir, "kept.txt"), "kept.txt");
    assert.equal(p?.kind, "text");
    assert.equal(p?.text, "one\ntwo\nthree\n");
    assert.equal(p?.truncated, false);
    assert.equal(p?.size, 14);
    assert.ok(p && !Number.isNaN(Date.parse(p.modifiedAt)));
  });

  test("an image reports its type without reading the bytes into JSON", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const p = await preview(path.join(dir, "shot.png"), "shot.png");
    assert.equal(p?.kind, "image");
    assert.equal(p?.mimeType, "image/png");
    assert.equal(p?.text, undefined);
  });

  test("a binary file is reported as binary, not as mojibake text", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    const p = await preview(path.join(dir, "blob.bin"), "blob.bin");
    assert.equal(p?.kind, "binary");
    assert.equal(p?.text, undefined);
  });

  test("an oversized text file is cut at the cap and says so", async () => {
    const dir = makeRepo();
    const big = path.join(dir, "big.txt");
    fs.writeFileSync(big, "x".repeat(MAX_TEXT_BYTES + 500));
    const p = await preview(big, "big.txt");
    assert.equal(p?.kind, "text");
    assert.equal(p?.truncated, true);
    assert.equal(p?.text?.length, MAX_TEXT_BYTES);
    assert.equal(p?.size, MAX_TEXT_BYTES + 500);
  });

  test("a missing path or a directory yields null (the route's 404)", async () => {
    const dir = makeRepo();
    assert.equal(await preview(path.join(dir, "nope.txt"), "nope.txt"), null);
    assert.equal(await preview(dir, "."), null);
  });
});

describe("sortTreeEntries", () => {
  const entry = (name: string, dir = false): TreeEntry => ({ name, abs: "/x/" + name, dir });

  test("folders lead, then files, each read alphabetically by a human", async () => {
    const sorted = sortTreeEntries([
      entry("README.md"), entry("src", true), entry(".env"), entry("Makefile"),
      entry(".github", true), entry("api.ts"),
    ]).map((e) => e.name);
    // Case-insensitive: an ASCII sort puts every capitalised file above every
    // lowercase one, which is not how anyone scans a directory.
    assert.deepEqual(sorted, [".github", "src", ".env", "api.ts", "Makefile", "README.md"]);
  });

  test("leaves its input alone", async () => {
    const input = [entry("b"), entry("a")];
    sortTreeEntries(input);
    assert.deepEqual(input.map((e) => e.name), ["b", "a"]);
  });
});

describe("outputFolder", () => {
  // A scratch folder the way an agent actually leaves one: one file it wrote
  // with a tool call, several it generated through a shell, and a subfolder of
  // assets. None of it is in a checkout, so this walk is the only thing that can
  // see any of it.
  function makeScratch(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-out-")));
    fs.mkdirSync(path.join(dir, "png"));
    fs.writeFileSync(path.join(dir, "mockup.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "generated.html"), "<html>heredoc</html>");
    fs.writeFileSync(path.join(dir, "png", "shot.png"), "x");
    return dir;
  }

  test("lists the folder whole, one level down, newest first", async () => {
    const dir = makeScratch();
    // mtimes are set explicitly: the panel is opened right after a turn, so the
    // order has to be "what was just written", and a fixture written in one tick
    // cannot demonstrate that on its own.
    const t = Date.now();
    fs.utimesSync(path.join(dir, "mockup.html"), t / 1000 - 60, t / 1000 - 60);
    fs.utimesSync(path.join(dir, "png", "shot.png"), t / 1000 - 30, t / 1000 - 30);
    fs.utimesSync(path.join(dir, "generated.html"), t / 1000, t / 1000);
    const out = await outputFolder(dir);
    assert.deepEqual(out?.files.map((f) => f.path), ["generated.html", "png/shot.png", "mockup.html"]);
    assert.equal(out?.truncated, false);
    assert.equal(out?.files[0].abs, path.join(dir, "generated.html"));
    assert.equal(out?.files[0].size, "<html>heredoc</html>".length);
  });

  test("says so when a level below the walk was left out", async () => {
    const dir = makeScratch();
    fs.mkdirSync(path.join(dir, "png", "thumbs"));
    fs.writeFileSync(path.join(dir, "png", "thumbs", "deep.png"), "x");
    const out = await outputFolder(dir);
    // The file two levels down is absent, which is the cap doing its job — but a
    // listing that quietly stopped would read as "that's all there is".
    assert.ok(!out?.files.some((f) => f.path.includes("thumbs")));
    assert.equal(out?.truncated, true);
  });

  test("caps the list and says so", async () => {
    const dir = makeScratch();
    for (let i = 0; i < MAX_OUTPUT_FILES + 10; i++) {
      fs.writeFileSync(path.join(dir, "frame-" + i + ".png"), "x");
    }
    const out = await outputFolder(dir);
    assert.equal(out?.files.length, MAX_OUTPUT_FILES);
    assert.equal(out?.truncated, true);
  });

  test("never follows a symlinked directory", async () => {
    const dir = makeScratch();
    // A loop here would hang the request, and the interesting case is generated
    // files rather than wherever a link happens to point.
    fs.symlinkSync(dir, path.join(dir, "loop"));
    const out = await outputFolder(dir);
    assert.ok(!out?.files.some((f) => f.path.startsWith("loop/")));
  });

  test("a file or a missing path yields null, not an empty folder", async () => {
    const dir = makeScratch();
    assert.equal(await outputFolder(path.join(dir, "mockup.html")), null);
    assert.equal(await outputFolder(path.join(dir, "nope")), null);
  });
});
