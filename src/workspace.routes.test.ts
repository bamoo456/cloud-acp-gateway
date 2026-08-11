import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

// FS_ROOT and PREVIEW_ROOTS are read once, at gateway.ts import time — and these
// routes are largely *about* what those roots do and don't allow. So the fixture
// tree is built and pointed at before the module is loaded.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-wsroot-")));
process.env.ACPG_FS_ROOT = ROOT;
// Stands in for the real /tmp: somewhere an agent writes that is nowhere near
// the project, reachable only because the deployment opted in.
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-scratch-")));
process.env.ACPG_PREVIEW_ROOTS = SCRATCH;
fs.writeFileSync(path.join(SCRATCH, "note.txt"), "written outside the project on purpose\n");
fs.writeFileSync(path.join(SCRATCH, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
fs.mkdirSync(SCRATCH + "-other", { recursive: true });
fs.writeFileSync(path.join(SCRATCH + "-other", "note.txt"), "a sibling of an allowed root\n");
const REPO = path.join(ROOT, "project");
fs.mkdirSync(REPO);
const run = (...args: string[]) => execFileSync("git", args, { cwd: REPO, stdio: "pipe" });
run("init", "-q", "-b", "main");
run("config", "user.email", "test@example.com");
run("config", "user.name", "Test");
fs.writeFileSync(path.join(REPO, "kept.txt"), "one\ntwo\n");
run("add", "-A");
run("commit", "-q", "-m", "initial");
fs.writeFileSync(path.join(REPO, "kept.txt"), "one\ntwo\nthree\n");
fs.writeFileSync(path.join(REPO, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
fs.writeFileSync(path.join(REPO, "report.html"), "<script>alert(document.cookie)</script>");

const authHeader = "Basic " + Buffer.from(
  `${process.env.ACPG_AUTH_USER ?? ""}:${process.env.ACPG_AUTH_TOKEN ?? ""}`, "utf8",
).toString("base64");

// Same shape as gateway.e2e.test.ts's harness: the Basic-auth'd HTTP surface
// lives in handleRequest, which tests must attach to their own server because
// ACPG_NO_LISTEN keeps the real entrypoint from ever listening.
// gateway.ts is imported lazily, from inside the async helper: it snapshots
// ACPG_FS_ROOT at module load, and a top-level import would be hoisted above the
// fixture setup that sets it (tsx compiles this to CJS, so no top-level await
// either). Node caches the module, so every later call reuses this same load.
async function startHttpServer(): Promise<{ get: (p: string, headers?: Record<string, string>) => Promise<Response>; close: () => Promise<void> }> {
  const { handleRequest } = await import("./gateway.ts");
  const srv = http.createServer(handleRequest);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        get: (p, headers) => fetch(base + p, { headers: headers ?? { authorization: authHeader } }),
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

const q = (route: string, params: Record<string, string>) =>
  route + "?" + new URLSearchParams(params).toString();

test("/workspace/changes lists the checkout's dirty files", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/changes", { cwd: REPO }));
    assert.equal(r.status, 200);
    const body = await r.json() as { repo: string; files: Array<{ path: string; status: string; abs: string }> };
    assert.equal(body.repo, REPO);
    const paths = body.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["kept.txt", "report.html", "shot.png"]);
    assert.equal(body.files.find((f) => f.path === "kept.txt")?.status, "modified");
    assert.equal(body.files.find((f) => f.path === "shot.png")?.abs, path.join(REPO, "shot.png"));
  } finally {
    await close();
  }
});

test("/workspace/diff returns the file's unified diff", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/diff", { cwd: REPO, path: path.join(REPO, "kept.txt") }));
    assert.equal(r.status, 200);
    const body = await r.json() as { diff: string; binary: boolean };
    assert.equal(body.binary, false);
    assert.match(body.diff, /^\+three$/m);
  } finally {
    await close();
  }
});

test("/workspace/file returns text content, and a cwd-relative path resolves", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/file", { cwd: REPO, path: "kept.txt" }));
    assert.equal(r.status, 200);
    const body = await r.json() as { kind: string; text: string; path: string };
    assert.equal(body.kind, "text");
    assert.equal(body.text, "one\ntwo\nthree\n");
    assert.equal(body.path, "kept.txt");
  } finally {
    await close();
  }
});

test("/workspace/file 404s a path that doesn't exist", async () => {
  const { get, close } = await startHttpServer();
  try {
    assert.equal((await get(q("/workspace/file", { cwd: REPO, path: "nope.txt" }))).status, 404);
  } finally {
    await close();
  }
});

