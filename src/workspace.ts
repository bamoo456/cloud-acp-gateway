// Workspace file preview: what the agent actually did to the project, readable
// from the browser.
//
// The gateway already relays an agent's *narration* of its work (tool cards,
// inline diffs it chose to emit). What it could not do is answer "show me the
// file" — the produced screenshot, the rewritten module, the full diff of a
// change the agent summarised in one line. The agent runs on this host, so the
// files are right there; this module is the read-only window onto them.
//
// Seven reads, all bounded and all scoped to ACPG_FS_ROOT by the caller:
//   - changes(): git's view of what is dirty in the project (status + numstat)
//   - fileDiff(): one file's unified diff, including untracked files
//   - preview():  one file's bytes as text, image metadata, or "binary"
//   - tree():     one directory's entries, for browsing the project itself
//   - find():     filenames matching a query, anywhere under the project
//   - outputFolder(): everything in one folder the conversation wrote into, for
//                 the files git cannot see at all
//   - commits():  the checkout's recent history, for reviewing what was landed
//                 rather than only what is still uncommitted
//
// changes() and fileDiff() both take an optional RevSpec: absent, they describe
// the working tree (what the panel has always shown); given one, they describe a
// single commit or a branch against its base. It is the same screen either way —
// only the revision git is asked about differs.
//
// Almost read-only, and the exception is deliberately one function wide:
// writeText() replaces a single text file, and only when the caller can prove
// the file still holds what it last read. Nothing here stages, reverts, creates
// or deletes. The point of keeping the write surface this small is that a
// browser session that leaks cannot rewrite the checkout the agent is working
// in — it can, at worst, overwrite one file it had already been shown, and only
// if nothing has touched that file since. Its caller in src/gateway.ts narrows
// the reach further: writes resolve under the conversation's own cwd only,
// never through the preview roots the reads are allowed to reach.
// (Review drafts also get written, but never into the checkout's own files —
// see review.ts.)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, gitStdin, gitTokens } from "./git-exec.ts";
import { fileIndex } from "./file-index.ts";
import { parseFindQuery, matchPath, TopK, compareRanked, type RankedFile } from "./fuzzy.ts";

// The panel lists changed files; past a few hundred it stops being a list and
// starts being a scroll. Truncate and say so rather than shipping thousands.
export const MAX_CHANGED_FILES = 500;
// A diff past this is not read in a side panel — it's opened in an editor.
export const MAX_DIFF_BYTES = 512 * 1024;
// Text preview cap. Same reasoning; the client shows a "truncated" notice.
export const MAX_TEXT_BYTES = 512 * 1024;
// What one save may write. Deliberately well under the read cap: the editor
// this backs is for a flag in a config from a phone, not for moving a file's
// worth of text through a browser textarea.
export const MAX_WRITE_BYTES = 256 * 1024;
// Raw byte cap for the <img>/download route. Generous enough for screenshots
// and design assets, small enough that one request can't pin memory.
export const MAX_RAW_BYTES = 25 * 1024 * 1024;
// One directory's worth of rows. A generated folder can hold tens of thousands
// of entries; the tree says so rather than rendering them.
export const MAX_TREE_ENTRIES = 500;
// Filename matches per query. The box is a jump-to, not a report.
export const MAX_FIND_RESULTS = 200;
// Content search caps. Match lines are read from git in stream order, so the
// line cap is what bounds the work; the other three bound what the panel has to
// render — one file's 900 hits must not bury every other file, and a minified
// bundle's single line must not become the response.
export const MAX_GREP_LINES = 400;
export const MAX_GREP_FILES = 50;
export const MAX_GREP_PER_FILE = 10;
export const MAX_GREP_LINE_CHARS = 300;
// A one-character content search matches everything, so it is refused here as
// well as in the box — this one costs a git process, not a memory scan.
export const MIN_GREP_QUERY = 2;
// An output folder is listed WHOLE, so it is capped harder than the tree: it
// appears inside a list of files, not as something you navigated into, and a
// scratch directory holding thousands of frames must not become the panel.
export const MAX_OUTPUT_FILES = 200;
// How far down an output folder is walked. One level below the folder itself,
// because a generator that writes `mockup.html` next to `png/` and `svg/` is the
// ordinary shape and listing only the top level would show the page without the
// pictures. Deeper than that is a project, and Project mode browses those.
export const OUTPUT_FOLDER_MAX_DEPTH = 2;
// One screen of history. The list is "pick the commit you want to read", not a
// log viewer, and --shortstat below costs one tree diff per entry.
export const MAX_COMMITS = 50;
// A ref name is a path under .git plus a bit; anything near this length is not a
// revision anybody typed.
const MAX_REV_LENGTH = 255;

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

// Which revision the panel is looking at. Null — the ordinary case — is the
// working tree, exactly as it was before this existed.
//
//   { commit } — that commit's own change, i.e. against its first parent
//   { base }   — everything on HEAD since it diverged from `base`, which is what
//                a pull request is: `git diff base...HEAD`
// One of the two is set, never both and never neither — revSpecFrom in
// src/gateway.ts is the only thing that builds one from a request, and it
// refuses both cases. Two optional fields rather than a union of two shapes
// because a union of non-literal properties gives TypeScript nothing to
// discriminate on, so every read of it would need a cast to say what the
// runtime already guarantees.
export interface RevSpec { commit?: string; base?: string }

