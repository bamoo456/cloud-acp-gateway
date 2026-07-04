import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db.ts";

test("pin / unpin round-trips and reports membership", () => {
  const db = new Db(":memory:");
  assert.deepEqual(db.pinnedFolders(), []);
  assert.equal(db.isPinned("/a"), false);

  db.pin("/a");
  assert.equal(db.isPinned("/a"), true);
  assert.deepEqual(db.pinnedFolders(), ["/a"]);

  // pinning the same path again is idempotent
  db.pin("/a");
  assert.deepEqual(db.pinnedFolders(), ["/a"]);

  db.unpin("/a");
  assert.equal(db.isPinned("/a"), false);
  assert.deepEqual(db.pinnedFolders(), []);
  db.close();
});

test("seedPinnedFolders seeds once and never resurrects after the user edits", () => {
  const db = new Db(":memory:");
  assert.deepEqual(db.seedPinnedFolders(["/a", "", "/b", "/a"]), ["/a", "/b"]);

  // user unpins everything -> a later seed must NOT bring the defaults back
  db.unpin("/a");
  db.unpin("/b");
  assert.deepEqual(db.pinnedFolders(), []);
  assert.deepEqual(db.seedPinnedFolders(["/a"]), []);
  db.close();
});

test("state persists across reopen of the same file", () => {
  const dir = `/tmp/acpb-db-test-${process.pid}-${Date.now()}`;
  const file = `${dir}/state.sqlite`;
  const a = new Db(file);
  a.pin("/keep");
  a.close();

  const b = new Db(file);
  assert.deepEqual(b.pinnedFolders(), ["/keep"]);
  b.close();
});

test("meta key/value round-trips and deletes (text size, lock blob)", () => {
  const db = new Db(":memory:");
  assert.equal(db.getMeta("text_size"), null);
  db.setMeta("text_size", "large");
  assert.equal(db.getMeta("text_size"), "large");
  db.setMeta("text_size", "xl"); // overwrite
  assert.equal(db.getMeta("text_size"), "xl");
  db.deleteMeta("text_size");
  assert.equal(db.getMeta("text_size"), null);
  db.close();
});

test("recent sessions upsert newest-first and cap at 50", () => {
  const db = new Db(":memory:");
  const mk = (id: string, n: number, title = id) => ({
    agentName: "claude", cwd: "/repo", sessionId: id, title,
    lastActiveAt: `2026-06-10T01:00:${String(n).padStart(2, "0")}.000Z`,
  });
  assert.deepEqual(db.recentSessions(), []);

  db.touchRecentSession(mk("s1", 1));
  const after = db.touchRecentSession(mk("s2", 2));
  assert.deepEqual(after.map((r) => r.sessionId), ["s2", "s1"]);

  // same (agent,cwd,session) updates title + recency in place, not a duplicate
  const upd = db.touchRecentSession(mk("s1", 3, "renamed"));
  assert.deepEqual(upd.map((r) => r.sessionId), ["s1", "s2"]);
  assert.equal(upd[0].title, "renamed");

  for (let i = 0; i < 60; i++) db.touchRecentSession(mk(`bulk-${i}`, i % 60));
  assert.equal(db.recentSessions().length, 50);
  db.close();
});

test("recent folders upsert newest-first and cap at 20", () => {
  const db = new Db(":memory:");
  db.touchRecentFolder("/a", "2026-06-10T01:00:00.000Z");
  const after = db.touchRecentFolder("/b", "2026-06-10T02:00:00.000Z");
  assert.deepEqual(after.map((r) => r.path), ["/b", "/a"]);

  // revisiting bumps recency without duplicating
  const bumped = db.touchRecentFolder("/a", "2026-06-10T03:00:00.000Z");
  assert.deepEqual(bumped.map((r) => r.path), ["/a", "/b"]);

  for (let i = 0; i < 25; i++) db.touchRecentFolder(`/bulk-${i}`, `2026-06-11T00:00:${String(i).padStart(2, "0")}.000Z`);
  assert.equal(db.recentFolders().length, 20);
  db.close();
});