test("an allowlisted image is served inline with its real type", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/raw", { cwd: REPO, path: path.join(REPO, "shot.png") }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.match(r.headers.get("content-disposition") ?? "", /^inline/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    await r.arrayBuffer();
  } finally {
    await close();
  }
});

test("anything else is served as an opaque download, never as active content", async () => {
  // The whole point of the allowlist: this route serves files an agent wrote,
  // from the console's own origin. Handing back text/html here would give a
  // generated page script execution against the origin holding the gateway
  // credential.
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/raw", { cwd: REPO, path: path.join(REPO, "report.html") }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    await r.arrayBuffer();
  } finally {
    await close();
  }
});

test("a path outside the project and outside ACPG_PREVIEW_ROOTS is refused, however it is spelled", async () => {
  const { get, close } = await startHttpServer();
  try {
    for (const route of ["/workspace/file", "/workspace/diff", "/workspace/raw"]) {
      assert.equal((await get(q(route, { cwd: REPO, path: "/etc/passwd" }))).status, 400, route + " absolute");
      assert.equal((await get(q(route, { cwd: REPO, path: "../../../../etc/passwd" }))).status, 400, route + " traversal");
      // cwd is not the client's to choose freely either — otherwise cwd=/ would
      // make every file "inside the project".
      assert.equal((await get(q(route, { cwd: "/etc", path: "passwd" }))).status, 400, route + " cwd");
    }
    assert.equal((await get(q("/workspace/changes", { cwd: "/etc" }))).status, 400);
  } finally {
    await close();
  }
});

// ACPG_PREVIEW_ROOTS is the escape hatch for exactly this: "write the screenshot
// to /tmp" is an ordinary instruction, and the viewer should be able to show
// what the agent produced. It is opt-in so a deployment states its reach out loud.
test("a file under an ACPG_PREVIEW_ROOTS entry is served, project or not", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/file", { cwd: REPO, path: path.join(SCRATCH, "note.txt") }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text, "written outside the project on purpose\n");

    const raw = await get(q("/workspace/raw", { cwd: REPO, path: path.join(SCRATCH, "shot.png") }));
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    await raw.arrayBuffer();

    // A sibling of an allowed root is not itself allowed.
    assert.equal((await get(q("/workspace/file", { cwd: REPO, path: SCRATCH + "-other/note.txt" }))).status, 400);
  } finally {
    await close();
  }
});

// /workspace/changes lists the whole checkout, so a conversation opened on a
// subdirectory would otherwise show repo-wide rows it then refused to open.
test("a conversation running in a subdirectory can still open the rest of its repo", async () => {
  const sub = path.join(REPO, "web");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "app.ts"), "export const a = 1;\n");
  const { get, close } = await startHttpServer();
  try {
    // kept.txt lives ABOVE cwd, at the repo root.
    const r = await get(q("/workspace/file", { cwd: sub, path: path.join(REPO, "kept.txt") }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).path, path.join(REPO, "kept.txt"), "shown by absolute path, not a ../ chain");
    // And its own file still reads by the short relative path.
    const own = await get(q("/workspace/file", { cwd: sub, path: "app.ts" }));
    assert.equal((await own.json()).path, "app.ts");
  } finally {
    await close();
  }
});

test("a request missing cwd or path is a 400, not a read of the process's own directory", async () => {
  const { get, close } = await startHttpServer();
  try {
    for (const route of ["/workspace/file", "/workspace/diff"]) {
      assert.equal((await get(q(route, { cwd: REPO, path: "" }))).status, 400, route + " no path");
      assert.equal((await get(q(route, { cwd: "", path: "kept.txt" }))).status, 400, route + " no cwd");
    }
    assert.equal((await get(q("/workspace/raw", { cwd: REPO, path: "" }))).status, 400);
    assert.equal((await get(q("/workspace/changes", { cwd: "" }))).status, 400);
  } finally {
    await close();
  }
});

test("every workspace route sits behind the gateway account", async () => {
  const { get, close } = await startHttpServer();
  try {
    for (const route of ["/workspace/changes", "/workspace/file", "/workspace/diff", "/workspace/raw"]) {
      const r = await get(q(route, { cwd: REPO, path: "kept.txt" }), {});
      assert.equal(r.status, 401, route);
    }
  } finally {
    await close();
  }
});