// A revision arrives from the browser and is handed to git as an argv element,
// so it is checked before it gets there. The leading "-" is the whole point:
// `--upload-pack=…` is a revision-shaped string that isn't one, and git cannot
// tell after the fact that we meant it as data.
//
// Everything else valid is deliberately allowed through — `origin/main`,
// `HEAD~3`, `v1.8.0^{commit}` — because git is the authority on what resolves,
// and a rejected-but-valid revision is a bug the user cannot work around. One
// git doesn't recognise exits non-zero, which every caller here already handles.
export function validRev(rev: string): boolean {
  return !!rev && rev.length <= MAX_REV_LENGTH && !rev.startsWith("-") && !/[\0\n]/.test(rev);
}

// The git subcommand + revision selecting `spec`'s change. Callers append the
// output flags, then `--` and any pathspec.
//
// --first-parent so a merge has a diff at all: `git show` renders a merge as a
// combined diff, and "what did merging this branch bring in" is the question
// somebody clicking a merge commit is asking. Harmless elsewhere — a
// single-parent commit has only a first parent.
function revArgs(spec: RevSpec): string[] {
  if (spec.commit) return ["show", "--format=", "--first-parent", spec.commit];
  // `HEAD...HEAD` for the spec revSpecFrom never builds — an empty diff, which
  // is the honest answer to "compare against nothing" and needs no branch of
  // error handling in three callers to say so.
  return ["diff", (spec.base || "HEAD") + "...HEAD"];
}

export interface CommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;        // ISO 8601, as git emits it
  subject: string;
  // Absent for a merge: `git log --shortstat` reports none for one, and
  // inventing a zero would read as "this merge changed nothing".
  files?: number;
  additions?: number;
  deletions?: number;
}

export interface ChangedFile {
  path: string;      // repo-root-relative POSIX path, for display
  abs: string;       // absolute path — how every other endpoint addresses the file
  status: ChangeStatus;
  staged: boolean;   // has an index-side change (X column), i.e. `git add`ed
  oldPath?: string;  // rename/copy origin, repo-relative
  additions?: number;
  deletions?: number;
  binary?: boolean;  // git reported "-" line counts
}

export interface ChangesResult {
  repo: string | null;   // absolute repo root, or null when cwd isn't a git checkout
  files: ChangedFile[];
  truncated: boolean;
  reason?: string;       // why `files` is empty: no git, not a repo, or the diff itself failed
}

export interface FileDiff {
  path: string;
  status: ChangeStatus;
  diff: string;
  binary: boolean;
  truncated: boolean;
}

export interface TreeEntry {
  name: string;
  abs: string;
  dir: boolean;
  size?: number;      // files only
  ignored?: boolean;  // git would not track it — dimmed, not hidden
  symlink?: boolean;  // shown, but never descended into by find()
  git?: boolean;      // folders only: a checkout of its own, as the folder picker marks them
}

export interface TreeResult {
  abs: string;             // the directory listed
  path: string;            // how to name it in the UI (cwd-relative, else absolute)
  entries: TreeEntry[];
  truncated: boolean;
}

export interface OutputFile {
  path: string;  // relative to the folder, POSIX — "png/04_s_ribbon.png"
  abs: string;
  size: number;
}

export interface OutputFolder {
  abs: string;
  files: OutputFile[];
  // Something was left out: the file cap was hit, or there is a level below the
  // walk's depth. The panel says so — a folder listing that quietly stops reads
  // as "that's all there is".
  truncated: boolean;
}

export interface FoundFile {
  path: string;  // relative to the search root, POSIX
  abs: string;
}

export interface FindResult {
  files: FoundFile[];
  truncated: boolean;   // more matches existed than were returned
  // True when the walk was git's own file list, which already excludes ignored
  // files. Without it the client can't explain why a visible-but-ignored file
  // in the tree isn't a search hit.
  fromGit: boolean;
  total: number;        // every match seen, including beyond the K kept
  pending?: boolean;    // untracked half not indexed yet (first query in a repo)
  limited?: boolean;    // the corpus itself was capped (walk depth/size, MAX_INDEX_PATHS)
}

export interface GrepMatch {
  line: number;  // 1-based, as git reports it
  text: string;
}

export interface GrepFile {
  path: string;  // relative to the search root, POSIX
  abs: string;
  matches: GrepMatch[];
  more: number;  // matches in this file beyond the ones listed
}

export interface GrepResult {
  files: GrepFile[];
  truncated: boolean;  // more match lines (or files) existed than were returned
  // False means nothing was searched — the folder is not a git checkout, or
  // git isn't there. Without it "no matches" would be indistinguishable from
  // "couldn't look".
  fromGit: boolean;
  total: number;       // match lines seen, including ones not listed
}

export type PreviewKind = "text" | "image" | "binary";

export interface FilePreview {
  path: string;        // repo/cwd-relative when we can, else absolute — display only
  abs: string;
  kind: PreviewKind;
  size: number;
  modifiedAt: string;
  mimeType?: string;   // set for `image`
  text?: string;       // set for `text`
  truncated?: boolean; // text was cut at MAX_TEXT_BYTES
  // sha256 of the file's bytes, and the precondition a write echoes back. Set
  // only for a text file this read could also SAVE — whole (a truncated read's
  // digest describes the head, and a token meaning "the file I saw" must not
  // stand for half of it) and inside the write cap. Editors key off its
  // absence, so it must not be issued for a file a save would refuse: an
  // enabled control that always fails is worse than a disabled one.
  hash?: string;
}

// Image types the raw route may serve with their real content-type, i.e. types a
// browser renders as a picture and nothing else.
//
// SVG is deliberately absent. It is XML that can carry <script>, and this route
// serves from the console's own origin — the origin holding the gateway
// credential injected into the SPA config. An agent that writes an .svg (or a
// repo that contains a hostile one) would otherwise get script execution in the
// console's origin for free. SVGs are still previewable: they fall through to
// the text branch and are shown as source, which is also the more useful view
// when you're checking what an agent generated.
const INLINE_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

