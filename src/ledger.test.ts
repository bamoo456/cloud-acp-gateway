import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "./ledger.ts";

function tmpLedger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-ledger-"));
  return path.join(dir, "ledger.test.jsonl");
}
const FRAME = (sid: string, n: number) =>
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, n } }));

test("assigns monotonic seqs starting at 1", () => {
  const l = new Ledger(tmpLedger());
  assert.equal(l.headSeq(), 0);
  assert.equal(l.append(FRAME("S", 1), "S").seq, 1);
  assert.equal(l.append(FRAME("S", 2), "S").seq, 2);
  assert.equal(l.append(FRAME("T", 3), "T").seq, 3);
  assert.equal(l.headSeq(), 3);
});

test("since(afterSeq) returns only frames after the cursor, in order", () => {
  const l = new Ledger(tmpLedger());
  l.append(FRAME("S", 1), "S");
  l.append(FRAME("S", 2), "S");
  l.append(FRAME("S", 3), "S");
  assert.deepEqual(l.since(1).map((e) => e.seq), [2, 3]);
  assert.deepEqual(l.since(3).map((e) => e.seq), []); // cursor at head → no replay
  assert.deepEqual(l.since(0).map((e) => e.seq), [1, 2, 3]);
});

test("since filters by session when a sid is given", () => {
  const l = new Ledger(tmpLedger());
  l.append(FRAME("S", 1), "S");
  l.append(FRAME("T", 2), "T");
  l.append(FRAME("S", 3), "S");
  l.append(FRAME("S", 4), null); // a frame with no session (e.g. a response)
  assert.deepEqual(l.since(0, "S").map((e) => e.seq), [1, 3]);
  assert.deepEqual(l.since(0, "T").map((e) => e.seq), [2]);
});

test("floorSeq is the smallest retained seq (1 while unbounded, 0 when empty)", () => {
  const l = new Ledger(tmpLedger());
  assert.equal(l.floorSeq(), 0);
  l.append(FRAME("S", 1), "S");
  assert.equal(l.floorSeq(), 1);
});

test("replayed bytes are exactly the appended bytes", () => {
  const l = new Ledger(tmpLedger());
  const f = FRAME("S", 42);
  l.append(f, "S");
  assert.equal(l.since(0)[0].frame.toString("utf8"), f.toString("utf8"));
});

test("a failed append does not publish a phantom replay entry or consume a sequence", async () => {
  const l = new Ledger(tmpLedger());
  await l.close();

  assert.throws(() => l.append(FRAME("S", 1), "S"), /EBADF|bad file descriptor/i);
  assert.equal(l.headSeq(), 0);
  assert.deepEqual(l.since(0), []);
});

test("retries short writes before publishing a replay entry", async (t) => {
  const p = tmpLedger();
  const l = new Ledger(p);
  const writeSync = fs.writeSync;
  let calls = 0;
  t.mock.method(fs, "writeSync", ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    offset?: number | null,
    length?: number | null,
    position?: number | null,
  ) => {
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    const start = typeof data === "string" ? 0 : offset ?? 0;
    const requested = typeof data === "string" ? buffer.byteLength : length ?? buffer.byteLength - start;
    const written = calls++ === 0 ? Math.max(1, Math.floor(requested / 2)) : requested;
    return writeSync(fd, buffer, start, written, position);
  }) as typeof fs.writeSync);

  assert.equal(l.append(FRAME("S", 1), "S").seq, 1);
  assert.ok(calls >= 2, `expected a retry after a short write, got ${calls} write call(s)`);
  t.mock.restoreAll();
  await l.close();

  const reloaded = new Ledger(p);
  assert.equal(reloaded.since(0)[0].frame.toString("utf8"), FRAME("S", 1).toString("utf8"));
});

test("rolls back a partial append before propagating its write error", async (t) => {
  const p = tmpLedger();
  const l = new Ledger(p);
  l.append(FRAME("S", 1), "S");
  const sizeBefore = fs.statSync(p).size;
  const writeSync = fs.writeSync;
  let calls = 0;
  t.mock.method(fs, "writeSync", ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    offset?: number | null,
    length?: number | null,
    position?: number | null,
  ) => {
    if (calls++ > 0) throw Object.assign(new Error("injected partial write failure"), { code: "EIO" });
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    const start = typeof data === "string" ? 0 : offset ?? 0;
    const requested = typeof data === "string" ? buffer.byteLength : length ?? buffer.byteLength - start;
    return writeSync(fd, buffer, start, Math.max(1, Math.floor(requested / 2)), position);
  }) as typeof fs.writeSync);

  assert.throws(() => l.append(FRAME("S", 2), "S"), /injected partial write failure/);
  assert.equal(fs.statSync(p).size, sizeBefore);
  assert.equal(l.headSeq(), 1);
  assert.deepEqual(l.since(0).map((entry) => entry.seq), [1]);

  t.mock.restoreAll();
  assert.equal(l.append(FRAME("S", 2), "S").seq, 2);
  await l.close();
  const reloaded = new Ledger(p);
  assert.deepEqual(reloaded.since(0).map((entry) => entry.seq), [1, 2]);
});

