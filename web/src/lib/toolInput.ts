import type { SessionUpdate } from "../types.ts";

// What the ACP adapter left on the floor.
//
// claude-agent-acp maps Claude's tools by hand: `Write` and `Edit` get
// `kind: "edit"` plus `locations`, `Read` gets `kind: "read"`, and everything it
// doesn't name falls through to `kind: "other"` with no locations at all.
// `NotebookEdit` and `MultiEdit` land in that default — so a live turn that
// rewrites a notebook shows no Outputs row, while the SAME conversation grows
// one after a resume, because the gateway's transcript path does map them (see
// CLAUDE_TOOL_KINDS in gateway.ts). The panel's answer to "what did this
// conversation write" changed depending on how you arrived at it.
//
// Both facts are still on the wire. Every tool_call carries `rawInput` (the
// tool's own arguments) and `_meta.claudeCode.toolName`, and the gateway relays
// notifications verbatim, so nothing here needs the server's help — this is the
// live half of a recovery the replay half already does.
//
// Deliberately keyed by tool NAME, and deliberately the same names the gateway
// knows. A tool this map has never heard of — an MCP server's own writer, say —
// keeps whatever the adapter said about it: a `path` argument does not prove the
// tool wrote to that path, and guessing would put files in Outputs the agent
// only ever read.

// Mirrors CLAUDE_TOOL_KINDS in gateway.ts, which does this for transcripts.
// Two copies rather than a shared module: the gateway is CJS bundled for node
// and this is the browser bundle, with no import path between them. Adding a
// tool means adding it in both, which is why they name each other.
const TOOL_KINDS: Record<string, string> = {
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Read: "read", NotebookRead: "read",
  Glob: "search", Grep: "search", WebSearch: "search",
  Bash: "execute", BashOutput: "execute", KillShell: "execute",
  WebFetch: "fetch",
  Task: "think", TodoWrite: "think",
};

// The input keys that name ONE file. The gateway's transcript copy also reads a
// bare `path`, which it can afford to: there it is reconstructing a whole
// conversation and a stray directory row is the worst case. Here a location
// becomes a panel row that opens a file viewer, and `path` on Claude's tools is
// a *directory* (`Glob`, `Grep`) — a row that 404s when clicked is worse than no
// row. Both those tools already get their locations from the adapter anyway.
const TOOL_PATH_KEYS = ["file_path", "notebook_path"];

export interface RecoveredToolFacts {
  // Each is set only when there is something to correct, so a caller can treat
  // "absent" as "the adapter's own value stands".
  kind?: string;
  locations?: string[];
}

function toolNameOf(up: SessionUpdate): string {
  const name = up._meta?.claudeCode?.toolName;
  return typeof name === "string" ? name : "";
}

function pathsFrom(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return [];
  const rec = rawInput as Record<string, unknown>;
  const out: string[] = [];
  for (const key of TOOL_PATH_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function recoverToolFacts(up: SessionUpdate): RecoveredToolFacts {
  const kind = TOOL_KINDS[toolNameOf(up)];
  if (!kind) return {};
  const out: RecoveredToolFacts = {};
  // Only when the adapter said nothing useful. For the tools it does map it
  // knows more than this table does (a Read's line offset, a Glob's search
  // root), and "other" is the only value that means "I didn't recognise this".
  if (!up.kind || up.kind === "other") out.kind = kind;
  if (!up.locations?.length) {
    const locations = pathsFrom(up.rawInput);
    if (locations.length) out.locations = locations;
  }
  return out;
}
