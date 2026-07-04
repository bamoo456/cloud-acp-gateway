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

export function touchRecentSession(session: RecentSession): RecentSession[] {
  const title = session.title.trim() || "Untitled";
  const entry: RecentSession = { ...session, title };
  cache = normalize([entry, ...cache.filter((it) => keyOf(it) !== keyOf(session))]);
  void postRecentSession(entry);
  return cache;
}