export function inlineImageType(name: string): string | null {
  return INLINE_IMAGE_TYPES[path.extname(name).toLowerCase()] ?? null;
}

// Heuristic used everywhere a "can this be shown as text" decision is needed.
// A NUL byte is the classic tell (git uses the same one) and settles nearly
// every real case; the control-character ratio catches the rest without
// misreading UTF-8 text, whose continuation bytes are all >= 0x80.
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // Everything below 0x20 except tab / LF / CR / FF / ESC.
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) control++;
  }
  return n > 0 && control / n > 0.1;
}

// `git status --porcelain=v1 -z` output. NUL-separated records of "XY path",
// where a rename/copy (X in R/C) is followed by its origin path as its own
// record. -z is not a nicety: without it git quotes and escapes any path with a
// space or non-ASCII byte, and this panel's whole job is showing files an agent
// just wrote — which routinely have both.
export function parseStatusZ(out: string): Array<{ path: string; oldPath?: string; status: ChangeStatus; staged: boolean }> {
  const records = out.split("\0");
  const files: Array<{ path: string; oldPath?: string; status: ChangeStatus; staged: boolean }> = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // The final NUL leaves a trailing empty record; a record shorter than
    // "XY p" is malformed and skipped rather than read past its end.
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const filePath = rec.slice(3);
    let oldPath: string | undefined;
    // Rename/copy: git emits "R  new\0old". Consume the origin record so the
    // loop doesn't then read it as a status line of its own.
    if (x === "R" || x === "C") oldPath = records[++i];
    files.push({ path: filePath, oldPath, status: statusFromXY(x, y), staged: x !== " " && x !== "?" });
  }
  return files;
}

function statusFromXY(x: string, y: string): ChangeStatus {
  if (x === "?" || y === "?") return "untracked";
  if (x === "R" || x === "C") return "renamed";
  // Prefer the index column when it says something; a file both staged-added
  // and then edited in the worktree ("AM") is still, to a reader, an add.
  const code = x !== " " && x !== "U" ? x : y;
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  return "modified"; // M, T (typechange), U (conflicted) — all "it differs"
}

// `git diff --numstat -z`: "adds\tdels\tpath" per NUL record, except a
// rename/copy which emits "adds\tdels\t" and then the old and new paths as two
// further records. Binary files report "-" for both counts.
export function parseNumstatZ(out: string): Array<{ path: string; oldPath?: string; additions: number; deletions: number; binary: boolean }> {
  const records = out.split("\0");
  const rows: Array<{ path: string; oldPath?: string; additions: number; deletions: number; binary: boolean }> = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const parts = rec.split("\t");
    if (parts.length < 3) continue;
    const binary = parts[0] === "-" || parts[1] === "-";
    const additions = binary ? 0 : Number(parts[0]) || 0;
    const deletions = binary ? 0 : Number(parts[1]) || 0;
    let filePath = parts[2];
    let oldPath: string | undefined;
    // Empty path field ⇒ the rename form; the next two records are old, new.
    if (filePath === "") {
      oldPath = records[++i];
      filePath = records[++i] ?? "";
      if (!filePath) continue;
    }
    rows.push({ path: filePath, oldPath, additions, deletions, binary });
  }
  return rows;
}

// `git diff --name-status -z`: a status record then its path, except a
// rename/copy ("R100") which is followed by the old path and then the new one.
//
// Distinct from parseStatusZ, which reads `git status` porcelain — that has two
// columns (index and worktree) because it describes a dirty tree, and this has
// one because a commit has no unstaged half.
export function parseNameStatusZ(out: string): Array<{ path: string; oldPath?: string; status: ChangeStatus }> {
  const records = out.split("\0");
  const files: Array<{ path: string; oldPath?: string; status: ChangeStatus }> = [];
  for (let i = 0; i < records.length; i++) {
    const code = records[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = records[++i];
      const newPath = records[++i];
      if (!newPath) continue;
      files.push({ path: newPath, oldPath, status: "renamed" });
      continue;
    }
    const filePath = records[++i];
    if (!filePath) continue;
    files.push({ path: filePath, status: statusFromDiffLetter(letter) });
  }
  return files;
}

function statusFromDiffLetter(letter: string): ChangeStatus {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  return "modified"; // M, T (typechange), U (unmerged) — all "it differs"
}

// Absolute repo root for `cwd`, or null when it isn't inside a checkout (or git
// isn't installed). Everything else in this module funnels through it, so a
// non-repo folder degrades to an empty panel instead of an error.
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  const root = r.stdout.trim();
  if (!root) return null;
  // realpath so the root compares equal to paths resolved the same way
  // elsewhere (macOS /var vs /private/var is the everyday case).
  try { return fs.realpathSync(root); } catch { return root; }
}

