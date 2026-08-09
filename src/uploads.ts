// Generic (non-image) file attachments for the composer: POST /uploads writes
// the request body to disk under the gateway's own data dir and hands back a
// file:// URI. The client then sends that URI onward as an ordinary ACP
// resource_link content block — the exact mechanism the composer's "@ file"
// picker already uses (mentions.ts's makeMessageFile) — so the agent, a local
// subprocess on this same host/filesystem, reads the file itself.
//
// v1 scope, explicitly: no background cleanup. Uploaded files accumulate under
// <uploadsDir> until an operator clears them; a size cap plus filename
// sanitization are the only guards. Expiry is a follow-up, not done here.
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_NAME_LEN = 200;

// Preserve the extension through the length cap: an agent's file-type handling
// (e.g. Claude Code's Read tool doing PDF page extraction) keys off the path's
// extension, so truncating ".pdf" off a long name would silently turn a PDF
// into an extension-less blob its tooling won't recognize.
function capBasename(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const ext = path.extname(name);
  if (ext.length === 0 || ext.length >= maxLen) return name.slice(0, maxLen);
  return name.slice(0, name.length - ext.length).slice(0, maxLen - ext.length) + ext;
}

// A client-supplied filename is a system boundary: collapse it to a bare
// basename before it ever touches a filesystem path. Chaining posix+win32
// basename() strips both "/"- and "\"-style separators regardless of host OS,
// so ".."/absolute-path segments can't survive as anything but their trailing
// component. The result only ever gets joined onto a server-controlled uploads
// dir behind a server-generated random prefix (see handleUpload below), so it
// can never itself form a traversal once sanitized down to a bare basename.
export function safeUploadBasename(raw: string): string | null {
  if (!raw || raw.length > 4096 || raw.includes("\0")) return null;
  const base = path.win32.basename(path.posix.basename(raw));
  if (!base || base === "." || base === "..") return null;
  return capBasename(base, MAX_NAME_LEN);
}

// The sanitized basename above still allows spaces/unicode/parens — kept for
// the human-readable chip label (the `name` field in the response). Restrict
// *only* the on-disk filename to an ASCII-safe charset, so what lands in the
// uploads dir stays predictable for an operator clearing it out by hand (there
// is no reaper — see the header). URI correctness is not this function's job:
// the directory half of the path is operator-supplied and can contain anything,
// so encoding is handled wholesale by pathToFileURL at the response site.
function diskSafeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface UploadOpts {
  uploadsDir: string; // absolute; caller resolves it (gateway.ts: path.join(cfg.ledgerDir, "uploads"))
  maxBytes: number;
}

