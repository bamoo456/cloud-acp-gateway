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