// Everything git considers changed in `cwd`'s checkout, against HEAD, with line
// counts where git can give them. Untracked files are included (-uall): a file
// the agent just created is the single most likely thing you opened this panel
// to look at, and it is by definition untracked.
export async function changes(cwd: string): Promise<ChangesResult> {
  const root = await repoRoot(cwd);
  if (!root) {
    const probe = await git(cwd, ["--version"]);
    return { repo: null, files: [], truncated: false, reason: probe.failed ? "git-missing" : "not-a-repo" };
  }
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return { repo: root, files: [], truncated: false, reason: "status-failed" };

  // Line counts are a second call because status doesn't carry them. Best
  // effort: a repo with no commits has no HEAD to diff against, and the file
  // list is still worth showing without +/- numbers.
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const numstat = await git(root, ["diff", "--numstat", "-z", "--no-ext-diff", "-M", "HEAD"]);
  if (numstat.code === 0) {
    for (const row of parseNumstatZ(numstat.stdout)) {
      stats.set(row.path, { additions: row.additions, deletions: row.deletions, binary: row.binary });
    }
  }

  const parsed = parseStatusZ(status.stdout);
  // The full parse, before the MAX_CHANGED_FILES cut: the payload is capped for
  // display, but the search index wants every untracked path status found.
  fileIndex.noteStatus(root, parsed);
  const truncated = parsed.length > MAX_CHANGED_FILES;
  const files = parsed.slice(0, MAX_CHANGED_FILES).map((f): ChangedFile => ({
    path: f.path,
    abs: path.resolve(root, f.path),
    status: f.status,
    staged: f.staged,
    oldPath: f.oldPath,
    ...stats.get(f.path),
  }));
  // Most-recently-touched first: the panel is opened right after a turn, so the
  // file the agent just wrote should be the one at the top, not whatever sorts
  // first alphabetically. mtime is cheap here (the files are already hot) and
  // missing/racing entries just sort last rather than failing the request.
  const mtimes = new Map(files.map((f) => [f.abs, statMtime(f.abs)] as const));
  files.sort((a, b) => (mtimes.get(b.abs) ?? 0) - (mtimes.get(a.abs) ?? 0) || a.path.localeCompare(b.path));
  return { repo: root, files, truncated };
}

function statMtime(abs: string): number {
  try { return fs.statSync(abs).mtimeMs; } catch { return 0; }
}

// The files one commit changed, or the files a branch changed since it diverged
// from `base`. Same shape as changes() so the panel renders one list either way.
//
// Two git calls for the same reason changes() makes two: --name-status carries
// the status letter and no line counts, --numstat the reverse. Rows keep git's
// own order here rather than being sorted by mtime — a commit's file list has a
// meaning of its own, and half its files may not be on disk at all.
export async function revChanges(cwd: string, spec: RevSpec): Promise<ChangesResult> {
  const root = await repoRoot(cwd);
  if (!root) {
    const probe = await git(cwd, ["--version"]);
    return { repo: null, files: [], truncated: false, reason: probe.failed ? "git-missing" : "not-a-repo" };
  }
  const base = [...revArgs(spec), "--no-color", "--no-ext-diff", "-M", "-z"];
  const names = await git(root, [...base, "--name-status"]);
  // A revision that doesn't resolve is the everyday failure here: a base ref
  // that isn't fetched, a commit from a branch since deleted. Say which, rather
  // than rendering it as "this commit changed nothing".
  if (names.code !== 0) {
    if (names.failed) return { repo: root, files: [], truncated: false, reason: "git-missing" };
    // "no merge base" is a different problem with a different fix: the ref
    // resolved fine, the history is just too shallow (or grafted) to share an
    // ancestor with it. Deepening the fetch fixes that; re-fetching the ref
    // doesn't. git-exec pins LC_ALL=C, so this text is stable.
    const reason = /no merge base/.test(names.stderr) ? "no-merge-base" : "bad-revision";
    return { repo: root, files: [], truncated: false, reason };
  }
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const numstat = await git(root, [...base, "--numstat"]);
  if (numstat.code === 0) {
    for (const row of parseNumstatZ(numstat.stdout)) {
      stats.set(row.path, { additions: row.additions, deletions: row.deletions, binary: row.binary });
    }
  }
  const parsed = parseNameStatusZ(names.stdout);
  const truncated = parsed.length > MAX_CHANGED_FILES;
  const files = parsed.slice(0, MAX_CHANGED_FILES).map((f): ChangedFile => ({
    path: f.path,
    abs: path.resolve(root, f.path),
    status: f.status,
    // Nothing in a committed diff is "staged" — that word describes an index,
    // and this is history. False rather than absent so the field means the same
    // thing in both lists.
    staged: false,
    oldPath: f.oldPath,
    ...stats.get(f.path),
  }));
  return { repo: root, files, truncated };
}

// The checkout's recent history: enough to pick a commit to read, not a log
// viewer. First parents only would hide the work in a merged branch, so this is
// the full log — a merge and the commits it brought in are both listed, and
// opening either shows a diff (see revArgs).
export async function commits(cwd: string, limit = MAX_COMMITS): Promise<{
  repo: string | null; commits: CommitEntry[]; branch?: string; defaultBase?: string; reason?: string;
}> {
  const root = await repoRoot(cwd);
  if (!root) {
    const probe = await git(cwd, ["--version"]);
    return { repo: null, commits: [], reason: probe.failed ? "git-missing" : "not-a-repo" };
  }
  // Where a branch review compares against, and what to call the branch it is
  // reviewing. Both ride along with the commit list because Review mode fetches
  // it once on open and would otherwise need a route of its own to ask.
  const [branch, base] = await Promise.all([currentBranch(root), defaultBase(root)]);
  const n = Math.max(1, Math.min(limit, MAX_COMMITS));
  // The record separator leads each entry rather than terminating it, so that
  // splitting on it puts a commit's fields and its --shortstat line in the same
  // chunk. Terminating would attach each stat block to the *next* commit.
  // \x1e/\x1f because a subject can contain anything else, newlines included.
  const log = await git(root, [
    "log", "-n", String(n), "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--shortstat",
  ]);
  // No commits yet is not an error to report: an empty list says it already.
  if (log.code !== 0) return { repo: root, commits: [], branch, defaultBase: base, reason: "no-history" };
  return { repo: root, commits: parseCommitLog(log.stdout), branch, defaultBase: base };
}