test("does not report a durable append as failed when retention maintenance fails", async (t) => {
  const p = tmpLedger();
  const l = new Ledger(p, { maxFrames: 1 });
  l.append(FRAME("S", 1), "S");
  const warnings: unknown[][] = [];
  t.mock.method(fs, "writeFileSync", (() => {
    throw new Error("injected retention failure");
  }) as typeof fs.writeFileSync);
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });

  let appendedSeq: number | undefined;
  assert.doesNotThrow(() => { appendedSeq = l.append(FRAME("S", 2), "S").seq; });
  assert.equal(appendedSeq, 2);
  assert.deepEqual(l.since(0).map((entry) => entry.seq), [2]);
  assert.equal(warnings.length, 1);

  t.mock.restoreAll();
  await l.close();
  const reloaded = new Ledger(p, { maxFrames: 1 });
  assert.deepEqual(reloaded.since(0).map((entry) => entry.seq), [2]);
  assert.equal(reloaded.append(FRAME("S", 3), "S").seq, 3);
});

test("persists v2 and reloads with seqs + index intact; nextSeq continues", async () => {
  const p = tmpLedger();
  const a = new Ledger(p);
  a.append(FRAME("S", 1), "S");
  a.append(FRAME("T", 2), "T");
  await a.close();

  const b = new Ledger(p);
  assert.deepEqual(b.since(0).map((e) => e.seq), [1, 2]);
  assert.deepEqual(b.since(0, "S").map((e) => e.seq), [1]);
  assert.equal(b.headSeq(), 2);
  // a new append continues the sequence rather than colliding
  assert.equal(b.append(FRAME("S", 3), "S").seq, 3);
});

test("maxFrames trims oldest, raising floor while head keeps climbing", () => {
  const l = new Ledger(tmpLedger(), { maxFrames: 3 });
  for (let n = 1; n <= 5; n++) l.append(FRAME("S", n), "S");
  assert.equal(l.floorSeq(), 3);          // 1,2 trimmed
  assert.equal(l.headSeq(), 5);           // head unaffected by trimming
  assert.deepEqual(l.since(0).map((e) => e.seq), [3, 4, 5]);
});

test("maxBytes trims oldest until within the byte cap", () => {
  const f = FRAME("S", 1);                // every FRAME(...) is the same length here
  const l = new Ledger(tmpLedger(), { maxBytes: f.length * 2 });
  for (let n = 1; n <= 4; n++) l.append(FRAME("S", n), "S");
  assert.deepEqual(l.since(0).map((e) => e.seq), [3, 4]); // only the last two fit
});

test("trimming drops the trimmed seqs from the per-session index", () => {
  const l = new Ledger(tmpLedger(), { maxFrames: 2 });
  l.append(FRAME("S", 1), "S");
  l.append(FRAME("T", 2), "T");
  l.append(FRAME("S", 3), "S"); // trims seq 1 (S) → S index now [3], T index [2]
  assert.deepEqual(l.since(0, "S").map((e) => e.seq), [3]);
  assert.deepEqual(l.since(0, "T").map((e) => e.seq), [2]);
});

test("a cursor below the raised floor falls outside the retained window", () => {
  const l = new Ledger(tmpLedger(), { maxFrames: 2 });
  for (let n = 1; n <= 5; n++) l.append(FRAME("S", n), "S");
  // floor is 4; a client resuming at cursor 1 is below floor-1, so the gateway would
  // send _gateway/reload — and since() never resurrects the trimmed frames.
  assert.equal(l.floorSeq(), 4);
  assert.deepEqual(l.since(1).map((e) => e.seq), [4, 5]);
});

test("rotation compacts the file yet preserves the tail and seq continuity on reload", async () => {
  const p = tmpLedger();
  const a = new Ledger(p, { maxFrames: 2 });
  for (let n = 1; n <= 10; n++) a.append(FRAME("S", n), "S");
  await a.close();

  // the file was compacted as it grew — it holds the live tail, not all 10 lines
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length <= 4, `expected a compacted file, got ${lines.length} lines`);

  const b = new Ledger(p, { maxFrames: 2 });
  assert.deepEqual(b.since(0).map((e) => e.seq), [9, 10]); // tail survives the restart
  assert.equal(b.headSeq(), 10);
  assert.equal(b.floorSeq(), 9);
  assert.equal(b.append(FRAME("S", 11), "S").seq, 11);     // seq continues, no collision
});

test("loads legacy v1 raw-frame lines, assigning seqs by order, then appends v2", async () => {
  const p = tmpLedger();
  // hand-write a legacy ledger: bare JSON-RPC frames, one per line, no envelope.
  fs.writeFileSync(p, FRAME("S", 1).toString("utf8") + "\n" + FRAME("T", 2).toString("utf8") + "\n");

  const l = new Ledger(p);
  const all = l.since(0);
  assert.deepEqual(all.map((e) => e.seq), [1, 2]); // implicit position == seq
  assert.deepEqual(all.map((e) => e.sid), ["S", "T"]); // sid recovered from the frame
  assert.equal(all[0].frame.toString("utf8"), FRAME("S", 1).toString("utf8")); // byte-exact

  // appends continue at seq 3 as v2
  assert.equal(l.append(FRAME("S", 3), "S").seq, 3);
  await l.close();

  // reopening the now-mixed (v1 prefix + v2 suffix) file stays consistent
  const r = new Ledger(p);
  assert.deepEqual(r.since(0).map((e) => e.seq), [1, 2, 3]);
  assert.equal(r.headSeq(), 3);
});
