import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { safeUploadBasename, handleUpload } from "./uploads.ts";
import { handleRequest } from "./gateway.ts";

test("safeUploadBasename strips directory components regardless of separator style", () => {
  assert.equal(safeUploadBasename("report.pdf"), "report.pdf");
  assert.equal(safeUploadBasename("My Report.pdf"), "My Report.pdf"); // display charset preserved
  assert.equal(safeUploadBasename("../../etc/passwd"), "passwd");
  assert.equal(safeUploadBasename("/etc/passwd"), "passwd");
  assert.equal(safeUploadBasename("..\\..\\windows\\win.ini"), "win.ini");
});

test("safeUploadBasename rejects empty, dot, and null-byte names", () => {
  assert.equal(safeUploadBasename(".."), null);
  assert.equal(safeUploadBasename("."), null);
  assert.equal(safeUploadBasename(""), null);
  assert.equal(safeUploadBasename("a\0b"), null);
});

test("safeUploadBasename caps length while preserving the extension", () => {
  const capped = safeUploadBasename("a".repeat(250) + ".pdf");
  assert.ok(capped !== null && capped.length <= 200);
  assert.ok(capped?.endsWith(".pdf"));
});

// ---- handleUpload, called directly against fake req/res (no real HTTP) ----

function fakeUploadReq(body: Buffer | string, url: string, method = "POST"): http.IncomingMessage {
  const r = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]) as unknown as http.IncomingMessage;
  Object.assign(r, { url, method });
  return r;
}

function fakeRes() {
  let status = 0;
  let body = "";
  let headersSent = false;
  const res = {
    writeHead(code: number) { status = code; headersSent = true; return res; },
    write(chunk: string) { body += chunk; return true; },
    end(chunk?: string) { if (chunk) body += chunk; return res; },
    get headersSent() { return headersSent; },
  } as unknown as http.ServerResponse;
  return { res, status: () => status, body: () => body };
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpb-uploads-"));
}

test("handleUpload rejects a non-POST method with 405", async () => {
  const { res, status } = fakeRes();
  await handleUpload(fakeUploadReq("x", "/uploads?name=a.txt", "GET"), res, { uploadsDir: freshDir(), maxBytes: 1000 });
  assert.equal(status(), 405);
});

test("handleUpload rejects a missing/invalid filename with 400", async () => {
  const { res, status } = fakeRes();
  await handleUpload(fakeUploadReq("hi", "/uploads?name=.."), res, { uploadsDir: freshDir(), maxBytes: 1000 });
  assert.equal(status(), 400);
});

