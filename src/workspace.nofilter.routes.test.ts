import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

// The companion to workspace.routes.test.ts, for the other setting of the
// toggle. It needs its own file rather than its own test: the preview roots and
// ACPG_PREVIEW_FILTER_ENABLED are read once, at gateway.ts import time, so the
// two settings cannot coexist in one module. `node --test` gives each file its
// own process, so the env below is this file's alone.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-nofilter-root-")));
process.env.ACPG_FS_ROOT = ROOT;
// Deliberately somewhere no rule would reach: not the cwd, not its repo, not an
// ACPG_PREVIEW_ROOTS entry — the whole point is that none of that is consulted.
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-nofilter-outside-")));
fs.writeFileSync(path.join(OUTSIDE, "note.txt"), "read with the filter off\n");
fs.writeFileSync(path.join(OUTSIDE, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
process.env.ACPG_PREVIEW_ROOTS = "";
process.env.ACPG_PREVIEW_FILTER_ENABLED = "0";

const REPO = path.join(ROOT, "project");
fs.mkdirSync(REPO);
const run = (...args: string[]) => execFileSync("git", args, { cwd: REPO, stdio: "pipe" });
run("init", "-q", "-b", "main");
run("config", "user.email", "test@example.com");
run("config", "user.name", "Test");
fs.writeFileSync(path.join(REPO, "kept.txt"), "one\ntwo\n");
run("add", "-A");
run("commit", "-q", "-m", "initial");

const authHeader = "Basic " + Buffer.from(
  `${process.env.ACPG_AUTH_USER ?? ""}:${process.env.ACPG_AUTH_TOKEN ?? ""}`, "utf8",
).toString("base64");

async function startHttpServer(): Promise<{ get: (p: string) => Promise<Response>; close: () => Promise<void> }> {
  const { handleRequest } = await import("./gateway.ts");
  const srv = http.createServer(handleRequest);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        get: (p) => fetch(base + p, { headers: { authorization: authHeader } }),
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

const q = (route: string, params: Record<string, string>) =>
  route + "?" + new URLSearchParams(params).toString();

test("with the filter off, a file outside the project and outside every preview root is served", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/file", { cwd: REPO, path: path.join(OUTSIDE, "note.txt") }));
    assert.equal(r.status, 200);
    const body = await r.json() as { text: string; path: string };
    assert.equal(body.text, "read with the filter off\n");
    // Outside cwd, so it keeps its absolute path rather than a "../" chain.
    assert.equal(body.path, path.join(OUTSIDE, "note.txt"));

    const raw = await get(q("/workspace/raw", { cwd: REPO, path: path.join(OUTSIDE, "shot.png") }));
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    await raw.arrayBuffer();
  } finally {
    await close();
  }
});

test("with the filter off, the project's own files still read by their short relative path", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/file", { cwd: REPO, path: "kept.txt" }));
    assert.equal(r.status, 200);
    const body = await r.json() as { text: string; path: string };
    assert.equal(body.text, "one\ntwo\n");
    assert.equal(body.path, "kept.txt");
  } finally {
    await close();
  }
});

test("with the filter off, a missing file is still 'not found', not 'outside the project'", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/file", { cwd: REPO, path: path.join(OUTSIDE, "gone.txt") }));
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "not-found");
  } finally {
    await close();
  }
});

// The toggle governs which FILES are readable, not which folders a client may
// claim to be working in — ACPG_FS_ROOT is a separate axis and stays on.
test("with the filter off, an output folder is still listed — the temp dir is its own boundary", async () => {
  const { get, close } = await startHttpServer();
  try {
    // ACPG_PREVIEW_ROOTS is empty here, which is the normal state once the filter
    // is off. If the relevance rule depended on it, the whole feature would
    // quietly do nothing on exactly the hosts that opted into reading anything —
    // so the temp dir is a boundary unconditionally, and its children qualify.
    const r = await get(q("/workspace/outputs", { cwd: REPO, dir: OUTSIDE }));
    assert.equal(r.status, 200);
    const body = await r.json() as { folders: Array<{ abs: string; files: Array<{ path: string }> }> };
    assert.equal(body.folders.length, 1);
    assert.equal(body.folders[0].abs, OUTSIDE);
    assert.deepEqual(body.folders[0].files.map((f) => f.path).sort(), ["note.txt", "shot.png"]);
    // The relevance rule is not the access rule, so turning the access rule off
    // must not turn this one off with it: the temp dir itself is never a folder
    // this conversation "produced".
    const root = await get(q("/workspace/outputs", { cwd: REPO, dir: os.tmpdir() }));
    assert.deepEqual((await root.json() as { folders: unknown[] }).folders, []);
  } finally {
    await close();
  }
});

test("with the filter off, cwd is still bounded by ACPG_FS_ROOT", async () => {
  const { get, close } = await startHttpServer();
  try {
    assert.equal((await get(q("/workspace/file", { cwd: OUTSIDE, path: "note.txt" }))).status, 400);
    assert.equal((await get(q("/workspace/changes", { cwd: OUTSIDE }))).status, 400);
    assert.equal((await get(q("/workspace/tree", { cwd: OUTSIDE }))).status, 400);
  } finally {
    await close();
  }
});