// The checked-out branch, or undefined on a detached HEAD — where "this branch
// against its base" is not a question with an answer.
async function currentBranch(root: string): Promise<string | undefined> {
  const r = await git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

// What a branch review compares against by default. The remote's own default
// branch is the right answer when there is one — it is what a pull request would
// be opened against — and the local main/master is the fallback for a checkout
// with no remote (or one that has never fetched origin/HEAD).
//
// Undefined when none of them resolve, which the panel turns into "type a base"
// rather than into a diff against something it guessed.
async function defaultBase(root: string): Promise<string | undefined> {
  const remote = await git(root, ["rev-parse", "--abbrev-ref", "--verify", "--quiet", "origin/HEAD"]);
  const named = remote.stdout.trim();
  if (remote.code === 0 && named && named !== "origin/HEAD") return named;
  for (const candidate of ["main", "master"]) {
    const r = await git(root, ["rev-parse", "--verify", "--quiet", candidate]);
    if (r.code === 0) return candidate;
  }
  return undefined;
}

// Exported for its own test: the format above is chosen for parseability, so the
// parser is the only thing proving the choice worked.
export function parseCommitLog(out: string): CommitEntry[] {
  const entries: CommitEntry[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split("\n");
    const [sha, author, date, ...subject] = head.split("\x1f");
    // A subject cannot contain \x1f, so a short split is a malformed record
    // rather than a subject that ate a field.
    if (!sha || subject.length === 0) continue;
    const stat = parseShortstat(rest.join("\n"));
    entries.push({
      sha,
      shortSha: sha.slice(0, 7),
      author: author ?? "",
      date: date ?? "",
      subject: subject.join("\x1f"),
      ...stat,
    });
  }
  return entries;
}

// " 5 files changed, 75 insertions(+), 4 deletions(-)" — any of the three
// clauses can be absent (a commit that only added lines has no deletions
// clause), and a merge has no line at all.
function parseShortstat(text: string): { files?: number; additions?: number; deletions?: number } {
  const files = /(\d+) files? changed/.exec(text);
  if (!files) return {};
  const add = /(\d+) insertions?\(\+\)/.exec(text);
  const del = /(\d+) deletions?\(-\)/.exec(text);
  return {
    files: Number(files[1]),
    additions: add ? Number(add[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

// One file's unified diff. `abs` must already be resolved within FS_ROOT by the
// caller; `cwd` only supplies the repo context. With a `spec`, the diff is that
// commit's (or that branch's) change to the file rather than the working tree's.
export async function fileDiff(cwd: string, abs: string, spec?: RevSpec | null): Promise<FileDiff> {
  const root = await repoRoot(cwd);
  const rel = root ? toPosix(path.relative(root, abs)) : path.basename(abs);
  const exists = fs.existsSync(abs);

  // A committed diff answers about history, so none of the working-tree
  // reasoning below applies: whether the file is tracked *now*, or exists on
  // disk at all, says nothing about what the commit did to it. git's own diff
  // header carries the status, and a path git has nothing to say about comes
  // back empty — which is the truth for a file that commit didn't touch.
  if (spec && root) {
    const r = await git(root, [...revArgs(spec), "--no-color", "--no-ext-diff", "-M", "--", rel]);
    if (r.code !== 0) return { path: rel, status: "modified", diff: "", binary: false, truncated: false };
    return finishDiff(rel, statusFromDiffHeader(r.stdout), r.stdout);
  }

  // No repo at all: there is nothing to diff against, so the honest answer is
  // "the whole file is new" — which is what --no-index against /dev/null says,
  // and it keeps the client on a single rendering path.
  if (!root) {
    const whole = await git(path.dirname(abs), ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", devNull(), abs]);
    return finishDiff(rel, exists ? "untracked" : "deleted", whole.stdout);
  }

  const tracked = await git(root, ["ls-files", "--error-unmatch", "-z", "--", rel]);
  if (tracked.code !== 0) {
    // Untracked (or vanished). `git diff HEAD -- path` would print nothing at
    // all for it, which reads as "no changes" — the exact opposite of the truth
    // for a file the agent just created.
    if (!exists) return { path: rel, status: "deleted", diff: "", binary: false, truncated: false };
    const added = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", devNull(), abs]);
    return finishDiff(rel, "untracked", added.stdout);
  }

  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  // A checkout with no commits yet: HEAD doesn't resolve, so `git diff HEAD`
  // errors out. Everything tracked there is new by definition — same treatment
  // as untracked.
  if (head.code !== 0) {
    if (!exists) return { path: rel, status: "deleted", diff: "", binary: false, truncated: false };
    const added = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", devNull(), abs]);
    return finishDiff(rel, "added", added.stdout);
  }

  // HEAD (not --cached, not bare) so the diff covers staged and unstaged work
  // together: the panel answers "what changed in this file since the last
  // commit", and whether the agent happened to `git add` is not part of that.
  const r = await git(root, ["diff", "--no-color", "--no-ext-diff", "-M", "HEAD", "--", rel]);
  return finishDiff(rel, exists ? "modified" : "deleted", r.stdout);
}

// What a committed diff did to the file, read off git's own extended header
// rather than from a second call. "modified" is the fallback because it is what
// a header carrying none of these markers means.
function statusFromDiffHeader(raw: string): ChangeStatus {
  if (/^new file mode /m.test(raw)) return "added";
  if (/^deleted file mode /m.test(raw)) return "deleted";
  if (/^rename from /m.test(raw)) return "renamed";
  return "modified";
}

function finishDiff(rel: string, status: ChangeStatus, raw: string): FileDiff {
  // git says this itself for blobs it won't render; surfacing the flag lets the
  // client offer the image/download view instead of an empty diff pane.
  const binary = /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw);
  const truncated = raw.length > MAX_DIFF_BYTES;
  // Cut on a line boundary so the client's hunk parser never meets half a line.
  const diff = truncated ? raw.slice(0, raw.lastIndexOf("\n", MAX_DIFF_BYTES) + 1) : raw;
  return { path: rel, status, diff: binary ? "" : diff, binary, truncated: binary ? false : truncated };
}

// `git diff --no-index` needs a path that reads as empty. /dev/null is the
// portable one on POSIX; NUL is the Windows equivalent git understands.
function devNull(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// One file's content for the preview pane. Never throws for an unreadable file
// — the caller turns a null into a 404 — and never reads more than the caps
// above, so a stray 2GB artifact in the tree is a bounded request.
export async function preview(abs: string, displayPath: string): Promise<FilePreview | null> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(abs); } catch { return null; }
  if (!st.isFile()) return null;

  const base = {
    path: displayPath,
    abs,
    size: st.size,
    modifiedAt: new Date(st.mtimeMs).toISOString(),
  };

  const image = inlineImageType(abs);
  if (image) return { ...base, kind: "image", mimeType: image };

  // Read only what we're willing to show, plus one byte — the extra byte is how
  // we know the file continued past the cap without stat'ing our own read.
  let head: Buffer;
  try {
    const fh = await fs.promises.open(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT_BYTES + 1));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  if (looksBinary(head)) return { ...base, kind: "binary" };

  const truncated = head.length > MAX_TEXT_BYTES;
  const body = truncated ? head.subarray(0, MAX_TEXT_BYTES) : head;
  // A cap can land mid-codepoint; decoding the whole slice at once leaves that
  // as a single replacement char at the very end, which is the right cosmetic
  // outcome for a view already labelled truncated.
  return {
    ...base, kind: "text", text: body.toString("utf8"), truncated,
    hash: truncated || st.size > MAX_WRITE_BYTES ? undefined : sha256(head),
  };
}

// The precondition token for a write: sha256 over the file's BYTES, never over
// the decoded string. The two differ for anything that isn't clean UTF-8, and a
// client that hashed one while the server hashed the other would reject every
// save on exactly the files most worth being careful with.
export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export type WriteResult =
  | { ok: true; size: number; modifiedAt: string; hash: string }
  // `stale` carries what is on disk NOW, so the client can offer to reload
  // without a second request — the round trip it would make is one this
  // response already knows the answer to.
  | { ok: false; code: "stale"; text: string; hash: string; modifiedAt: string }
  | { ok: false; code: "not-found" | "not-text" | "too-large" };

// Replace one text file, but only if it still holds what the caller last read.
//
// Every check here is repeated from the client on purpose: the client's are
// what grey out the pencil, these are what decide. `expected` is the whole
// mechanism — mtimes are coarse and a same-size same-tick overwrite is exactly
// the case an agent editing alongside you produces.
export async function writeText(abs: string, text: string, expected: string): Promise<WriteResult> {
  const next = Buffer.from(text, "utf8");
  if (next.length > MAX_WRITE_BYTES) return { ok: false, code: "too-large" };

  // Everything that can be settled from the stat is settled before a byte is
  // read, exactly as preview() reads only what it is willing to show: a POST
  // naming a 2GB artifact must cost a stat, not 2GB of buffer, and refusing it
  // after reading it is refusing it too late.
  let st: fs.Stats;
  try { st = await fs.promises.stat(abs); } catch { return { ok: false, code: "not-found" }; }
  if (!st.isFile()) return { ok: false, code: "not-found" };
  // Not "is it text now" but "would preview() have handed this out as whole,
  // editable text" — so the refusals mirror its non-text outcomes. The image
  // check has to be by extension exactly as preview()'s is: it runs BEFORE the
  // content sniff there, and a small PNG carries no NUL byte for looksBinary to
  // find, so content alone would call it text and let a save through on a file
  // the viewer never showed as text at all.
  if (inlineImageType(abs) || st.size > MAX_TEXT_BYTES) return { ok: false, code: "not-text" };

  let current: Buffer;
  try { current = await fs.promises.readFile(abs); } catch { return { ok: false, code: "not-found" }; }
  if (looksBinary(current)) return { ok: false, code: "not-text" };

  const hash = sha256(current);
  if (hash !== expected) {
    return {
      ok: false, code: "stale", hash,
      text: current.toString("utf8"),
      modifiedAt: new Date(st.mtimeMs).toISOString(),
    };
  }

  // Plain write, not write-to-temp-and-rename: the repo's other writes are
  // plain (see the titles sidecar), and atomicity is not what protects this —
  // the digest above is. A torn write needs a crash mid-syscall; a concurrent
  // agent edit needs only a second.
  await fs.promises.writeFile(abs, next);
  const after = await fs.promises.stat(abs);
  return { ok: true, size: after.size, modifiedAt: new Date(after.mtimeMs).toISOString(), hash: sha256(next) };
}

// Sort a directory the way a file tree reads: folders first, then files, each
// case-insensitively alphabetical. Exported for its own test — this is the
// order the panel is judged on, and it has no other observable effect.
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) =>
    Number(b.dir) - Number(a.dir) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    a.name.localeCompare(b.name));
}

// Which of `names` (relative to `root`) git would refuse to track. One call for
// the whole directory rather than one per row.
//
// `check-ignore` exits 1 when NOTHING matches, which is the common case and not
// an error — same shape as `diff --no-index`'s exit 1 above. Any other non-zero
// (no repo, no git) means "no ignore information", and the tree simply shows
// every row undimmed rather than failing.
async function ignoredNames(root: string, dir: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  const rels = names.map((n) => toPosix(path.relative(root, path.join(dir, n))));
  // No --no-index: a path that is tracked is not ignored, whatever the patterns
  // say, and that is the answer a reader wants from a dimmed row.
  const r = await gitStdin(root, ["check-ignore", "-z", "--stdin"], rels.join("\0"));
  if (r.code !== 0 && r.code !== 1) return new Set();
  const hits = new Set(r.stdout.split("\0").filter(Boolean));
  const out = new Set<string>();
  names.forEach((n, i) => { if (hits.has(rels[i])) out.add(n); });
  return out;
}

// One directory's entries. Names only — no stat storm beyond the size a row
// shows, and no descent: the tree asks again when a folder is opened, so the
// cost of a huge subtree is only paid by someone who opens it.
export async function tree(cwd: string, abs: string, displayPath: string): Promise<TreeResult | null> {
  let all: fs.Dirent[];
  try { all = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return null; }
  // Every other dotfile is shown — a .env you can see is the point of showing
  // them. `.git` is the exception: it is the repo's own plumbing, it is in
  // every checkout, and `check-ignore` won't call it ignored (git excludes it
  // structurally), so it would sit at the top of every tree undimmed.
  const ents = all.filter((e) => e.name !== ".git");

  // Sort before the cap, so a truncated folder shows its first N names rather
  // than whichever N the filesystem happened to hand back — and so re-opening
  // it shows the same N. The rows are sorted again after the stat pass, which
  // is what moves folders to the top; this pass only makes the cut stable.
  ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const truncated = ents.length > MAX_TREE_ENTRIES;
  const kept = truncated ? ents.slice(0, MAX_TREE_ENTRIES) : ents;
  const root = await repoRoot(cwd);
  const ignored = root ? await ignoredNames(root, abs, kept.map((e) => e.name)) : new Set<string>();

  const entries = kept.map((e): TreeEntry => {
    const child = path.join(abs, e.name);
    // A symlink reports isDirectory() false, so resolve it once to decide
    // whether the row is expandable. A broken link stays a (dead) file row.
    let dir = e.isDirectory();
    const symlink = e.isSymbolicLink();
    if (symlink) { try { dir = fs.statSync(child).isDirectory(); } catch { dir = false; } }
    let size: number | undefined;
    if (!dir) { try { size = fs.statSync(child).size; } catch { /* unreadable, or a dead link */ } }
    // A nested checkout — a submodule, a vendored repo, a sibling project under
    // a monorepo root. The folder picker marks these already; the tree is the
    // other place you go looking for "is that its own repo?".
    const isRepo = dir && fs.existsSync(path.join(child, ".git"));
    return {
      name: e.name, abs: child, dir,
      ...(size === undefined ? {} : { size }),
      ...(ignored.has(e.name) ? { ignored: true } : {}),
      ...(symlink ? { symlink: true } : {}),
      ...(isRepo ? { git: true } : {}),
    };
  });
  return { abs, path: displayPath, entries: sortTreeEntries(entries), truncated };
}

// Everything in one folder the conversation wrote into, flattened.
//
// This is the third answer to "what did this turn produce", and it exists
// because the other two are structurally blind to the same file. A tool call
// only names a path when the tool takes one — `Bash` reports a command, so
// anything an agent redirects, generates from a script, or writes with a
// heredoc names nothing. `git status` only knows a checkout, so a file written
// to /tmp is outside everything it can describe. A mockup generated by a python
// heredoc into a scratch directory hits both gaps at once and simply does not
// exist as far as the panel is concerned.
//
// What it does NOT do is guess. There is no attempt to parse a shell command for
// path-looking strings, and no mtime cutoff to decide which files are "this
// turn's": a cutoff has no meaning for a conversation replayed from a
// transcript, which is exactly when someone reopens a session to find a file
// again. Instead the folder is listed whole, and WHICH folders qualify is a
// policy decision the caller makes (see allowedOutputFolder in gateway.ts) —
// keeping the only judgement call in one place, next to the roots it needs.
//
// Newest first, for the same reason changes() sorts that way: the panel is
// opened right after a turn, so the file the agent just generated is the one
// being looked for.
export async function outputFolder(abs: string): Promise<OutputFolder | null> {
  try { if (!(await fs.promises.stat(abs)).isDirectory()) return null; } catch { return null; }
  const found: Array<OutputFile & { mtime: number }> = [];
  let truncated = false;

  async function walk(cur: string, rel: string, depth: number): Promise<void> {
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (e.name === ".git") continue; // repo plumbing, never output
      if (found.length >= MAX_OUTPUT_FILES) { truncated = true; return; }
      const child = path.join(cur, e.name);
      const childRel = rel ? rel + "/" + e.name : e.name;
      // A symlink reports neither isDirectory() nor isFile(), so it is skipped
      // entirely rather than followed: a loop under a scratch directory would
      // hang the request, and the interesting case here is generated files.
      if (e.isDirectory()) {
        if (depth + 1 < OUTPUT_FOLDER_MAX_DEPTH) await walk(child, childRel, depth + 1);
        else truncated = true;
        continue;
      }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try { st = await fs.promises.stat(child); } catch { continue; }
      found.push({ path: childRel, abs: child, size: st.size, mtime: st.mtimeMs });
    }
  }

  await walk(abs, "", 0);
  found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return { abs, files: found.map(({ mtime: _mtime, ...f }) => f), truncated };
}

