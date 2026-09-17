import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { bifrostBinaryPath, resetBifrostForTest } from "./bifrost.ts";

// FS_ROOT is snapshotted at gateway.ts import time, so the fixture tree is
// built and pointed at before the module is loaded (same as
// workspace.routes.test.ts).
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-defroot-")));
process.env.ACPG_FS_ROOT = ROOT;
process.env.ACPG_PREVIEW_ROOTS = "";
// Definition stays off unless a test opts in — fail closed, like production.
delete process.env.ACPG_LSP_JAVA;

const REPO = path.join(ROOT, "javaproj");
fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
const run = (...args: string[]) => execFileSync("git", args, { cwd: REPO, stdio: "pipe" });
run("init", "-q", "-b", "main");
run("config", "user.email", "test@example.com");
run("config", "user.name", "Test");
fs.writeFileSync(path.join(REPO, "src", "Greeter.java"),
  "package demo;\npublic class Greeter {\n  public String greet(String name) { return \"hi \" + name; }\n}\n");
fs.writeFileSync(path.join(REPO, "src", "Main.java"),
  "package demo;\npublic class Main {\n  public static void main(String[] args) {\n    Greeter g = new Greeter();\n    System.out.println(g.greet(\"bob\"));\n  }\n}\n");
run("add", "-A");
run("commit", "-q", "-m", "initial");

const authHeader = "Basic " + Buffer.from(
  `${process.env.ACPG_AUTH_USER ?? ""}:${process.env.ACPG_AUTH_TOKEN ?? ""}`, "utf8",
).toString("base64");

async function startHttpServer(): Promise<{
  get: (p: string) => Promise<Response>;
  close: () => Promise<void>;
}> {
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

const q = (params: Record<string, string | undefined>) =>
  "/workspace/definition?" + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)),
  ).toString();

after(() => resetBifrostForTest());

test("/workspace/definition is disabled without ACPG_LSP_JAVA=bifrost", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q({ cwd: REPO, path: "src/Main.java", line: "5", column: "30" }));
    assert.equal(r.status, 404);
    assert.equal((await r.json() as { code?: string }).code, "disabled");
  } finally {
    await close();
  }
});

test("/workspace/definition rejects bad line/column and outside-root paths", async () => {
  const { get, close } = await startHttpServer();
  try {
    for (const params of [
      { cwd: REPO, path: "src/Main.java" },
      { cwd: REPO, path: "src/Main.java", line: "0", column: "1" },
      { cwd: REPO, path: "src/Main.java", line: "5", column: "0" },
      { cwd: REPO, path: "src/Main.java", line: "not-a-number" },
      { cwd: "/etc", path: "passwd", line: "1" },
    ]) {
      const r = await get(q(params));
      assert.equal(r.status, 400, JSON.stringify(params));
    }
  } finally {
    await close();
  }
});

test("/workspace/definition?warm=1 answers at once without a line", async () => {
  const { get, close } = await startHttpServer();
  try {
    const r = await get(q({ cwd: REPO, warm: "1" }));
    assert.equal(r.status, 200);
    const body = await r.json() as { warming?: unknown };
    assert.equal(body.warming, false);
  } finally {
    await close();
  }
});

// Needs the real analyzer binary (an exact-pinned optional dependency). Skips
// where it isn't installed rather than failing the suite.
test("/workspace/definition resolves a cross-file Java symbol", async (t) => {
  if (!bifrostBinaryPath()) { t.skip("bifrost native binary not installed"); return; }
  process.env.ACPG_LSP_JAVA = "bifrost";
  try {
    const { get, close } = await startHttpServer();
    try {
      // Warm first: the cold index is built inside the first query, and the
      // 2 s definition budget must not pay for it.
      const w = await get(q({ cwd: REPO, warm: "1" }));
      assert.equal(w.status, 200);
      assert.equal((await w.json() as { warming?: unknown }).warming, true);
      // g.greet("bob") on line 5 — the call's `greet` sits around column 26.
      let hit: Array<{ abs?: unknown; path?: unknown; line?: unknown }> = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        const r = await get(q({ cwd: REPO, path: "src/Main.java", line: "5", column: "26" }));
        assert.equal(r.status, 200);
        hit = await r.json() as typeof hit;
        if (hit.length) break;
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      assert.ok(hit.length >= 1, "expected at least one definition hit");
      assert.equal(hit[0].abs, path.join(REPO, "src", "Greeter.java"));
      assert.equal(hit[0].line, 3);
    } finally {
      await close();
    }
  } finally {
    delete process.env.ACPG_LSP_JAVA;
    resetBifrostForTest();
  }
});
