/**
 * Server-side persistent state, shared across every client and source IP.
 *
 * The gateway runs a single shared account (ACPG_AUTH_USER/TOKEN), so "my"
 * favorites are really "the account's" favorites. Keeping them here — in a
 * SQLite file on the persistent ledger dir — means they survive a client
 * switching device, browser, or source IP. Browser localStorage can't: it is
 * scoped per origin (and thus per host/IP), so a reconnect from a different IP
 * starts with an empty list.
 *
 * Uses Node's built-in node:sqlite (DatabaseSync) — available unflagged on
 * Node 24+, which this branch targets. That drops the better-sqlite3 native
 * addon entirely: nothing to compile, nothing to mark external in the esbuild
 * bundle, and no node_modules binary to ship at runtime. Its API is synchronous,
 * matching the rest of the gateway's file I/O (the ledger). The `node22` branch
 * keeps better-sqlite3 for hosts still pinned to Node 22.
 *
 * Everything the web UI used to keep in browser localStorage now lives here, for
 * the same reason: a single account driving the gateway from several devices is
 * like SSHing into one machine — the preferences and history should look the same
 * everywhere. That covers pinned + recent folders, recent sessions, the text-size
 * preference, and the screen-lock config (the `meta` key/value table holds the two
 * scalar prefs; recents get their own tables). Only the live locked/unlocked state
 * stays per-device — locking a phone must not lock the laptop.
 */
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Recent sessions / folders mirror the web client's old localStorage shapes, so
// the UI types line up. They now live here (server-side) so the same account sees
// the same recents from any device or source IP — see the file header.
export interface RecentSession {
  agentName: string;
  cwd: string;
  sessionId: string;
  title: string;
  lastActiveAt: string;
}
export interface RecentFolder { path: string; lastUsedAt: string; }

// One Claude CLI transcript's derived metadata, cached so listing conversations
// doesn't re-read the files. `cwd`/`title` are immutable per session (derived
// once from the head); `last_activity_at` is the timestamp of the last real turn
// INSIDE the transcript and is re-derived whenever (size, mtime_ms) move. `file`
// is part of the freshness check: the same session id can appear under two
// project dirs when the CLI truncates a long encoded name. `entrypoint` is the
// CLI's own record of how the session was started ("cli", "sdk-ts", "sdk-cli"),
// read from the head with cwd/title and used to hide headless runs from history.
export interface TranscriptMeta {
  sessionId: string;
  file: string;
  cwd: string;
  title: string | null;
  lastActivityAt: string | null;
  entrypoint: string | null;
  size: number;
  mtimeMs: number;
}

// A durable "inbox" item. Generic over `type` so it can hold permission prompts
// today and other notification kinds (task-done, agent-error, ...) later. A
// permission row additionally carries `reqId`/`seq`/`frame` so the live answer
// path can re-deliver and route it; non-permission types leave those null.
export interface InboxItem {
  id: number;
  type: string;                 // 'permission' | 'task_done' | 'agent_error' | ...
  agentName: string;
  sessionId: string | null;
  reqId: string | null;         // agent's request id (permission); agents reuse these
  seq: number | null;           // ledger seq, for ordering / re-delivery
  title: string;
  bodyJson: string | null;      // per-type payload (permission: PermissionOption[])
  status: InboxStatus;
  createdAt: string;
  resolvedAt: string | null;
  resultJson: string | null;    // the answer / outcome once resolved
}
export type InboxStatus = "pending" | "answered" | "cancelled" | "expired" | "superseded";

const MAX_RECENT_SESSIONS = 50;
const MAX_RECENT_FOLDERS = 20;
// Cap the audit trail: keep every pending item plus the newest resolved ones, so
// the table can't grow without bound while a useful recent history survives.
const MAX_INBOX_RESOLVED = 500;

