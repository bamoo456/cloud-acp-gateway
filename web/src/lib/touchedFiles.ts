import type { ThreadItem } from "../types.ts";

// Files this conversation touched, read back out of the thread it already
// rendered. ACP tool calls carry `locations` (what the tool acted on) and diff
// content blocks carry a `path`, so the thread already knows which files the
// agent wrote — no extra round-trip.
//
// A resumed conversation gets the same list only because the gateway recovers
// both fields from the transcript (see CLAUDE_TOOL_KINDS in gateway.ts). That
// recovery is possible for Claude, whose transcript records each tool's input;
// codex and opencode record only a shell command, so their replayed
// conversations legitimately produce nothing here.
//
// It is deliberately a different list from git's: it includes files the agent
// only *read*, and files it changed and then reverted, neither of which shows
// up in `git status`. Between the two, "what did this conversation involve" and
// "what is dirty in the checkout" are both answerable.
//
// The list splits by what the tool DID to the file, which is the split the panel
// shows as Outputs and Context. It is a claim about the tool call, not about the
// file: a file that was read and later edited is an output, because by the end
// of the turn the agent had written it.
//
// One thing this cannot see: a file written through a shell. `Bash`/`exec` names
// a command, never a path, so anything an agent redirects, moves, or generates
// from a script is invisible here — which is exactly the gap the Changes tab
// (git's own view) exists to cover.

export type TouchedRole = "output" | "context";

export interface TouchedFile {
  path: string;  // absolute, or cwd-relative — the gateway resolves either
  label: string; // trailing segment, for the row
  role: TouchedRole;
}

// ACP tool kinds that mean the agent changed the file rather than consulted it.
// Everything else — read, search, fetch, execute, think, other — is context.
const WRITING_KINDS = new Set(["edit", "delete", "move"]);

// Shared with the thread, which shows a produced file as a card and a consulted
// one as a plain path — the same question, asked one tool call at a time.
export function isWritingKind(toolKind: string): boolean {
  return WRITING_KINDS.has(toolKind);
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
  const add = (raw: string | undefined, role: TouchedRole) => {
    const p = raw ? toLocalPath(raw) : null;
    if (!p) return;
    // A write anywhere in the conversation wins: re-reading a file after
    // editing it does not turn it back into something the agent merely
    // consulted.
    const wasOutput = seen.get(p)?.role === "output";
    seen.delete(p);
    seen.set(p, { path: p, label: label(p), role: wasOutput ? "output" : role });
  };
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const role: TouchedRole = isWritingKind(it.toolKind) ? "output" : "context";
    for (const loc of it.locations) add(loc, role);
    // A diff block is the tool showing its own before/after, so the file was
    // written whatever the kind field says.
    for (const c of it.content) if (c.type === "diff") add(c.path, "output");
  }
  // Most recent first: the file the agent just wrote is the one being looked for.
  return [...seen.values()].reverse();
}