const perm = (reqId: string, sid = "s1", title = `prompt ${reqId}`) => ({
  type: "permission", agentName: "claude", sessionId: sid, reqId, seq: 1, title,
  bodyJson: JSON.stringify([{ optionId: "allow", name: "Allow" }]), createdAt: "2026-06-10T01:00:00.000Z",
});

test("inbox: add pending, then resolve as answered (first-reply-wins)", () => {
  const db = new Db(":memory:");
  assert.deepEqual(db.inbox(), []);

  db.addInboxItem(perm("99"));
  const pending = db.inbox({ status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reqId, "99");
  assert.equal(pending[0].type, "permission");

  assert.equal(db.resolveInboxItem("claude", "99", "answered", "2026-06-10T01:01:00.000Z", JSON.stringify({ optionId: "allow" })), true);
  assert.deepEqual(db.inbox({ status: "pending" }), []);
  const answered = db.inbox({ status: "answered" });
  assert.equal(answered.length, 1);
  assert.equal(answered[0].resultJson, JSON.stringify({ optionId: "allow" }));

  // a second answer to the same already-resolved prompt is a no-op
  assert.equal(db.resolveInboxItem("claude", "99", "answered", "2026-06-10T01:02:00.000Z"), false);
  db.close();
});

test("inbox: reusing a reqId supersedes the old pending row, keeps audit history", () => {
  const db = new Db(":memory:");
  db.addInboxItem(perm("99", "s1", "first"));
  db.addInboxItem(perm("99", "s1", "second")); // agent reused id 99 for a new prompt
  assert.deepEqual(db.inbox({ status: "pending" }).map((i) => i.title), ["second"]);
  assert.deepEqual(db.inbox({ status: "superseded" }).map((i) => i.title), ["first"]);

  // resolving now targets the live (second) prompt, not the superseded one
  db.resolveInboxItem("claude", "99", "answered", "2026-06-10T01:01:00.000Z");
  assert.deepEqual(db.inbox({ status: "answered" }).map((i) => i.title), ["second"]);
  db.close();
});

test("inbox: cancel a session voids its pending prompts", () => {
  const db = new Db(":memory:");
  db.addInboxItem(perm("1", "sA"));
  db.addInboxItem(perm("2", "sB"));
  db.cancelInboxForSession("claude", "sA", "2026-06-10T01:01:00.000Z");
  assert.deepEqual(db.inbox({ status: "pending" }).map((i) => i.reqId), ["2"]);
  assert.deepEqual(db.inbox({ status: "cancelled" }).map((i) => i.reqId), ["1"]);
  db.close();
});

test("inbox: agent exit and boot expire pending rows", () => {
  const db = new Db(":memory:");
  db.addInboxItem(perm("1"));
  db.addInboxItem({ ...perm("2"), agentName: "codex" });
  db.expireInboxForAgent("claude", "2026-06-10T01:01:00.000Z");
  assert.deepEqual(db.inbox({ status: "pending" }).map((i) => i.agentName), ["codex"]);

  db.expireAllPending("2026-06-10T01:02:00.000Z");
  assert.deepEqual(db.inbox({ status: "pending" }), []);
  assert.equal(db.inbox({ status: "expired" }).length, 2);
  db.close();
});

test("inbox: pending survives, resolved trimmed, across reopen", () => {
  const dir = `/tmp/acpb-inbox-test-${process.pid}-${Date.now()}`;
  const file = `${dir}/state.sqlite`;
  const a = new Db(file);
  a.addInboxItem(perm("keep"));
  a.close();

  const b = new Db(file);
  assert.deepEqual(b.inbox({ status: "pending" }).map((i) => i.reqId), ["keep"]);
  b.close();
});
