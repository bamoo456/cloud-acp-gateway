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
 * Uses better-sqlite3 rather than Node's built-in node:sqlite: that builtin
 * only exists on Node 22.5+, while this branch targets Node 20. better-sqlite3
 * is a native addon, so it is marked external in the esbuild bundle and
 * installed from node_modules at runtime (`npm install --omit=dev`). Its API
 * is synchronous, matching the rest of the gateway's file I/O (the ledger).
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
import Database from "better-sqlite3";

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
  private db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    // WAL keeps reads from blocking the occasional write; meaningless for :memory:.
    if (file !== ":memory:") this.db.pragma("journal_mode = WAL");
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
      PRIMARY KEY (agent_name, cwd, session_id)
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

  // Upsert one session's recency, then trim to the newest MAX_RECENT_SESSIONS.
  touchRecentSession(s: RecentSession): RecentSession[] {
    this.db
      .prepare(`INSERT INTO recent_sessions (agent_name, cwd, session_id, title, last_active_at)
        VALUES (@agentName, @cwd, @sessionId, @title, @lastActiveAt)
        ON CONFLICT(agent_name, cwd, session_id)
        DO UPDATE SET title = excluded.title, last_active_at = excluded.last_active_at`)
      .run(s);
    this.db.prepare(`DELETE FROM recent_sessions WHERE rowid NOT IN (
      SELECT rowid FROM recent_sessions ORDER BY last_active_at DESC LIMIT ${MAX_RECENT_SESSIONS}
    )`).run();
    return this.recentSessions();
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