// Filenames under `abs` matching `query`, best MAX_FIND_RESULTS of ALL matches.
//
// The corpus comes from the per-root index (see file-index.ts): git's file list
// for a checkout — which already excludes ignored files, includes dotfiles, and
// never walks into node_modules — or a bounded filesystem walk without one.
// Matching and ranking are fuzzy.ts's tiers; the cap is applied after ranking,
// so a truncated result is the best K, not the alphabetically first K.
export async function find(cwd: string, abs: string, query: string): Promise<FindResult> {
  const q = parseFindQuery(query);
  if (!q) return { files: [], truncated: false, fromGit: false, total: 0 };

  const root = await repoRoot(cwd);
  // The corpus is rooted at the repo root, but the caller searches from `abs`
  // (a conversation can run in a subdirectory). Constrain and re-base here, in
  // memory — the old code asked git to scope the listing instead, which is why
  // paths were always answered relative to the search root. Keep that contract.
  //
  // `abs` can also sit *outside* cwd's checkout: the route takes a path, and
  // ACPG_PREVIEW_ROOTS lets it name a folder in another project entirely. That
  // repo's index knows nothing about those paths, so they get the walk — which
  // is what the old code did here too, by way of ls-files refusing the path.
  const rel = root ? toPosix(path.relative(root, abs)) : "";
  const indexRoot = root !== null && !rel.startsWith("..") && !path.isAbsolute(rel) ? root : null;
  const corpus = indexRoot ? await fileIndex.corpusGit(indexRoot) : await fileIndex.corpusWalk(abs);
  const prefix = indexRoot && rel ? rel + "/" : "";

  const top = new TopK<RankedFile>(MAX_FIND_RESULTS, compareRanked);
  for (let i = 0; i < corpus.paths.length; i++) {
    if (prefix && !corpus.paths[i].startsWith(prefix)) continue;
    const relLower = prefix ? corpus.lower[i].slice(prefix.length) : corpus.lower[i];
    const m = matchPath(relLower, corpus.bases[i], q);
    if (!m) continue;
    top.push({
      rel: prefix ? corpus.paths[i].slice(prefix.length) : corpus.paths[i],
      tier: m.tier, score: m.score,
      changed: corpus.changed.has(corpus.paths[i]),
    });
  }

  return {
    files: top.items().map((r) => ({ path: r.rel, abs: path.join(abs, r.rel) })),
    truncated: top.total > MAX_FIND_RESULTS,
    fromGit: corpus.fromGit,
    total: top.total,
    ...(corpus.pending ? { pending: true } : {}),
    ...(corpus.limited ? { limited: true } : {}),
  };
}

