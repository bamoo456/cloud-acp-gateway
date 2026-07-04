import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFiles, resolveWithinRoot } from "./gateway.ts";

// listFiles walks whatever absolute dir it is handed (the endpoint resolves that
// dir within FS_ROOT first), so a throwaway tree under tmpdir exercises it fully.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpb-files-")));
function write(rel: string, body = "x") {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
write("README.md");
write("src/App.tsx");
write("src/index.ts");
write(".git/config");
write(".env", "secret");
write("node_modules/dep/index.js");

test("listFiles returns cwd-relative files, skipping dotfiles/.git/node_modules", async () => {
  assert.deepEqual(await listFiles(root), ["README.md", "src/App.tsx", "src/index.ts"]);
});

test("listFiles filters by a case-insensitive substring of the path", async () => {
  assert.deepEqual(await listFiles(root, "app"), ["src/App.tsx"]);
  assert.deepEqual(await listFiles(root, "src/"), ["src/App.tsx", "src/index.ts"]);
  assert.deepEqual(await listFiles(root, "nope"), []);
});

test("listFiles ranks basename matches ahead of deeper/longer paths", async () => {
  write("lib/readme-helper.ts");
  const files = await listFiles(root, "readme");
  assert.equal(files[0], "README.md"); // basename hit + shorter beats lib/readme-helper.ts
  assert.ok(files.includes("lib/readme-helper.ts"));
});

test("listFiles honours the result cap", async () => {
  const many = path.join(root, "many");
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "x");
  assert.equal((await listFiles(many, "", 5)).length, 5);
});

// FS_ROOT defaults to the home dir under the test runner (no ACPG_FS_ROOT set),
// so anchor the scoping checks on the home dir.
test("resolveWithinRoot accepts the root and descendants, rejects escapes", () => {
  const home = fs.realpathSync(os.homedir());
  assert.equal(resolveWithinRoot(home), home);
  assert.equal(resolveWithinRoot(path.join(home, "some", "nested", "path")), path.join(home, "some", "nested", "path"));
  assert.equal(resolveWithinRoot(""), null);
  assert.equal(resolveWithinRoot("/"), null);
  // /etc resolves outside the home-dir root.
  assert.equal(resolveWithinRoot("/etc"), null);
});
