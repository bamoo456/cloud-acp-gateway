import { postRecentSession } from "./api.ts";

export interface RecentSession {
  agentName: string;
  cwd: string;
  sessionId: string;
  title: string;
  lastActiveAt: string;
}

// Recent sessions live on the gateway (shared across devices/IPs) instead of this
// browser's localStorage, so the same account sees one conversation history from
// every device — like SSHing into one machine. The gateway hydrates `cache` once
// on startup (hydrateRecentSessions, from the store's bootstrap); reads stay sync
// and touchRecentSession updates the cache optimistically before POSTing.
const MAX_RECENT_SESSIONS = 50;

function keyOf(s: Pick<RecentSession, "agentName" | "cwd" | "sessionId">) {
  return `${s.agentName}\n${s.cwd}\n${s.sessionId}`;
}

function isRecentSession(value: unknown): value is RecentSession {
  const v = value as Partial<RecentSession> | null;
  return !!v &&
    typeof v.agentName === "string" &&
    typeof v.cwd === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.title === "string" &&
    typeof v.lastActiveAt === "string";
}

function normalize(list: RecentSession[]): RecentSession[] {
  const seen = new Set<string>();
  return list
    .filter((it) => Number.isFinite(new Date(it.lastActiveAt).getTime()))
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .filter((it) => {
      const key = keyOf(it);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RECENT_SESSIONS);
}

let cache: RecentSession[] = [];

// Seed the in-memory cache from the gateway's GET /prefs payload on startup.
export function hydrateRecentSessions(list: unknown): RecentSession[] {
  cache = Array.isArray(list) ? normalize(list.filter(isRecentSession)) : [];
  return cache;
}

export function readRecentSessions(): RecentSession[] {
  return cache;
}

// Drop a deleted conversation from the cache. Matches on the session id alone,
// not keyOf: one conversation can be cached under several spellings of its folder
// (raw vs realpath'd cwd) and under several agent names (two agents can share a
// provider and its transcripts), and the gateway just deleted all of them. No
// POST — the gateway's DELETE already removed the rows; this only keeps the
// current page from showing a conversation that no longer exists.
export function removeRecentSession(sessionId: string): RecentSession[] {
  cache = cache.filter((it) => it.sessionId !== sessionId);
  return cache;
}

// Apply a rename to every cached row for a conversation. Matched on the session
// id alone, exactly like removeRecentSession and for the same reason: one
// conversation can sit in the cache under several spellings of its folder and
// under several agent names, and touchRecentSession only ever rewrites the one
// row it is given. The rows this catches are the ones that would otherwise keep
// rendering the old name in Recent. No POST — the gateway rewrites its own rows
// when it persists the rename.
export function renameRecentSession(sessionId: string, title: string): RecentSession[] {
  const t = title.trim();
  if (!t) return cache; // cleared rename: the derived title is the gateway's to supply
  cache = cache.map((it) => (it.sessionId === sessionId ? { ...it, title: t } : it));
  return cache;
}

// "Untitled" is the placeholder a client falls back to, not a name a conversation
// answers to — so it never counts as a recorded title.
const recordedTitle = (sessionId: string) =>
  cache.find((it) => it.sessionId === sessionId && it.title && it.title !== "Untitled")?.title ?? null;

// `seedTitle` marks a title this client DERIVED (the transcript's first user
// message, or the "Untitled" fallback) rather than one the user chose. A derived
// title may only name a conversation with no title on record: this runs on every
// frame of a running turn, and a session whose in-memory copy carries no title —
// a deep-link join, an agent restart, another device — would otherwise re-derive
// the first message and overwrite a rename mid-turn. Matched on the session id
// alone, like renameRecentSession: the recorded title belongs to the
// conversation, not to one spelling of its folder. The gateway enforces the same
// rule on the row it stores, so the two can't disagree.
export function touchRecentSession(session: RecentSession, seedTitle = false): RecentSession[] {
  const title = (seedTitle ? recordedTitle(session.sessionId) : null) ?? (session.title.trim() || "Untitled");
  const entry: RecentSession = { ...session, title };
  cache = normalize([entry, ...cache.filter((it) => keyOf(it) !== keyOf(session))]);
  void postRecentSession(entry, seedTitle);
  return cache;
}