// `git grep -z -n` writes one record per matching line, newline-separated:
//
//   path\0line\0the matching line's text
//
// Only the first two NULs are separators — everything after them is the file's
// own text and is not inspected. Pure, so the awkward halves (a path holding a
// colon, a 5MB minified line, one file owning every match) are unit-testable
// without a repo that contains them.
export function parseGrepZ(records: string[], abs: string): {
  files: GrepFile[]; total: number; moreFiles: boolean;
} {
  const byPath = new Map<string, GrepFile>();
  let total = 0;
  let moreFiles = false;
  for (const rec of records) {
    const p = rec.indexOf("\0");
    if (p < 0) continue;
    const n = rec.indexOf("\0", p + 1);
    if (n < 0) continue;
    const line = Number(rec.slice(p + 1, n));
    if (!Number.isInteger(line)) continue;
    const rel = rec.slice(0, p);
    let file = byPath.get(rel);
    if (!file) {
      // Past the file cap the rest of the records are still counted — "50 of
      // 300 files" is the honest report — but no more rows are built.
      if (byPath.size >= MAX_GREP_FILES) { moreFiles = true; total++; continue; }
      file = { path: rel, abs: path.join(abs, rel), matches: [], more: 0 };
      byPath.set(rel, file);
    }
    total++;
    if (file.matches.length >= MAX_GREP_PER_FILE) { file.more++; continue; }
    // Leading indentation is dead width in a 440px column, and one minified
    // bundle line would otherwise be the whole response.
    // trimEnd too: a CRLF checkout ends every line with a \r that is invisible
    // in the panel and eats into the slice below.
    file.matches.push({ line, text: rec.slice(n + 1).trim().slice(0, MAX_GREP_LINE_CHARS) });
  }
  return { files: [...byPath.values()], total, moreFiles };
}

