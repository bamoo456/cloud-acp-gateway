import { postRecentFolder } from "./api.ts";

export interface RecentFolder { path: string; lastUsedAt: string; }

// Recent folders are a per-account browsing convenience. They now live on the
// gateway (shared across devices/IPs — like the pinned folders in lib/api.ts)
// instead of this browser's localStorage, so reconnecting from another device or
// source IP shows the same list. The gateway hydrates `cache` once on startup
// (hydrateRecentFolders, called from the store's bootstrap); reads stay synchronous
// off that cache and writes update it optimistically before POSTing to the gateway.
const MAX_RECENT_FOLDERS = 20;

function isRecentFolder(value: unknown): value is RecentFolder {
  const v = value as Partial<RecentFolder> | null;
  return !!v && typeof v.path === "string" && typeof v.lastUsedAt === "string";
}

function normalize(list: RecentFolder[]): RecentFolder[] {
  const seen = new Set<string>();
  return list
    .filter((it) => it.path && Number.isFinite(new Date(it.lastUsedAt).getTime()))
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
    .filter((it) => {
      if (seen.has(it.path)) return false;
      seen.add(it.path);
      return true;
    })
    .slice(0, MAX_RECENT_FOLDERS);
}

let cache: RecentFolder[] = [];

// Seed the in-memory cache from the gateway's GET /prefs payload on startup.
export function hydrateRecentFolders(list: unknown): RecentFolder[] {
  cache = Array.isArray(list) ? normalize(list.filter(isRecentFolder)) : [];
  return cache;
}

export function readRecentFolders(): RecentFolder[] {
  return cache;
}

export function touchRecentFolder(path: string, lastUsedAt: string = new Date().toISOString()): RecentFolder[] {
  cache = normalize([{ path, lastUsedAt }, ...cache.filter((it) => it.path !== path)]);
  void postRecentFolder(path, lastUsedAt);
  return cache;
}
