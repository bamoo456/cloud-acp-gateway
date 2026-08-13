// Review drafts: the comments someone has written against a diff but not yet
// sent to the agent.
//
// They live in the checkout being reviewed — `<repo root>/.acp-review/` — rather
// than in the browser or in the gateway's own state directory, for three
// reasons. A draft is *about* this repo, so it belongs with it. The panel is
// driven from a phone, where a backgrounded tab is discarded without warning and
// localStorage would be the thing that lost the review. And the gateway is
// reached from more than one device: a review started on a laptop should still
// be there on the phone, which per-origin browser storage cannot do.
//
// Repo root, not the conversation's cwd: /workspace/changes runs `git status` at
// the root, so a review's scope is the whole checkout, and a draft started from
// a session opened on a subdirectory has to be findable from the root. A folder
// that is not a checkout gets no persistence at all — Review mode has nothing to
// show there (no commits, no branch, no diff), so there is nothing to persist.
//
// This is the only thing in the workspace surface that writes. It writes exactly
// one directory, whose name is derived server-side from the repo root; the
// client names a folder and a scope, never a path.
import fs from "node:fs";
import path from "node:path";
import type { RevSpec } from "./workspace.ts";

// Hidden, and self-ignoring (see ensureDir): a review draft must not appear in
// the very list of changed files it is commenting on.
export const REVIEW_DIR = ".acp-review";
const DRAFTS_FILE = "drafts.json";

// One review's worth of comments. Past this it is not a review, it is a rewrite
// — and the whole draft becomes a prompt, which has its own budget.
export const MAX_COMMENTS = 200;
// One comment. Long enough for a paragraph of reasoning with a code suggestion
// in it, short enough that 200 of them stay a sendable message.
export const MAX_COMMENT_BYTES = 8 * 1024;
// The quoted diff line an anchor carries. Generated files have very long lines;
// the comment is about the line, not a copy of it.
export const MAX_CODE_BYTES = 2 * 1024;
export const MAX_PATH_BYTES = 1024;
// The whole file. A browser writing into somebody's checkout gets a ceiling that
// does not depend on the per-comment ones being right.
export const MAX_DRAFTS_BYTES = 1024 * 1024;
// A draft nobody has touched in this long is not resumed, it is stumbled over.
// Ignored on read and dropped on the next write, so an abandoned review does not
// resurface months later attached to a branch that has moved on.
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReviewComment {
  // Repo-root-relative POSIX path, as the changed-file list names it.
  path: string;
  // Which side of the diff the line is on. A comment on a deleted line is about
  // what was removed, and the two numbering schemes are not interchangeable.
  side: "new" | "old";
  line: number;
  endLine?: number;  // multi-line anchor; absent means a single line
  // The diff line(s) as they read when the comment was written. This is what
  // makes a persisted draft honest: the file moves on, and quoting the code the
  // comment was actually about beats pointing at a line number that now means
  // something else.
  code: string;
  body: string;
  id?: string;       // client-side identity, preserved verbatim for React keys
}

export interface ReviewDraft {
  updatedAt: string;
  comments: ReviewComment[];
}

interface DraftsFile {
  version: 1;
  scopes: Record<string, ReviewDraft>;
}

// Which diff a draft belongs to. The client sends the same rev/base it asked for
// the diff with, and the key is derived here so a stored draft cannot be made to
// name something the panel would never ask for.
export function reviewScopeKey(spec: RevSpec | null): string {
  if (!spec) return "working";
  return spec.commit ? "commit:" + spec.commit : "branch:" + spec.base;
}

// The draft directory for a repo, created on demand, or null when it cannot be
// used. Null is never fatal: comments live in memory regardless, and a read-only
// checkout should lose the persistence rather than the feature.
function ensureDir(repoRoot: string): string | null {
  const dir = path.join(repoRoot, REVIEW_DIR);
  // lstat, not stat: a checkout can contain `.acp-review -> /somewhere/else`,
  // and following that would redirect this write out of the repo entirely. The
  // same reasoning as git-exec.ts refusing to honour a repo-local fsmonitor
  // command — the contents of a checkout are not trusted input.
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return null;
    return dir;
  } catch { /* not there yet — create it below */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A directory whose every entry is ignored is itself absent from
    // `git status`, even with --untracked-files=all. So the draft never shows up
    // in the list of changes it is commenting on, and nobody has to remember to
    // add it to the repo's own .gitignore.
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
    return dir;
  } catch {
    return null;
  }
}