// Lines matching `query` in the files under `abs` — the other half of the
// panel's Project search, where find() only reads names.
//
// `git grep` rather than a read of the corpus find() already holds: git skips
// ignored and binary files by itself, searches in C across every core, and
// keeps the gateway from pulling a project's worth of bytes through node on
// every keystroke. The cost is that a folder git knows nothing about cannot be
// searched at all — reported as fromGit:false rather than as "no matches".
export async function grep(cwd: string, abs: string, query: string): Promise<GrepResult> {
  const q = query.trim();
  if (q.length < MIN_GREP_QUERY) return { files: [], truncated: false, fromGit: false, total: 0 };
  // Run IN `abs`: git grep searches the tree from its working directory down
  // and prints paths relative to it, which is find()'s contract too. The
  // pattern is an argv element and --fixed-strings keeps it literal, so
  // nothing here can be read as a flag, a regex bomb, or a shell word.
  const r = await gitTokens(abs, [
    "grep", "--no-color", "--untracked", "-I", "-n", "-z", "-i", "--fixed-strings", "-e", q,
  ], MAX_GREP_LINES, "\n");
  // 1 is git grep's "no matches" — the search ran and found nothing, which is a
  // result. Anything else (128: not a repository, -1: no git binary or a
  // timeout) means nothing was searched, and saying "no matches" to that would
  // be the panel lying.
  if (r.failed || (r.code !== 0 && r.code !== 1)) return { files: [], truncated: false, fromGit: false, total: 0 };
  const { files, total, moreFiles } = parseGrepZ(r.tokens, abs);
  return { files, truncated: r.truncated || moreFiles, fromGit: true, total };
}