// Handles a POST /uploads request already routed here by the caller (pathname
// match + the console's Basic-auth gate both happen in gateway.ts). Streams the
// body straight to disk rather than buffering it first, so maxBytes can be
// sized for real documents without a peak-memory cost per concurrent upload.
// An over-cap request aborts the write and unlinks the partial file instead of
// completing it. The caller (gateway.ts) fires this without awaiting it, same
// as the other .then()/.catch()-driven route handlers in this codebase; the
// returned promise (resolving once the response is fully written) exists so
// tests can await completion deterministically instead of guessing a timeout.
export async function handleUpload(req: IncomingMessage, res: ServerResponse, opts: UploadOpts): Promise<void> {
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

  const q = new URL(req.url ?? "/", "http://x").searchParams;
  const displayName = safeUploadBasename(q.get("name") ?? "");
  if (!displayName) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("invalid or missing filename\n");
    return;
  }

  const onDiskName = crypto.randomBytes(8).toString("hex") + "-" + diskSafeName(displayName);
  const dest = path.join(opts.uploadsDir, onDiskName);

  try {
    await fs.promises.mkdir(opts.uploadsDir, { recursive: true });
  } catch (e) {
    console.error(`upload mkdir failed: ${String(e)}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
    return;
  }

  await new Promise<void>((resolve) => {
    const ws = fs.createWriteStream(dest);
    let size = 0;
    let outcome: { code: number; body: string } | null = null;
    // True once a response has actually been sent (success or reject) — the
    // one guard every terminal branch shares, including the req "close"
    // backstop below (which must tell "already handled" apart from "the
    // client vanished before anything else fired").
    let answered = false;

    // Every non-2xx outcome: respond (if a response hasn't gone out already —
    // "close" can fire after "end" already answered) and remove whatever
    // partial/rejected bytes made it to disk.
    const reject = (code: number, msg: string) => {
      if (answered) return;
      answered = true;
      if (!res.headersSent) {
        res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
        res.end(msg);
      }
      fs.promises.unlink(dest).catch(() => {}).finally(resolve);
    };

    // Reject without destroying the request: stop writing the rejected upload
    // to disk, but keep consuming (draining) the body so the client's own send
    // completes normally and it actually receives this response. Destroying
    // req mid-body instead would race the client's in-flight write and is
    // liable to surface as a connection reset rather than a clean 413/500 —
    // the same reasoning login.ts's readBody follows by draining to "end"
    // rather than aborting early on an oversized body.
    const fail = (code: number, msg: string) => {
      if (outcome || answered) return;
      outcome = { code, body: msg + "\n" };
      req.unpipe(ws);
      ws.destroy();
      req.resume();
    };

    // Whether req reached "end" — i.e. the client's body arrived in full,
    // however it was answered. Node emits "end" before "close" on the same
    // stream, always, so gating the close-backstop below on this can't race
    // ws's own (separately-timed, disk-I/O-bound) "close" the way comparing
    // req's and ws's close events directly would.
    let reqEnded = false;

    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > opts.maxBytes) fail(413, "file too large");
    });
    // Unlike fail(), the connection is already gone here — draining is moot,
    // so answer (best-effort; the client may never see it) now rather than
    // waiting for an "end" that a broken stream won't emit.
    req.on("error", () => { req.unpipe(ws); ws.destroy(); reject(400, "upload failed\n"); });
    ws.on("error", (e) => { console.error(`upload write failed: ${String(e)}`); fail(500, "write failed"); });
    // Answers a fail()'d request once the client's body has fully drained —
    // see fail()'s comment for why this waits instead of destroying req.
    req.on("end", () => { reqEnded = true; if (outcome) reject(outcome.code, outcome.body); });
    // Node guarantees "close" on every termination path, including ones "end"
    // and "error" don't cover — e.g. the client aborting (tab closed, network
    // drop) before its body ever finished arriving. Without this, that
    // upload's promise (and its partial file) would hang forever. Gated on
    // !reqEnded so it only fires for a genuine premature abort — a client
    // that *did* finish sending (reqEnded) also reaches "close" on its own
    // stream, same as any successful request, and that must stay a no-op.
    req.on("close", () => {
      if (reqEnded) return;
      ws.destroy(); // plain .pipe() doesn't auto-clean the destination on an abrupt source close
      reject(outcome?.code ?? 400, outcome?.body ?? "upload failed\n");
    });

    // The terminal point for a clean (non-rejected) completion — fs write
    // streams emit "close" once their fd is released, after pipe()'s automatic
    // ws.end() runs its course. Answering here, after the fd is gone, is what
    // lets a caller await this promise and then trust an immediate filesystem
    // check (no unlink-vs-resolve race). Unlike reject(), success keeps dest.
    ws.on("close", () => {
      if (answered) return; // a fail()/error/abort path already answered
      if (outcome) {
        // A write failure (fail() -> ws.destroy() -> this close) decided on an
        // outcome, but req may not have finished draining yet — in which case
        // req's own "end" handler above still owns answering it (that's what
        // keeps the drain-before-respond guarantee intact for the 413 path).
        // Only answer here once req has nothing left to report, i.e. the
        // write failed on/after ws.end()'s final flush, after req already hit
        // "end" with no outcome yet — the one case nothing else answers, and
        // reporting success instead (see history) would hand out a URI to a
        // file that never finished writing.
        if (reqEnded) reject(outcome.code, outcome.body);
        return;
      }
      if (size === 0) { reject(400, "empty file\n"); return; }
      answered = true;
      res.writeHead(200, { "content-type": "application/json" });
      // pathToFileURL, not "file://" + dest: the uploads dir is operator-supplied
      // (ACPG_LEDGER_DIR) and routinely contains spaces — the macOS default is
      // "~/Library/Application Support/acp-gateway". Concatenating leaves those
      // raw, and claude-agent-acp renders a resource_link as a markdown link
      // `[@name](uri)`, where a raw space truncates the target.
      res.end(JSON.stringify({ name: displayName, uri: pathToFileURL(dest).href }));
      resolve();
    });
    req.pipe(ws);
  });
}