test("handleUpload rejects a body over maxBytes with 413 and leaves no partial file behind", async () => {
  const uploadsDir = freshDir();
  const { res, status } = fakeRes();
  await handleUpload(fakeUploadReq("x".repeat(100), "/uploads?name=big.txt"), res, { uploadsDir, maxBytes: 10 });
  assert.equal(status(), 413);
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test("handleUpload keeps draining chunks that arrive after maxBytes is exceeded, and still resolves", async () => {
  // Regression coverage for draining vs. destroying the request mid-body: an
  // earlier version called req.destroy() as soon as the cap was exceeded,
  // which — over a real socket — races the client's still-in-flight write and
  // is liable to surface as a connection reset instead of a clean 413 (see
  // login.ts's readBody, which drains to "end" for the same reason). A fake
  // stream can't reproduce the socket-reset symptom itself, but it can prove
  // the handler no longer stops consuming partway through: if a chunk arriving
  // after fail() were left unread, the returned promise would never settle.
  const uploadsDir = freshDir();
  const chunks = [Buffer.from("a".repeat(50)), Buffer.from("b".repeat(50)), Buffer.from("c".repeat(50))];
  const req = Readable.from(chunks) as unknown as http.IncomingMessage;
  Object.assign(req, { url: "/uploads?name=slow.txt", method: "POST" });
  const { res, status } = fakeRes();
  // The cap sits between the 1st and 2nd chunk, so the 3rd chunk is sent after
  // the handler has already decided to reject — exactly the "client keeps
  // sending" case draining is meant to handle.
  await handleUpload(req, res, { uploadsDir, maxBytes: 60 });
  assert.equal(status(), 413);
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test("handleUpload resolves and cleans up when the client aborts mid-upload (no \"end\", no \"error\")", async () => {
  // A client that vanishes mid-body (tab closed, network drop) makes req emit
  // only "close" — never "end" or "error". Before the close-backstop existed,
  // nothing here answered that case: the promise (and the partial file) would
  // hang forever.
  const uploadsDir = freshDir();
  const req = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  Object.assign(req, { url: "/uploads?name=aborted.txt", method: "POST" });
  const { res, status } = fakeRes();

  const done = handleUpload(req, res, { uploadsDir, maxBytes: 1000 });
  // Let handleUpload's internal mkdir + req.pipe(ws) wiring run before the
  // abort, so the close it's meant to catch happens after listeners exist —
  // poll the listener count itself rather than guess a delay long enough for
  // mkdir to resolve (which is what the close-backstop is gated behind).
  while (req.listenerCount("close") === 0) await new Promise((r) => setImmediate(r));
  const rs = req as unknown as Readable;
  rs.push(Buffer.from("partial"));
  rs.destroy();

  await done;
  assert.equal(status(), 400);
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test("handleUpload rejects an empty body with 400 and leaves no file behind", async () => {
  const uploadsDir = freshDir();
  const { res, status } = fakeRes();
  await handleUpload(fakeUploadReq("", "/uploads?name=empty.txt"), res, { uploadsDir, maxBytes: 1000 });
  assert.equal(status(), 400);
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test("handleUpload writes the body to disk and returns {name, uri}", async () => {
  const uploadsDir = freshDir();
  const { res, status, body } = fakeRes();
  await handleUpload(fakeUploadReq("# hello", "/uploads?name=notes.md"), res, { uploadsDir, maxBytes: 1000 });
  assert.equal(status(), 200);
  const j = JSON.parse(body());
  assert.equal(j.name, "notes.md");
  const onDisk = j.uri.slice("file://".length);
  assert.equal(fs.readFileSync(onDisk, "utf8"), "# hello");
  assert.ok(path.dirname(onDisk) === uploadsDir);
});

test("a filename with spaces/parens gets an ASCII-safe on-disk URI but keeps the display name", async () => {
  const uploadsDir = freshDir();
  const { res, body } = fakeRes();
  await handleUpload(fakeUploadReq("%PDF-1.4 stub", "/uploads?" + new URLSearchParams({ name: "My Report (final).pdf" })),
    res, { uploadsDir, maxBytes: 1000 });
  const j = JSON.parse(body());
  assert.equal(j.name, "My Report (final).pdf");
  assert.doesNotMatch(j.uri, /[ ()]/);
  assert.match(j.uri, /\.pdf$/);
});

test("two uploads of the same filename don't collide on disk", async () => {
  const uploadsDir = freshDir();
  const a = fakeRes();
  const b = fakeRes();
  await Promise.all([
    handleUpload(fakeUploadReq("one", "/uploads?name=dup.txt"), a.res, { uploadsDir, maxBytes: 1000 }),
    handleUpload(fakeUploadReq("two", "/uploads?name=dup.txt"), b.res, { uploadsDir, maxBytes: 1000 }),
  ]);
  const uriA = JSON.parse(a.body()).uri;
  const uriB = JSON.parse(b.body()).uri;
  assert.notEqual(uriA, uriB);
  assert.equal(fs.readdirSync(uploadsDir).length, 2);
});

// ---- round trip through the real HTTP surface (auth gate + route dispatch) ----

function startHttpServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer(handleRequest);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}
const authHeader = () =>
  "Basic " + Buffer.from(`${process.env.ACPG_AUTH_USER ?? ""}:${process.env.ACPG_AUTH_TOKEN ?? ""}`).toString("base64");

test("POST /uploads requires auth like the rest of the console surface", async () => {
  const { base, close } = await startHttpServer();
  try {
    const r = await fetch(base + "/uploads?name=x.txt", { method: "POST", body: "x" });
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});

test("POST /uploads round-trips a real file under the gateway's ledgerDir", async () => {
  const { base, close } = await startHttpServer();
  try {
    const r = await fetch(base + "/uploads?name=" + encodeURIComponent("notes.md"), {
      method: "POST",
      headers: { authorization: authHeader() },
      body: "# hello from a real request",
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.name, "notes.md");
    const onDisk = j.uri.slice("file://".length);
    assert.equal(fs.readFileSync(onDisk, "utf8"), "# hello from a real request");
    assert.ok(onDisk.startsWith(path.join(process.env.ACPG_LEDGER_DIR ?? "", "uploads")));
  } finally {
    await close();
  }
});
