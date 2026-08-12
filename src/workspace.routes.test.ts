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
// The scenario /workspace/outputs and /workspace/render exist for: an agent
// makes itself a scratch folder outside the project, writes ONE file there with
// a tool call, and generates the rest through a shell. `mockup.html` is the only
// path any tool call names; nothing else here can be reached by the panel's other
// two sources, because git has never heard of this folder.
const ICONS = path.join(SCRATCH, "icons");
fs.mkdirSync(path.join(ICONS, "png"), { recursive: true });
fs.writeFileSync(path.join(ICONS, "mockup.html"),
  '<html><head><link rel="stylesheet" href="theme.css"></head><body>'
  + '<img src="png/shot.png"><img src="https://example.com/remote.png">'
  + '<script src="app.js"></script></body></html>');
fs.writeFileSync(path.join(ICONS, "theme.css"), "body { background: url(png/shot.png); }\n");
fs.writeFileSync(path.join(ICONS, "app.js"), "console.log(1);\n");
fs.writeFileSync(path.join(ICONS, "generated.html"), "<html>written by a heredoc</html>");
fs.writeFileSync(path.join(ICONS, "png", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
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

// A second checkout, for the tree/find routes. Separate from REPO on purpose:
// those tests care about what a folder CONTAINS, and adding fixture files to
// REPO would rewrite what `git status` reports for the tests above.
const TREE = path.join(ROOT, "treeproj");
fs.mkdirSync(path.join(TREE, "src", "deep"), { recursive: true });
fs.mkdirSync(path.join(TREE, "build"), { recursive: true });
const runTree = (...args: string[]) => execFileSync("git", args, { cwd: TREE, stdio: "pipe" });
runTree("init", "-q", "-b", "main");
runTree("config", "user.email", "test@example.com");
runTree("config", "user.name", "Test");
fs.writeFileSync(path.join(TREE, ".gitignore"), "ignored.log\nbuild/\n");
fs.writeFileSync(path.join(TREE, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(TREE, "README.md"), "# tree\n");
fs.writeFileSync(path.join(TREE, "ignored.log"), "noise\n");
fs.writeFileSync(path.join(TREE, "src", "app.ts"), "export const a = 1;\n");
fs.writeFileSync(path.join(TREE, "src", "deep", "nested.ts"), "export const b = 2;\n");
fs.writeFileSync(path.join(TREE, "build", "bundle.js"), "// generated\n");
runTree("add", "-A");
runTree("commit", "-q", "-m", "initial");

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

interface TreeBody { path: string; truncated: boolean; entries: Array<{ name: string; dir: boolean; ignored?: boolean; size?: number }> }

test("/workspace/tree lists one level, folders first, with git's ignored files dimmed rather than hidden", async () => {
  const { get, close } = await startHttpServer();
  try {
    // No `path`: the tree's root is the conversation's own folder.
    const r = await get(q("/workspace/tree", { cwd: TREE }));
    assert.equal(r.status, 200);
    const body = await r.json() as TreeBody;
    const names = body.entries.map((e) => e.name);
    // Folders first, then files, each alphabetical — and dotfiles are present,
    // because a .env you can see in the tree is the point of showing them.
    // `.git` is the one exclusion: plumbing, not project content.
    assert.deepEqual(names, ["build", "src", ".env", ".gitignore", "ignored.log", "README.md"]);
    const by = (n: string) => body.entries.find((e) => e.name === n)!;
    assert.equal(by("src").dir, true);
    assert.equal(by("README.md").dir, false);
    assert.ok((by("README.md").size ?? 0) > 0, "files carry their size");
    // .gitignore names both of these; nothing else is ignored.
    assert.equal(by("ignored.log").ignored, true);
    assert.equal(by("build").ignored, true);
    assert.equal(by("README.md").ignored, undefined);
    assert.equal(by(".env").ignored, undefined);
  } finally {
    await close();
  }
});

test("/workspace/tree descends by path, and refuses a file", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/tree", { cwd: TREE, path: "src" }));
    const body = await r.json() as TreeBody;
    assert.equal(body.path, "src", "named relative to the conversation's folder");
    assert.deepEqual(body.entries.map((e) => e.name), ["deep", "app.ts"]);

    // A file is not a directory: 404, not an empty listing that reads as "this
    // folder is empty".
    const file = await get(q("/workspace/tree", { cwd: TREE, path: "README.md" }));
    assert.equal(file.status, 404);
    assert.equal((await file.json()).code, "not-found");
  } finally {
    await close();
  }
});

test("/workspace/find matches on the whole relative path, dotfiles included, and skips what git ignores", async () => {
  const { get, close } = await startHttpServer();
  try {
    const hit = async (query: string) => {
      const r = await get(q("/workspace/find", { cwd: TREE, q: query }));
      assert.equal(r.status, 200);
      return await r.json() as { files: Array<{ path: string }>; truncated: boolean; fromGit: boolean };
    };

    // A dotfile the tree shows must be findable; the composer's "@ file" walk
    // skips these, which is why find() doesn't reuse it.
    assert.deepEqual((await hit(".env")).files.map((f) => f.path), [".env"]);
    // Nested, and matched on the directory part of the path too.
    assert.deepEqual((await hit("deep/")).files.map((f) => f.path), ["src/deep/nested.ts"]);
    // Ignored files are visible in the tree but are not search hits — the tree
    // dims them for the same reason.
    const ignored = await hit("ignored.log");
    assert.deepEqual(ignored.files, []);
    assert.equal(ignored.fromGit, true, "git supplied the list, so it excluded them");
    assert.deepEqual((await hit("bundle")).files, []);
    // A basename hit outranks a mid-path one.
    assert.equal((await hit("nested")).files[0].path, "src/deep/nested.ts");
    // An empty query is not "match everything".
    assert.deepEqual((await hit("  ")).files, []);

    // A conversation running in a subdirectory searches from THERE. git answers
    // in repo-relative paths whatever it is asked about, so without re-basing
    // every row would be labelled with a prefix that isn't in this tree.
    const sub = await get(q("/workspace/find", { cwd: path.join(TREE, "src"), q: "nested" }));
    const body = await sub.json() as { files: Array<{ path: string; abs: string }> };
    assert.deepEqual(body.files.map((f) => f.path), ["deep/nested.ts"]);
    assert.equal(body.files[0].abs, path.join(TREE, "src", "deep", "nested.ts"));
  } finally {
    await close();
  }
});

test("a path outside the project and outside ACPG_PREVIEW_ROOTS is refused, however it is spelled", async () => {
  const { get, close } = await startHttpServer();
  try {
    for (const route of ["/workspace/file", "/workspace/diff", "/workspace/raw", "/workspace/tree", "/workspace/find"]) {
      assert.equal((await get(q(route, { cwd: REPO, path: "/etc/passwd" }))).status, 400, route + " absolute");
      assert.equal((await get(q(route, { cwd: REPO, path: "../../../../etc/passwd" }))).status, 400, route + " traversal");
      // cwd is not the client's to choose freely either — otherwise cwd=/ would
      // make every file "inside the project".
      assert.equal((await get(q(route, { cwd: "/etc", path: "passwd" }))).status, 400, route + " cwd");
    }
    assert.equal((await get(q("/workspace/changes", { cwd: "/etc" }))).status, 400);
    // The tree's root is the one path it may omit, and that must not become a
    // way to list a cwd the client picked from outside the root.
    assert.equal((await get(q("/workspace/tree", { cwd: "/etc" }))).status, 400);
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

// A file that was there when the list was built but is gone by the time it's
// opened must read as "not found" (404), not "outside the project" (400).
// realpath throws for a path that doesn't exist, and naively falling back to
// the un-resolved form there breaks the comparison whenever the root itself is
// a symlink (SCRATCH sits under the OS tmp dir, which on macOS resolves
// through one) — this pins that a within-root-but-missing file still resolves
// as within-root.
test("a file that no longer exists under an allowed root is 'not found', not 'outside the project'", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/file", { cwd: REPO, path: path.join(SCRATCH, "gone.txt") }));
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "not-found");

    // Same for a file under the project itself, not just an ACPG_PREVIEW_ROOTS entry.
    const inProject = await get(q("/workspace/file", { cwd: REPO, path: "also-gone.txt" }));
    assert.equal(inProject.status, 404);
    assert.equal((await inProject.json()).code, "not-found");
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

test("/workspace/outputs lists a scratch folder whole, including what no tool call named", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/outputs", { cwd: REPO, dir: ICONS }));
    assert.equal(r.status, 200);
    const body = await r.json() as { folders: Array<{ abs: string; files: Array<{ path: string }>; truncated: boolean }> };
    assert.equal(body.folders.length, 1);
    assert.equal(body.folders[0].abs, ICONS);
    // `generated.html` is the whole point: a shell wrote it, so no tool call
    // names it, and it is outside every checkout, so git cannot see it either.
    // `png/shot.png` proves the walk goes one level down.
    assert.deepEqual(body.folders[0].files.map((f) => f.path).sort(),
      ["app.js", "generated.html", "mockup.html", "png/shot.png", "theme.css"]);
    assert.equal(body.folders[0].truncated, false);
  } finally {
    await close();
  }
});

test("/workspace/outputs refuses an allowed root itself, and anything inside the checkout", async () => {
  const { get, close } = await startHttpServer();
  try {
    // The root itself would be the host's scratch space, not this turn's work:
    // one `Write /tmp/report.html` must not turn Outputs into a listing of /tmp.
    const root = await get(q("/workspace/outputs", { cwd: REPO, dir: SCRATCH }));
    assert.deepEqual((await root.json() as { folders: unknown[] }).folders, []);
    // Inside the checkout git is the authority and already reports it; a second
    // source over the top would duplicate every dirty file and drag in build
    // output git deliberately ignores.
    const inRepo = await get(q("/workspace/outputs", { cwd: REPO, dir: REPO }));
    assert.deepEqual((await inRepo.json() as { folders: unknown[] }).folders, []);
    const sub = await get(q("/workspace/outputs", { cwd: TREE, dir: path.join(TREE, "src") }));
    assert.deepEqual((await sub.json() as { folders: unknown[] }).folders, []);
  } finally {
    await close();
  }
});

test("/workspace/outputs refuses a folder the viewer itself couldn't read", async () => {
  const { get, close } = await startHttpServer();
  try {
    // Same gate as every other route: a folder whose files /workspace/file would
    // refuse must not be listed either, or the panel shows rows that don't open.
    const r = await get(q("/workspace/outputs", { cwd: REPO, dir: SCRATCH + "-other" }));
    assert.deepEqual((await r.json() as { folders: unknown[] }).folders, []);
  } finally {
    await close();
  }
});

test("/workspace/render inlines the document's own assets and says what it skipped", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q("/workspace/render", { cwd: REPO, path: path.join(ICONS, "mockup.html") }));
    assert.equal(r.status, 200);
    const body = await r.json() as { html: string; inlined: number; skipped: number };
    // The image and the stylesheet, and the stylesheet's own background image —
    // resolved against the CSS file's folder, not the document's.
    assert.match(body.html, /<img src="data:image\/png;base64,/);
    assert.match(body.html, /<style>\s*body \{ background: url\(data:image\/png;base64,/);
    assert.ok(body.inlined >= 2, "expected the png and the stylesheet, got " + body.inlined);
    // Left exactly as they were: a remote URL is not ours to fetch, and a
    // data:-URI script would be blocked by the preview's CSP, so turning one
    // into that would trade a visible gap for a silent one.
    assert.match(body.html, /<img src="https:\/\/example\.com\/remote\.png">/);
    assert.match(body.html, /<script src="app\.js">/);
    assert.equal(body.skipped, 1);
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
    assert.equal((await get(q("/workspace/outputs", { cwd: "", dir: ICONS }))).status, 400);
  } finally {
    await close();
  }
});

test("every workspace route sits behind the gateway account", async () => {
  const { get, close } = await startHttpServer();
  try {
    for (const route of ["/workspace/changes", "/workspace/file", "/workspace/diff", "/workspace/raw",
                         "/workspace/outputs", "/workspace/render"]) {
      const r = await get(q(route, { cwd: REPO, path: "kept.txt" }), {});
      assert.equal(r.status, 401, route);
    }
  } finally {
    await close();
  }
});