// Read-modify-write is synchronous on purpose. Two browser tabs commenting on
// two scopes of the same repo would otherwise interleave at an await and drop
// one of the scopes; node's single thread makes the whole sequence atomic
// without a lock to get wrong. The file is capped at 1MB, so the block is short.
function readFileDrafts(dir: string): DraftsFile {
  const file = path.join(dir, DRAFTS_FILE);
  try {
    // As above: a symlinked drafts.json would make this read something else.
    // The write is safe by construction (rename replaces the link rather than
    // following it), but the read would happily hand its contents to the panel.
    if (!fs.lstatSync(file).isFile()) return { version: 1, scopes: {} };
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > MAX_DRAFTS_BYTES) return { version: 1, scopes: {} };
    const parsed = JSON.parse(raw) as DraftsFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.scopes !== "object") {
      return { version: 1, scopes: {} };
    }
    return { version: 1, scopes: parsed.scopes ?? {} };
  } catch {
    // Missing, unreadable, or corrupt. An unparseable file is treated as no
    // drafts rather than as an error: the next write replaces it, which is a
    // better outcome than a panel that refuses to work until someone deletes it.
    return { version: 1, scopes: {} };
  }
}

function fresh(draft: ReviewDraft, now: number): boolean {
  const at = Date.parse(draft.updatedAt);
  return Number.isFinite(at) && now - at < DRAFT_TTL_MS;
}

// Every live draft in the repo, keyed by scope. The panel asks for one scope at
// a time but wants the counts for all of them — that is what puts the badge on
// the Review tab before you have opened anything.
export function readDrafts(repoRoot: string, now = Date.now()): Record<string, ReviewDraft> {
  const dir = path.join(repoRoot, REVIEW_DIR);
  let exists = false;
  try { exists = fs.lstatSync(dir).isDirectory(); } catch { /* no drafts yet */ }
  if (!exists) return {};
  const out: Record<string, ReviewDraft> = {};
  for (const [key, draft] of Object.entries(readFileDrafts(dir).scopes)) {
    if (!draft || !Array.isArray(draft.comments) || draft.comments.length === 0) continue;
    if (!fresh(draft, now)) continue;
    out[key] = draft;
  }
  return out;
}

export function readDraft(repoRoot: string, scope: string, now = Date.now()): ReviewComment[] {
  return readDrafts(repoRoot, now)[scope]?.comments ?? [];
}

// Replace one scope's comments. An empty list deletes the scope rather than
// storing an empty one — "I deleted my last comment" and "I never had one" are
// the same state, and only one of them should survive a reload.
//
// Returns false when the draft could not be stored (unwritable checkout, a
// hostile `.acp-review`, a full disk). The caller reports that once; it does not
// stop anyone reviewing.
export function writeDraft(
  repoRoot: string, scope: string, comments: ReviewComment[], now = Date.now(),
): boolean {
  const dir = ensureDir(repoRoot);
  if (!dir) return false;
  const drafts = readFileDrafts(dir);
  // Prune while we are here: stale scopes were already invisible to readDrafts,
  // and this is the only moment the file is open for writing anyway.
  for (const [key, draft] of Object.entries(drafts.scopes)) {
    if (!draft || !fresh(draft, now)) delete drafts.scopes[key];
  }
  if (comments.length === 0) delete drafts.scopes[scope];
  else drafts.scopes[scope] = { updatedAt: new Date(now).toISOString(), comments };

  const body = JSON.stringify(drafts, null, 2);
  if (Buffer.byteLength(body) > MAX_DRAFTS_BYTES) return false;
  // tmp + rename, the same idiom ledger.ts uses to rewrite its own file: a
  // gateway killed mid-write must not leave a half-written draft where a whole
  // one was. rename also replaces a symlink rather than writing through it.
  const file = path.join(dir, DRAFTS_FILE);
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing left to clean up */ }
    return false;
  }
}

// What the client may store. This is browser-supplied data on its way to a file
// in someone's checkout and then into a prompt, so it is checked field by field
// rather than trusted to be the shape the panel sends. Returns null on the first
// thing that is wrong — the caller answers 400, and a malformed request is a bug
// in the client rather than something to partially honour.
export function parseComments(input: unknown): ReviewComment[] | null {
  if (!Array.isArray(input) || input.length > MAX_COMMENTS) return null;
  const out: ReviewComment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    const filePath = c.path;
    const side = c.side;
    const line = c.line;
    const code = c.code ?? "";
    const body = c.body;
    if (typeof filePath !== "string" || !filePath || Buffer.byteLength(filePath) > MAX_PATH_BYTES) return null;
    if (side !== "new" && side !== "old") return null;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
    if (typeof code !== "string" || Buffer.byteLength(code) > MAX_CODE_BYTES) return null;
    if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > MAX_COMMENT_BYTES) return null;
    const endLine = c.endLine;
    if (endLine !== undefined && (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < line)) return null;
    const id = c.id;
    if (id !== undefined && (typeof id !== "string" || id.length > 64)) return null;
    out.push({ path: filePath, side, line, ...(endLine !== undefined ? { endLine } : {}), code, body, ...(id !== undefined ? { id } : {}) });
  }
  return out;
}
