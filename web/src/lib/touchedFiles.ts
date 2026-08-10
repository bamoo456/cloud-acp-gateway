import type { ThreadItem } from "../types.ts";

// Files this conversation touched, read back out of the thread it already
// rendered. ACP tool calls carry `locations` (what the tool acted on) and diff
// content blocks carry a `path`, so the transcript already knows which files
// the agent wrote — no extra round-trip, and it works for a resumed history
// session exactly as it does for a live turn.
//
// It is deliberately a different list from git's: it includes files the agent
// only *read*, and files it changed and then reverted, neither of which shows
// up in `git status`. Between the two, "what did this conversation involve" and
// "what is dirty in the checkout" are both answerable.

export interface TouchedFile {
  path: string;  // absolute, or cwd-relative — the gateway resolves either
  label: string; // trailing segment, for the row
}

// Tool locations arrive as either a plain path or a file:// URI (the ACP field
// allows both, and claude-agent-acp uses both depending on the tool).
export function toLocalPath(loc: string): string | null {
  const raw = (loc || "").trim();
  if (!raw) return null;
  if (raw.startsWith("file://")) {
    try {
      // decodeURIComponent, because a path with a space arrives as %20 and the
      // panel would otherwise ask the gateway for a file that doesn't exist.
      return decodeURIComponent(new URL(raw).pathname) || null;
    } catch {
      return null;
    }
  }
  // Any other scheme is a remote resource, not something on this host to open.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  return raw;
}

function label(p: string): string {
  const segments = p.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || p;
}

export function touchedFiles(items: ThreadItem[]): TouchedFile[] {
  // Insertion-ordered map with delete-then-set on a repeat, so a file the agent
  // came back to late in the turn sorts with its *latest* mention rather than
  // being pinned to where it first appeared.
  const seen = new Map<string, TouchedFile>();
  const add = (raw: string | undefined) => {
    const p = raw ? toLocalPath(raw) : null;
    if (!p) return;
    seen.delete(p);
    seen.set(p, { path: p, label: label(p) });
  };
  for (const it of items) {
    if (it.kind !== "tool") continue;
    for (const loc of it.locations) add(loc);
    for (const c of it.content) if (c.type === "diff") add(c.path);
  }
  // Most recent first: the file the agent just wrote is the one being looked for.
  return [...seen.values()].reverse();
}
