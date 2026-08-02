// Pure search primitives: no filesystem, no gateway state. Everything here is
// deterministic on its inputs so the I/O stages can be tested separately.

import type { ViewMessage } from "./gateway.ts"; // type-only: erased, so no import cycle

export const MIN_QUERY_LEN = 2;

export type ParsedQuery = {
  terms: string[];
  // The term stage B scans raw file bytes for, or null when no term is usable
  // as a probe (see probeFor). A null probe means "scan nothing away".
  probe: string | null;
};

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Transcripts are JSONL, so a term containing a character JSON escapes (`"`,
// `\`, control chars) does not appear literally in the file bytes. Probing on
// one would drop sessions that really do match, so such terms are never chosen.
function probeable(term: string): boolean {
  if (term.includes('"') || term.includes("\\")) return false;
  for (const ch of term) if (ch.charCodeAt(0) < 32) return false;
  return true;
}

function probeFor(terms: string[]): string | null {
  let best: string | null = null;
  for (const t of terms) {
    if (!probeable(t)) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

export function parseQuery(raw: string): ParsedQuery | null {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_LEN) return null;
  const terms = trimmed.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return { terms, probe: probeFor(terms) };
}

export const SNIPPET_RADIUS = 120;

export type SnippetResult = {
  snippet: string;
  // Half-open [start, end) ranges into `snippet` for the client to highlight.
  // The server emits ranges, never markup, so the client escapes its own output.
  offsets: Array<[number, number]>;
};

export function buildSnippet(text: string, terms: string[]): SnippetResult | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const hay = flat.toLowerCase();
  const firsts = terms.map((t) => hay.indexOf(t));
  if (firsts.some((i) => i < 0)) return null;

  const anchor = Math.min(...firsts);
  const start = Math.max(0, anchor - SNIPPET_RADIUS);
  const end = Math.min(flat.length, anchor + SNIPPET_RADIUS);
  const lead = start > 0 ? "…" : "";
  const body = flat.slice(start, end);
  const snippet = lead + body + (end < flat.length ? "…" : "");

  const low = body.toLowerCase();
  const offsets: Array<[number, number]> = [];
  for (const t of terms) {
    for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + t.length)) {
      offsets.push([i + lead.length, i + lead.length + t.length]);
    }
  }
  offsets.sort((a, b) => a[0] - b[0]);
  return { snippet, offsets };
}

export const MAX_HITS_PER_SESSION = 3;

export type SearchHit = {
  index: number; // index into the session's ViewMessage[] — the same absolute
                 // index /history/messages pages by, so a hit deep-links directly
  role: "user" | "assistant";
  snippet: string;
  offsets: Array<[number, number]>;
};

// Only `text` blocks are searchable: tool arguments and tool output dominate a
// transcript by volume and would drown real hits (the same reason
// toolResultText caps them for display).
function searchableText(msg: ViewMessage): string {
  return msg.blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

export function findHits(
  msgs: ViewMessage[],
  query: ParsedQuery,
  opts?: { role?: "user" | "assistant"; max?: number },
): { hits: SearchHit[]; hitCount: number } {
  const max = opts?.max ?? MAX_HITS_PER_SESSION;
  const hits: SearchHit[] = [];
  let hitCount = 0;
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (opts?.role && msg.role !== opts.role) continue;
    const text = searchableText(msg);
    if (!text) continue;
    const hay = text.toLowerCase();
    if (!query.terms.every((t) => hay.includes(t))) continue;
    hitCount++;
    if (hits.length >= max) continue;
    const snip = buildSnippet(text, query.terms);
    if (snip) hits.push({ index: i, role: msg.role, snippet: snip.snippet, offsets: snip.offsets });
  }
  return { hits, hitCount };
}

// Where a truncated scan stopped. Opaque to clients: it is a scan position, not
// a date filter, and must not be confused for one. Recency travels as epoch ms
// rather than an ISO string so comparison never depends on two timestamps
// sharing a text format.
export type SearchCursor = { recencyMs: number; sessionId: string };

export function encodeCursor(c: SearchCursor): string {
  return Buffer.from(c.recencyMs + "|" + c.sessionId, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): SearchCursor | null {
  let decoded = "";
  try { decoded = Buffer.from(raw, "base64url").toString("utf8"); } catch { return null; }
  const bar = decoded.indexOf("|");
  if (bar <= 0 || bar === decoded.length - 1) return null;
  const recencyMs = Number(decoded.slice(0, bar));
  if (!Number.isFinite(recencyMs)) return null;
  return { recencyMs, sessionId: decoded.slice(bar + 1) };
}

// Candidates are ordered by (recencyMs desc, sessionId desc). Resuming keeps
// only what sorts strictly after the cursor. The sessionId tiebreak is
// load-bearing: sessions sharing a recency — including every session that fell
// back to the same bulk-touched mtime — would otherwise be re-scanned or skipped.
export function afterCursor(cur: SearchCursor, c: { recencyMs: number; sessionId: string }): boolean {
  if (c.recencyMs !== cur.recencyMs) return c.recencyMs < cur.recencyMs;
  return c.sessionId < cur.sessionId;
}

export const DEFAULT_SINCE_DAYS = 14;
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;
const DAY_MS = 86400000;

export type SearchQuery = {
  query: ParsedQuery;
  sinceMs: number | null;  // null = unbounded (all=1)
  untilMs: number | null;
  agents: string[] | null; // null = every configured agent
  role: "user" | "assistant" | null;
  limit: number;
  cursor: SearchCursor | null;
};

// ISO 8601 or epoch ms. An unparseable value degrades to "no bound" rather than
// inventing one — the same all-or-nothing rule historyPageParams uses.
function instantMs(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function searchQueryParams(q: URLSearchParams, nowMs: number): SearchQuery | null {
  const query = parseQuery(q.get("q") ?? "");
  if (!query) return null;
  const agents = q.getAll("agent").filter((a) => a.length > 0);
  const role = q.get("role");
  const cursorRaw = q.get("cursor");
  const rawLimit = parseInt(q.get("limit") ?? String(DEFAULT_SEARCH_LIMIT), 10);
  // A legitimate 0 must clamp to 1, not fall back to the default — so NaN is
  // tested explicitly rather than leaning on falsiness.
  const limit = Number.isNaN(rawLimit) ? DEFAULT_SEARCH_LIMIT : rawLimit;
  return {
    query,
    sinceMs: q.get("all") === "1" ? null : (instantMs(q.get("since")) ?? nowMs - DEFAULT_SINCE_DAYS * DAY_MS),
    untilMs: instantMs(q.get("until")),
    agents: agents.length > 0 ? agents : null,
    role: role === "user" || role === "assistant" ? role : null,
    limit: Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT),
    cursor: cursorRaw ? decodeCursor(cursorRaw) : null,
  };
}
