import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
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

test("hide / unhide round-trips and reports membership", () => {
  const db = new Db(":memory:");
  assert.deepEqual(db.hiddenFolders(), []);
  assert.equal(db.isHidden("/a"), false);

  db.hide("/a");
  assert.equal(db.isHidden("/a"), true);
  assert.deepEqual(db.hiddenFolders(), ["/a"]);

  // hiding the same path again is idempotent
  db.hide("/a");
  assert.deepEqual(db.hiddenFolders(), ["/a"]);

  db.unhide("/a");
  assert.equal(db.isHidden("/a"), false);
  assert.deepEqual(db.hiddenFolders(), []);
  db.close();
});

test("hiddenFolders orders oldest-hidden first", () => {
  const db = new Db(":memory:");
  db.hide("/a");
  db.hide("/b");
  assert.deepEqual(db.hiddenFolders(), ["/a", "/b"]);
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

test("deleting a conversation drops its recency rows under every agent and cwd", () => {
  const db = new Db(":memory:");
  const mk = (agentName: string, cwd: string, id: string) => ({
    agentName, cwd, sessionId: id, title: id, lastActiveAt: "2026-07-20T01:00:00.000Z",
  });
  // One conversation, several rows. Clients write whatever cwd string they hold
  // (symlinked vs realpath'd), and two agents can share a provider AND its
  // transcript store — agents.example.json ships "claude" and "claude-infra".
  // A row left behind is rehydrated by /prefs and resurrects the conversation.
  db.touchRecentSession(mk("claude", "/tmp/repo", "s1"));
  db.touchRecentSession(mk("claude", "/private/tmp/repo", "s1"));
  db.touchRecentSession(mk("claude-infra", "/tmp/repo", "s1"));
  db.touchRecentSession(mk("claude", "/tmp/repo", "s2")); // a different conversation
  db.saveTranscriptMeta({ sessionId: "s1", file: "/t/s1.jsonl", cwd: "/repo", title: "t", lastActivityAt: null, entrypoint: "cli", size: 1, mtimeMs: 1 });

  const left = db.deleteRecentSession("s1");
  assert.deepEqual(left.map((r) => r.sessionId), ["s2"], "every row for the id goes; other conversations stay");
  assert.deepEqual(db.deleteRecentSession("s1"), left, "deleting again is a no-op");

  db.deleteTranscriptMeta("s1");
  assert.equal(db.transcriptMeta("s1"), null);
  db.deleteTranscriptMeta("s1"); // idempotent
  db.close();
});

test("renaming a conversation retitles its recency rows under every agent and cwd", () => {
  const db = new Db(":memory:");
  const mk = (agentName: string, cwd: string, id: string) => ({
    agentName, cwd, sessionId: id, title: "old name", lastActiveAt: "2026-07-20T01:00:00.000Z",
  });
  // Same several-rows-per-conversation shape as the deletion case above: the
  // renaming client only ever POSTs the one row it holds, and a row left with the
  // old title is what /prefs rehydrates into the sidebar on the next load.
  db.touchRecentSession(mk("claude", "/tmp/repo", "s1"));
  db.touchRecentSession(mk("claude", "/private/tmp/repo", "s1"));
  db.touchRecentSession(mk("claude-infra", "/tmp/repo", "s1"));
  db.touchRecentSession(mk("claude", "/tmp/repo", "s2")); // a different conversation

  const after = db.renameRecentSession("s1", "My renamed chat");
  assert.deepEqual(
    after.filter((r) => r.sessionId === "s1").map((r) => r.title),
    ["My renamed chat", "My renamed chat", "My renamed chat"],
    "every row for the id carries the new name",
  );
  assert.deepEqual(after.filter((r) => r.sessionId === "s2").map((r) => r.title), ["old name"],
    "other conversations are untouched");
  assert.deepEqual(db.renameRecentSession("s-unknown", "nobody"), after,
    "a conversation with no recency row is a no-op, not an insert");
  db.close();
});

test("a seed title may name a conversation but never rename one", () => {
  const db = new Db(":memory:");
  const touch = (agentName: string, cwd: string, title: string, at: string, seed = false) =>
    db.touchRecentSession({ agentName, cwd, sessionId: "s1", title, lastActiveAt: at }, seed);

  // The regression this closes: clients touch a session's recency on every frame
  // of a running turn, and any client whose in-memory copy carries no title has to
  // re-derive one from the transcript's first user message. Applying that would
  // undo a rename mid-turn — for every device at once, since this table is shared.
  touch("claude", "/tmp/repo", "My renamed chat", "2026-07-20T01:00:00.000Z");
  const after = touch("claude", "/tmp/repo", "fix the flaky test please", "2026-07-20T02:00:00.000Z", true);
  assert.deepEqual(after.map((r) => r.title), ["My renamed chat"], "the recorded name survives");
  assert.equal(after[0].lastActiveAt, "2026-07-20T02:00:00.000Z", "recency still moves");

  // A first touch under a second spelling of the folder (or a second agent sharing
  // the provider) inserts a row — it must adopt the name already on record instead
  // of seeding a duplicate wearing the one the conversation was renamed away from.
  const other = touch("claude-infra", "/private/tmp/repo", "fix the flaky test please", "2026-07-20T03:00:00.000Z", true);
  assert.deepEqual(other.map((r) => r.title), ["My renamed chat", "My renamed chat"]);

  // Only the overwrite is blocked: nothing on record (and the "Untitled" /
  // empty-string placeholders don't count) still gets named by the derived title.
  db.touchRecentSession({ agentName: "claude", cwd: "/tmp/other", sessionId: "s2", title: "Untitled", lastActiveAt: "2026-07-20T04:00:00.000Z" }, true);
  const named = db.touchRecentSession({ agentName: "claude", cwd: "/tmp/other", sessionId: "s2", title: "and now a first message", lastActiveAt: "2026-07-20T05:00:00.000Z" }, true);
  assert.equal(named.find((r) => r.sessionId === "s2")?.title, "and now a first message");

  // Two rows can each carry a real (but different) name — two devices that seeded
  // one before either saw the other's. The row adopted has to be the newest, which
  // is the order the client's own cache is in; picking a different one would have
  // the cache and this table store different names and the next /prefs load flip
  // the display, which is the same "sometimes it's the old name" this closes.
  db.touchRecentSession({ agentName: "codex", cwd: "/tmp/repo", sessionId: "s3", title: "seeded on the laptop", lastActiveAt: "2026-07-20T01:00:00.000Z" });
  db.touchRecentSession({ agentName: "codex", cwd: "/tmp/elsewhere", sessionId: "s3", title: "seeded on the phone", lastActiveAt: "2026-07-20T09:00:00.000Z" });
  const third = db.touchRecentSession({ agentName: "codex", cwd: "/tmp/third", sessionId: "s3", title: "derived just now", lastActiveAt: "2026-07-20T10:00:00.000Z" }, true);
  assert.equal(third.find((r) => r.cwd === "/tmp/third")?.title, "seeded on the phone");

  // The gateway's own prompt-side recency hint carries the running-task label (the
  // first prompt's text), so it is a seed in the same sense and gets the same guard.
  db.touchSessionMessage({ agentName: "codex", cwd: "/tmp/repo", sessionId: "s1", title: "fix the flaky test please", at: "2026-07-20T06:00:00.000Z" });
  assert.deepEqual(
    db.recentSessions().filter((r) => r.sessionId === "s1").map((r) => r.title),
    ["My renamed chat", "My renamed chat", "My renamed chat"],
  );
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

test("inbox: deleting a conversation voids its pending prompts under every agent", () => {
  const db = new Db(":memory:");
  db.addInboxItem(perm("1", "sA"));
  db.addInboxItem({ ...perm("2", "sA"), agentName: "claude-infra" }); // same conversation, other agent
  db.addInboxItem(perm("3", "sB"));

  db.cancelInboxForSessionId("sA", "2026-07-20T01:01:00.000Z");

  assert.deepEqual(db.inbox({ status: "pending" }).map((i) => i.reqId), ["3"], "only the other conversation is left pending");
  assert.deepEqual(db.inbox({ status: "cancelled" }).map((i) => i.reqId).sort(), ["1", "2"],
    "the agent-scoped cancel would have missed the second one");
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

test("recent_sessions gains last_message_at on an existing DB, rows intact", () => {
  const dir = `/tmp/acpb-db-migrate-${process.pid}-${Date.now()}`;
  const file = `${dir}/state.sqlite`;
  fs.mkdirSync(dir, { recursive: true });
  // The pre-migration schema, with a row in it — the live DB's situation.
  const old = new Database(file);
  old.exec(`CREATE TABLE recent_sessions (
    agent_name TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT NOT NULL,
    title TEXT NOT NULL, last_active_at TEXT NOT NULL,
    PRIMARY KEY (agent_name, cwd, session_id)
  )`);
  old.prepare("INSERT INTO recent_sessions VALUES (?, ?, ?, ?, ?)")
    .run("claude", "/repo", "s1", "kept", "2026-06-10T01:00:00.000Z");
  old.close();

  const kept = { agentName: "claude", cwd: "/repo", sessionId: "s1", title: "kept", lastActiveAt: "2026-06-10T01:00:00.000Z" };
  const db = new Db(file);
  assert.deepEqual(db.recentSessions(), [kept], "the existing row survives the migration");
  assert.deepEqual(db.lastMessageAtBySession(), new Map(), "the new column starts null");

  db.touchSessionMessage({ agentName: "claude", cwd: "/repo", sessionId: "s1", title: "ignored", at: "2026-06-11T02:00:00.000Z" });
  assert.deepEqual(db.lastMessageAtBySession(), new Map([["s1", "2026-06-11T02:00:00.000Z"]]));
  assert.deepEqual(db.recentSessions(), [kept], "turn traffic leaves the client's title / last_active_at alone");
  db.close();

  // Re-running the migration over an already-migrated DB is a no-op.
  const again = new Db(file);
  assert.deepEqual(again.lastMessageAtBySession(), new Map([["s1", "2026-06-11T02:00:00.000Z"]]));
  again.close();
});

test("touchSessionMessage records a gateway-driven session and bumps it in place", () => {
  const db = new Db(":memory:");
  // No client ever recorded this session: the prompt itself creates the row.
  db.touchSessionMessage({ agentName: "claude", cwd: "/repo", sessionId: "s1", title: "first prompt", at: "2026-06-10T01:00:00.000Z" });
  assert.deepEqual(db.recentSessions(), [{
    agentName: "claude", cwd: "/repo", sessionId: "s1", title: "first prompt", lastActiveAt: "2026-06-10T01:00:00.000Z",
  }]);

  db.touchSessionMessage({ agentName: "claude", cwd: "/repo", sessionId: "s1", title: "second prompt", at: "2026-06-10T03:00:00.000Z" });
  assert.deepEqual(db.lastMessageAtBySession(), new Map([["s1", "2026-06-10T03:00:00.000Z"]]));
  assert.equal(db.recentSessions().length, 1, "the same session is bumped, not duplicated");
  assert.equal(db.recentSessions()[0].lastActiveAt, "2026-06-10T01:00:00.000Z", "last_active_at stays where the row was created");

  // Without a cwd the key is incomplete: an existing row is still bumped, but an
  // unknown session can't be conjured out of one.
  db.touchSessionMessage({ agentName: "claude", cwd: "", sessionId: "s1", title: "", at: "2026-06-10T04:00:00.000Z" });
  db.touchSessionMessage({ agentName: "claude", cwd: "", sessionId: "unknown", title: "", at: "2026-06-10T05:00:00.000Z" });
  assert.deepEqual(db.lastMessageAtBySession(), new Map([["s1", "2026-06-10T04:00:00.000Z"]]));
  assert.deepEqual(db.recentSessions().map((r) => r.sessionId), ["s1"]);
  db.close();
});

test("a session's controls round-trip, are replaced as a set, and go with the conversation", () => {
  const db = new Db(":memory:");

  const controls = (agent: string, sid: string) => Object.fromEntries(db.sessionControls(agent, sid));
  assert.deepEqual(controls("claude", "s1"), {}, "nothing recorded reads as empty, not as a throw");

  db.setSessionControls("claude", "s1", new Map([["model", "opus[1m]"], ["effort", "xhigh"]]));
  // Compared as a set of pairs: the rows come back in the primary key's order, not
  // the order they were written, and nothing downstream depends on either.
  assert.deepEqual(controls("claude", "s1"), { model: "opus[1m]", effort: "xhigh" });

  // Replaced, not merged: `effort` is gone from the session's option list (a model
  // switch dropped it), and a lingering row would be re-applied to a rebuild that
  // no longer has it.
  db.setSessionControls("claude", "s1", new Map([["model", "sonnet"]]));
  assert.deepEqual(controls("claude", "s1"), { model: "sonnet" });

  // Same id under another agent is another session's record (two agents can share
  // a transcript store but not a control vocabulary).
  db.setSessionControls("codex", "s1", new Map([["reasoning_effort", "high"]]));
  assert.deepEqual(controls("claude", "s1"), { model: "sonnet" });

  // Deleting the conversation takes every agent's record of it, like its recency
  // rows — otherwise a resurrected id would be re-applied stale values.
  db.deleteSessionControls("s1");
  assert.deepEqual(controls("claude", "s1"), {});
  assert.deepEqual(controls("codex", "s1"), {});
});
