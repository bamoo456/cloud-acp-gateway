// Review drafts: the comments someone has written against a diff but not yet
// sent to the agent — what one may contain, and the `.acp-review/` file they
// used to live in.
//
// Drafts now live in the gateway's own database (db.ts's review_drafts), beside
// the discussions and reviewed-file records that a checkout never held. Same
// reasons the file was preferred to the browser — a phone discards a
// backgrounded tab, and one account drives the gateway from several devices —
// plus the one the file could not answer: a discussion has to outlive the
// worktree it was written in, and a worktree's own files do not.
//
// What is left here is the validation (the shapes a browser may store) and the
// reader that imports an existing `.acp-review/drafts.json` once, so nobody
// upgrading loses a review in progress. The file functions still write, because
// the import removes the scope it imported — and only after the row is safely
// stored.
//
// Repo root, not the conversation's cwd: /workspace/changes runs `git status` at
// the root, so a review's scope is the whole checkout, and a draft started from
// a session opened on a subdirectory has to be findable from the root.
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

// Where a comment or a discussion is attached. Recorded exactly as displayed and
// never recomputed — see db.ts's discussions table.
export interface ReviewAnchor {
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
}

export interface ReviewComment extends ReviewAnchor {
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
    const anchor = parseAnchor(raw);
    if (!anchor) return null;
    const c = raw as Record<string, unknown>;
    const body = c.body;
    if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > MAX_COMMENT_BYTES) return null;
    const id = c.id;
    if (id !== undefined && (typeof id !== "string" || id.length > 64)) return null;
    out.push({ ...anchor, body, ...(id !== undefined ? { id } : {}) });
  }
  return out;
}

// The location half of a comment, checked on its own because a discussion
// carries the same anchor without the draft's body/id rules.
export function parseAnchor(raw: unknown): ReviewAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const filePath = c.path;
  const side = c.side;
  const line = c.line;
  const code = c.code ?? "";
  if (typeof filePath !== "string" || !validRepoPath(filePath)) return null;
  if (side !== "new" && side !== "old") return null;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  if (typeof code !== "string" || Buffer.byteLength(code) > MAX_CODE_BYTES) return null;
  const endLine = c.endLine;
  if (endLine !== undefined && (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < line)) return null;
  return { path: filePath, side, line, ...(endLine !== undefined ? { endLine } : {}), code };
}

// A repo-root-relative POSIX path, the way the changed-file list spells one.
// The traversal check is not cosmetic: a stored path is later joined onto the
// repo root and handed to `git diff`, so `../../etc/passwd` would be a read the
// preview-root filter never got asked about.
export function validRepoPath(p: string): boolean {
  if (!p || Buffer.byteLength(p) > MAX_PATH_BYTES) return false;
  if (path.isAbsolute(p) || p.includes("\\") || p.includes("\0")) return false;
  return !p.split("/").includes("..");
}
