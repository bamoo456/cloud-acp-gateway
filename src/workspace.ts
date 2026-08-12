// Workspace file preview: what the agent actually did to the project, readable
// from the browser.
//
// The gateway already relays an agent's *narration* of its work (tool cards,
// inline diffs it chose to emit). What it could not do is answer "show me the
// file" — the produced screenshot, the rewritten module, the full diff of a
// change the agent summarised in one line. The agent runs on this host, so the
// files are right there; this module is the read-only window onto them.
//
// Five reads, all bounded and all scoped to ACPG_FS_ROOT by the caller:
//   - changes(): git's view of what is dirty in the project (status + numstat)
//   - fileDiff(): one file's unified diff, including untracked files
//   - preview():  one file's bytes as text, image metadata, or "binary"
//   - tree():     one directory's entries, for browsing the project itself
//   - find():     filenames matching a query, anywhere under the project
//
// Deliberately read-only: nothing here writes, stages, or reverts. The panel is
// a viewer, and keeping the write surface at zero means a browser session that
// leaks can't rewrite the checkout the agent is working in.
import fs from "node:fs";
import path from "node:path";
import { git, gitStdin } from "./git-exec.ts";

// The panel lists changed files; past a few hundred it stops being a list and
// starts being a scroll. Truncate and say so rather than shipping thousands.
export const MAX_CHANGED_FILES = 500;
// A diff past this is not read in a side panel — it's opened in an editor.
export const MAX_DIFF_BYTES = 512 * 1024;
// Text preview cap. Same reasoning; the client shows a "truncated" notice.
export const MAX_TEXT_BYTES = 512 * 1024;
// Raw byte cap for the <img>/download route. Generous enough for screenshots
// and design assets, small enough that one request can't pin memory.
export const MAX_RAW_BYTES = 25 * 1024 * 1024;
// One directory's worth of rows. A generated folder can hold tens of thousands
// of entries; the tree says so rather than rendering them.
export const MAX_TREE_ENTRIES = 500;
// Filename matches per query. The box is a jump-to, not a report.
export const MAX_FIND_RESULTS = 200;

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

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
  reason?: string;       // why `files` is empty when repo is null (no git, not a repo)
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
}

export interface TreeResult {
  abs: string;             // the directory listed
  path: string;            // how to name it in the UI (cwd-relative, else absolute)
  entries: TreeEntry[];
  truncated: boolean;
}

export interface FoundFile {
  path: string;  // relative to the search root, POSIX
  abs: string;
}

export interface FindResult {
  files: FoundFile[];
  truncated: boolean;
  // True when the walk was git's own file list, which already excludes ignored
  // files. Without it the client can't explain why a visible-but-ignored file
  // in the tree isn't a search hit.
  fromGit: boolean;
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

// One file's unified diff. `abs` must already be resolved within FS_ROOT by the
// caller; `cwd` only supplies the repo context.
export async function fileDiff(cwd: string, abs: string): Promise<FileDiff> {
  const root = await repoRoot(cwd);
  const rel = root ? toPosix(path.relative(root, abs)) : path.basename(abs);
  const exists = fs.existsSync(abs);

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
  return { ...base, kind: "text", text: body.toString("utf8"), truncated };
}

// Directories folded away in the fallback walk, when there is no git to ask.
// Same list the composer's "@ file" picker uses: a build output or a dependency
// tree buries every real source file under it.
const FIND_IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage", ".git",
]);
// Depth bound for that same fallback. git's own listing needs no such limit.
const FIND_MAX_DEPTH = 8;

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
    return {
      name: e.name, abs: child, dir,
      ...(size === undefined ? {} : { size }),
      ...(ignored.has(e.name) ? { ignored: true } : {}),
      ...(symlink ? { symlink: true } : {}),
    };
  });
  return { abs, path: displayPath, entries: sortTreeEntries(entries), truncated };
}

// Filenames under `abs` matching `query` as a case-insensitive substring of the
// root-relative path.
//
// git supplies the file list when there is a repo: one call, it already knows
// every tracked and untracked-but-not-ignored file, and it includes dotfiles —
// which the tree shows, so a filter that skipped them would fail to find a
// `.env` sitting in plain sight. It also means the box never walks into
// node_modules, for the same reason the tree dims it.
export async function find(cwd: string, abs: string, query: string): Promise<FindResult> {
  const q = query.trim().toLowerCase();
  if (!q) return { files: [], truncated: false, fromGit: false };

  const root = await repoRoot(cwd);
  const rels = root ? await gitFileList(root, abs) : null;
  const paths = rels ?? await walkFiles(abs);
  const hits: FoundFile[] = [];
  for (const rel of paths) {
    if (!rel.toLowerCase().includes(q)) continue;
    if (hits.length >= MAX_FIND_RESULTS) return { files: rank(hits, q), truncated: true, fromGit: !!rels };
    hits.push({ path: rel, abs: path.join(abs, rel) });
  }
  return { files: rank(hits, q), truncated: false, fromGit: !!rels };
}

// A basename hit beats a mid-path hit, then the shallower path, then
// alphabetical — so typing "panel" finds FilePanel.tsx before a file buried in
// a folder called panels/.
function rank(files: FoundFile[], q: string): FoundFile[] {
  return files.sort((a, b) => {
    const ab = a.path.slice(a.path.lastIndexOf("/") + 1).toLowerCase().includes(q) ? 0 : 1;
    const bb = b.path.slice(b.path.lastIndexOf("/") + 1).toLowerCase().includes(q) ? 0 : 1;
    return ab - bb || a.path.length - b.path.length || a.path.localeCompare(b.path);
  });
}

// Every file git would show under `abs`, as paths relative to it. Null when git
// can't answer, which sends find() to the filesystem walk instead.
async function gitFileList(root: string, abs: string): Promise<string[] | null> {
  const r = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", abs]);
  if (r.code !== 0) return null;
  const out: string[] = [];
  for (const rel of r.stdout.split("\0")) {
    if (!rel) continue;
    // ls-files answers in repo-relative paths even when asked about a
    // subdirectory, so re-base onto the folder actually being searched.
    const under = path.relative(abs, path.resolve(root, rel));
    if (under && !under.startsWith("..") && !path.isAbsolute(under)) out.push(toPosix(under));
  }
  return out;
}

// No repo, or no git: walk it ourselves. Bounded in depth, folds away the
// build/dependency directories by name (there is no .gitignore to consult), and
// never follows a symlinked directory — a loop there would hang the request.
async function walkFiles(abs: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(cur: string, rel: string, depth: number): Promise<void> {
    if (out.length >= MAX_FIND_RESULTS * 20) return;
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (FIND_IGNORE_DIRS.has(e.name) || depth >= FIND_MAX_DEPTH) continue;
        await walk(path.join(cur, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk(abs, "", 0);
  return out;
}