export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL keeps reads from blocking the occasional write; meaningless for :memory:.
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS pinned_folders (
      path TEXT PRIMARY KEY,
      pinned_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS recent_sessions (
      agent_name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      last_message_at TEXT,
      PRIMARY KEY (agent_name, cwd, session_id)
    )`);
    // `last_message_at` arrived after the table did, and CREATE IF NOT EXISTS is a
    // no-op on a DB that already has rows — graft the column on instead. Guarded by
    // table_info so this is safe on every boot (ALTER would otherwise throw).
    const recentCols = this.db.prepare("PRAGMA table_info(recent_sessions)").all() as Array<{ name: string }>;
    if (!recentCols.some((c) => c.name === "last_message_at")) {
      this.db.exec("ALTER TABLE recent_sessions ADD COLUMN last_message_at TEXT");
    }
    // What a session's controls (model / effort / mode / …) were last known to be.
    // The adapter keeps them in memory only, so a gateway restart plus a later
    // session/load rebuilds the session at its DEFAULTS with nothing left in
    // memory to compare against — these rows are the only record of what the
    // conversation was actually running. Keyed by agent too: two agents can share
    // a transcript store but not a control vocabulary.
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_controls (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id, config_id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS recent_folders (
      path TEXT PRIMARY KEY,
      last_used_at TEXT NOT NULL
    )`);
    // Generic notification inbox. A surrogate `id` (not (agent,req_id)) is the key
    // because agents reuse request ids across rounds — a new prompt must never
    // overwrite an earlier answered row, or the audit trail is lost.
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      req_id TEXT,
      seq INTEGER,
      title TEXT NOT NULL,
      body_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      result_json TEXT
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_lookup ON inbox(agent_name, req_id, status)`);
    // Derived metadata for the Claude CLI transcripts, keyed by session id — see
    // TranscriptMeta. Purely a cache: dropping the table only costs a re-derive,
    // which is also the whole migration story — a pre-`entrypoint` row would
    // never be refreshed on its own (the head is only re-read when the cached
    // title is missing), so an added column would stay NULL forever.
    const cols = this.db.prepare("PRAGMA table_info(transcript_meta)").all() as Array<{ name: string }>;
    if (cols.length && !cols.some((c) => c.name === "entrypoint")) this.db.exec(`DROP TABLE transcript_meta`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS transcript_meta (
      session_id       TEXT PRIMARY KEY,
      file             TEXT NOT NULL,
      cwd              TEXT NOT NULL,
      title            TEXT,
      last_activity_at TEXT,
      entrypoint       TEXT,
      size             INTEGER NOT NULL,
      mtime_ms         INTEGER NOT NULL
    )`);
  }

  // Generic key/value state shared across devices: the UI's text-size preference
  // (key "text_size") and the screen-lock config blob (key "screen_lock", an
  // opaque JSON string — the PIN is PBKDF2-hashed in the browser, never here).
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  // Recently active sessions, most-recent first, capped like the old client cache.
  recentSessions(): RecentSession[] {
    const rows = this.db
      .prepare("SELECT agent_name, cwd, session_id, title, last_active_at FROM recent_sessions ORDER BY last_active_at DESC")
      .all() as Array<{ agent_name: string; cwd: string; session_id: string; title: string; last_active_at: string }>;
    return rows.map((r) => ({
      agentName: r.agent_name, cwd: r.cwd, sessionId: r.session_id, title: r.title, lastActiveAt: r.last_active_at,
    }));
  }

  // The title a conversation already answers to, from ANY of its recency rows.
  // Rows are per (agent, cwd, session) but a title belongs to the conversation,
  // so the id alone identifies it — the same reasoning spelled out above
  // deleteRecentSession. "" and "Untitled" are placeholders a client fell back to,
  // not answers, so they don't count as recorded.
  //
  // Newest row first, matching how the client's own cache is ordered: with no
  // ORDER BY, SQLite would answer in rowid (insertion) order while the client
  // answers in recency order, so two rows carrying different real titles — two
  // devices that each seeded one before seeing the other's — would have the two
  // sides adopt different names and the next /prefs load flip the display.
  private recordedTitle(sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT title FROM recent_sessions
        WHERE session_id = ? AND title <> '' AND title <> 'Untitled'
        ORDER BY last_active_at DESC LIMIT 1`)
      .get(sessionId) as { title: string } | undefined;
    return row ? row.title : null;
  }

  // Upsert one session's recency, then trim to the newest MAX_RECENT_SESSIONS.
  //
  // `seedTitle` marks a title the caller DERIVED (from the transcript's first user
  // message, or a bare "Untitled") rather than one the user chose. A derived title
  // must never overwrite a recorded one: clients touch this on every frame of a
  // running turn, and any client whose in-memory session carries no title — a
  // deep-link join, an agent restart, a second device — re-derives the first
  // message and would otherwise clobber a rename mid-turn, on every device at once.
  // Enforced here rather than in each client because this is the one choke point
  // every device writes through.
  touchRecentSession(s: RecentSession, seedTitle = false): RecentSession[] {
    const title = (seedTitle ? this.recordedTitle(s.sessionId) : null) ?? s.title;
    this.db
      .prepare(`INSERT INTO recent_sessions (agent_name, cwd, session_id, title, last_active_at)
        VALUES (@agentName, @cwd, @sessionId, @title, @lastActiveAt)
        ON CONFLICT(agent_name, cwd, session_id)
        DO UPDATE SET title = excluded.title, last_active_at = excluded.last_active_at`)
      .run({ ...s, title }); // spread to a plain literal: node:sqlite wants Record<string, …>, which the RecentSession interface isn't
    this.trimRecentSessions();
    return this.recentSessions();
  }

  // Drop a deleted conversation's recency rows — every one of them, keyed on the
  // session id alone rather than the table's (agent, cwd, session) primary key.
  // Both of the other columns produce rows this would otherwise miss, and a missed
  // row is not cosmetic: /prefs rehydrates it and resurrects a conversation whose
  // transcript is gone.
  //   cwd    — writers store whatever string the client sent, the delete route
  //            realpaths it, so a symlinked project path never matches.
  //   agent  — two agents can share one provider (agents.example.json ships
  //            "claude" and "claude-infra"), and they share its transcript store,
  //            so the same conversation is recorded under both names.
  // The id identifies the conversation on its own; the extra columns only record
  // where it was seen from. Idempotent.
  deleteRecentSession(sessionId: string): RecentSession[] {
    this.db.prepare("DELETE FROM recent_sessions WHERE session_id = ?").run(sessionId);
    return this.recentSessions();
  }

  // The controls a session was last known to be running, or an empty map when it
  // has none recorded (a conversation from before this was tracked).
  sessionControls(agentName: string, sessionId: string): Map<string, string> {
    const rows = this.db
      .prepare("SELECT config_id, value FROM session_controls WHERE agent_name = ? AND session_id = ?")
      .all(agentName, sessionId) as Array<{ config_id: string; value: string }>;
    return new Map(rows.map((r) => [r.config_id, r.value]));
  }

  // Record a session's controls. Replaces the whole set rather than merging: the
  // caller tracks them as one snapshot, and an option the session has stopped
  // reporting should not linger to be re-applied to a rebuild that lacks it.
  setSessionControls(agentName: string, sessionId: string, values: Map<string, string>): void {
    const at = new Date().toISOString();
    this.db.prepare("DELETE FROM session_controls WHERE agent_name = ? AND session_id = ?").run(agentName, sessionId);
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO session_controls (agent_name, session_id, config_id, value, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [configId, value] of values) stmt.run(agentName, sessionId, configId, value, at);
  }

  // Drop a deleted conversation's controls. Keyed on the id alone, like
  // deleteRecentSession — the same conversation can be recorded under two agents.
  deleteSessionControls(sessionId: string): void {
    this.db.prepare("DELETE FROM session_controls WHERE session_id = ?").run(sessionId);
  }

  // Apply a rename to a conversation's recency rows. Keyed on the session id
  // alone for the reasons spelled out above deleteRecentSession — the cwd and
  // agent columns record where a conversation was SEEN from, so the same
  // conversation legitimately holds several rows and a rename belongs to all of
  // them. A missed row is what makes a renamed conversation show its old name
  // again after /prefs rehydrates the list. Idempotent; inserts nothing (a
  // conversation with no recency row has no snapshot to correct).
  renameRecentSession(sessionId: string, title: string): RecentSession[] {
    this.db.prepare("UPDATE recent_sessions SET title = ? WHERE session_id = ?").run(title, sessionId);
    return this.recentSessions();
  }

  private trimRecentSessions(): void {
    this.db.prepare(`DELETE FROM recent_sessions WHERE rowid NOT IN (
      SELECT rowid FROM recent_sessions ORDER BY last_active_at DESC LIMIT ${MAX_RECENT_SESSIONS}
    )`).run();
  }

  // Record real turn traffic for a session — the gateway calls this when it
  // actually pumps a prompt to the agent. Deliberately NOT last_active_at, which a
  // client also bumps merely by opening a conversation; only this column means
  // "someone talked to it". Inserts when no client has recorded the session yet
  // (not every client POSTs /prefs/recent-session) — a prompt IS activity, so
  // seeding last_active_at from it is honest — while an existing row keeps the
  // title and last_active_at the client owns.
  touchSessionMessage(s: { agentName: string; cwd: string; sessionId: string; title: string; at: string }): void {
    if (!s.cwd) {
      // Without a cwd the primary key can't be completed, so this can only bump
      // whatever rows already exist for the session (any of its folders).
      this.db.prepare("UPDATE recent_sessions SET last_message_at = ? WHERE agent_name = ? AND session_id = ?")
        .run(s.at, s.agentName, s.sessionId);
      return;
    }
    // The caller's title is the task label (the first prompt's text), so it is a
    // seed in exactly the sense touchRecentSession means: it may only name a row
    // this creates. The insert below fires whenever the conversation has no row
    // for THIS spelling of its folder, and without this a renamed conversation
    // gains a second recency row wearing the name it was renamed away from.
    const title = this.recordedTitle(s.sessionId) ?? s.title;
    this.db
      .prepare(`INSERT INTO recent_sessions (agent_name, cwd, session_id, title, last_active_at, last_message_at)
        VALUES (@agentName, @cwd, @sessionId, @title, @at, @at)
        ON CONFLICT(agent_name, cwd, session_id)
        DO UPDATE SET last_message_at = excluded.last_message_at`)
      .run({ ...s, title });
    this.trimRecentSessions();
  }

  // sessionId -> newest turn traffic, for the conversation list's recency. The
  // transcript on disk is not the whole story: a session driven only through the
  // gateway may have nothing fresh in it, so the two sources are merged. MAX()
  // because one session id can be recorded under several (agent, cwd) rows.
  lastMessageAtBySession(): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT session_id, MAX(last_message_at) AS last_message_at FROM recent_sessions
        WHERE last_message_at IS NOT NULL GROUP BY session_id`)
      .all() as Array<{ session_id: string; last_message_at: string }>;
    return new Map(rows.map((r) => [r.session_id, r.last_message_at]));
  }

  recentFolders(): RecentFolder[] {
    const rows = this.db
      .prepare("SELECT path, last_used_at FROM recent_folders ORDER BY last_used_at DESC")
      .all() as Array<{ path: string; last_used_at: string }>;
    return rows.map((r) => ({ path: r.path, lastUsedAt: r.last_used_at }));
  }

  touchRecentFolder(p: string, lastUsedAt: string): RecentFolder[] {
    this.db
      .prepare(`INSERT INTO recent_folders (path, last_used_at) VALUES (?, ?)
        ON CONFLICT(path) DO UPDATE SET last_used_at = excluded.last_used_at`)
      .run(p, lastUsedAt);
    this.db.prepare(`DELETE FROM recent_folders WHERE rowid NOT IN (
      SELECT rowid FROM recent_folders ORDER BY last_used_at DESC LIMIT ${MAX_RECENT_FOLDERS}
    )`).run();
    return this.recentFolders();
  }

  // ------------------------------------------------------- transcript cache ----

  transcriptMeta(sessionId: string): TranscriptMeta | null {
    const row = this.db
      .prepare("SELECT session_id, file, cwd, title, last_activity_at, entrypoint, size, mtime_ms FROM transcript_meta WHERE session_id = ?")
      .get(sessionId) as
        | { session_id: string; file: string; cwd: string; title: string | null; last_activity_at: string | null; entrypoint: string | null; size: number; mtime_ms: number }
        | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id, file: row.file, cwd: row.cwd, title: row.title,
      lastActivityAt: row.last_activity_at, entrypoint: row.entrypoint,
      size: Number(row.size), mtimeMs: Number(row.mtime_ms),
    };
  }

  saveTranscriptMeta(m: TranscriptMeta): void {
    this.db
      .prepare(`INSERT INTO transcript_meta (session_id, file, cwd, title, last_activity_at, entrypoint, size, mtime_ms)
        VALUES (@sessionId, @file, @cwd, @title, @lastActivityAt, @entrypoint, @size, @mtimeMs)
        ON CONFLICT(session_id) DO UPDATE SET
          file = excluded.file, cwd = excluded.cwd, title = excluded.title,
          last_activity_at = excluded.last_activity_at, entrypoint = excluded.entrypoint,
          size = excluded.size, mtime_ms = excluded.mtime_ms`)
      .run({ ...m }); // spread to a plain literal: node:sqlite wants Record<string, …>
  }

  // Forget one transcript's cached metadata — the transcript is gone, so the row
  // would otherwise keep feeding lastMessageAtBySession and the recency ranking.
  deleteTranscriptMeta(sessionId: string): void {
    this.db.prepare("DELETE FROM transcript_meta WHERE session_id = ?").run(sessionId);
  }

  // Pinned ("favorite") folders, oldest-pinned first for a stable display order.
  pinnedFolders(): string[] {
    const rows = this.db
      .prepare("SELECT path FROM pinned_folders ORDER BY pinned_at, path")
      .all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  isPinned(p: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pinned_folders WHERE path = ?").get(p);
  }

  pin(p: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO pinned_folders (path, pinned_at) VALUES (?, ?)")
      .run(p, new Date().toISOString());
  }

  unpin(p: string): void {
    this.db.prepare("DELETE FROM pinned_folders WHERE path = ?").run(p);
  }

  // First-run seeding from the agents' cwds. A `pinned_seeded` sentinel records
  // that seeding already ran, so unpinning everything does NOT resurrect the
  // defaults on the next read (mirrors the old localStorage rule: once the user
  // has touched the list — even down to empty — it is theirs). Returns the list.
  seedPinnedFolders(defaults: string[]): string[] {
    const already = this.db.prepare("SELECT 1 FROM meta WHERE key = 'pinned_seeded'").get();
    if (!already) {
      const now = new Date().toISOString();
      const ins = this.db.prepare("INSERT OR IGNORE INTO pinned_folders (path, pinned_at) VALUES (?, ?)");
      for (const p of [...new Set(defaults.filter(Boolean))]) ins.run(p, now);
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('pinned_seeded', ?)").run(now);
    }
    return this.pinnedFolders();
  }

  // ----------------------------------------------------------------- inbox ----

  private mapInbox(r: {
    id: number; type: string; agent_name: string; session_id: string | null; req_id: string | null;
    seq: number | null; title: string; body_json: string | null; status: string; created_at: string;
    resolved_at: string | null; result_json: string | null;
  }): InboxItem {
    return {
      id: r.id, type: r.type, agentName: r.agent_name, sessionId: r.session_id, reqId: r.req_id,
      seq: r.seq, title: r.title, bodyJson: r.body_json, status: r.status as InboxStatus,
      createdAt: r.created_at, resolvedAt: r.resolved_at, resultJson: r.result_json,
    };
  }

  // Record a new inbox item and return its id. For an item carrying a reqId, any
  // still-pending row with the same (agent, reqId) is marked "superseded" first:
  // agents reuse request ids, so a fresh prompt replaces an unanswered older one
  // without clobbering the audit trail. Trims old resolved rows past the cap.
  addInboxItem(item: {
    type: string; agentName: string; sessionId?: string | null; reqId?: string | null;
    seq?: number | null; title: string; bodyJson?: string | null; createdAt: string;
  }): number {
    if (item.reqId != null) {
      this.db.prepare("UPDATE inbox SET status = 'superseded', resolved_at = ? WHERE agent_name = ? AND req_id = ? AND status = 'pending'")
        .run(item.createdAt, item.agentName, item.reqId);
    }
    const info = this.db.prepare(`INSERT INTO inbox (type, agent_name, session_id, req_id, seq, title, body_json, status, created_at)
      VALUES (@type, @agentName, @sessionId, @reqId, @seq, @title, @bodyJson, 'pending', @createdAt)`)
      .run({
        type: item.type, agentName: item.agentName, sessionId: item.sessionId ?? null,
        reqId: item.reqId ?? null, seq: item.seq ?? null, title: item.title,
        bodyJson: item.bodyJson ?? null, createdAt: item.createdAt,
      });
    this.db.prepare(`DELETE FROM inbox WHERE status != 'pending' AND id NOT IN (
      SELECT id FROM inbox WHERE status != 'pending' ORDER BY id DESC LIMIT ${MAX_INBOX_RESOLVED}
    )`).run();
    return Number(info.lastInsertRowid);
  }

  // Resolve the newest pending permission for (agent, reqId). Returns true if a
  // pending row was updated — mirrors the gateway's first-reply-wins gate so a
  // duplicate answer is a no-op.
  resolveInboxItem(agentName: string, reqId: string, status: InboxStatus, resolvedAt: string, resultJson?: string | null): boolean {
    const info = this.db.prepare(`UPDATE inbox SET status = ?, resolved_at = ?, result_json = ?
      WHERE id = (SELECT id FROM inbox WHERE agent_name = ? AND req_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1)`)
      .run(status, resolvedAt, resultJson ?? null, agentName, reqId);
    return info.changes > 0;
  }

  // A cancelled turn voids all of its session's pending prompts.
  cancelInboxForSession(agentName: string, sessionId: string, resolvedAt: string): void {
    this.db.prepare("UPDATE inbox SET status = 'cancelled', resolved_at = ? WHERE agent_name = ? AND session_id = ? AND status = 'pending'")
      .run(resolvedAt, agentName, sessionId);
  }

  // The conversation itself is gone, so void its pending prompts under every
  // agent — unlike a cancelled turn, which is scoped to the one agent that was
  // running it. Two agents sharing a provider share its conversations, so an
  // agent-scoped cancel would leave a badge pointing at a deleted conversation.
  cancelInboxForSessionId(sessionId: string, resolvedAt: string): void {
    this.db.prepare("UPDATE inbox SET status = 'cancelled', resolved_at = ? WHERE session_id = ? AND status = 'pending'")
      .run(resolvedAt, sessionId);
  }

  // The agent died: its pending prompts can never be answered (the request it was
  // blocking on is gone), so they become expired records.
  expireInboxForAgent(agentName: string, resolvedAt: string): void {
    this.db.prepare("UPDATE inbox SET status = 'expired', resolved_at = ? WHERE agent_name = ? AND status = 'pending'")
      .run(resolvedAt, agentName);
  }

  // Called once at boot: a gateway restart kills every agent subprocess, so any
  // row left pending from the previous run is no longer answerable.
  expireAllPending(resolvedAt: string): void {
    this.db.prepare("UPDATE inbox SET status = 'expired', resolved_at = ? WHERE status = 'pending'").run(resolvedAt);
  }

  // List inbox items, newest first. Optionally filter by status and/or agent.
  inbox(opts: { status?: InboxStatus; agentName?: string; limit?: number } = {}): InboxItem[] {
    const where: string[] = [];
    const params: Array<string> = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.agentName) { where.push("agent_name = ?"); params.push(opts.agentName); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : "";
    const rows = this.db.prepare(
      `SELECT id, type, agent_name, session_id, req_id, seq, title, body_json, status, created_at, resolved_at, result_json
       FROM inbox ${clause} ORDER BY id DESC${limit}`,
    ).all(...params) as Parameters<typeof this.mapInbox>[0][];
    return rows.map((r) => this.mapInbox(r));
  }

  close(): void {
    this.db.close();
  }
}
