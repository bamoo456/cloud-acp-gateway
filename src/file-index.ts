// Per-root file-list cache backing /workspace/find. The expensive thing about
// filename search on a monorepo is not matching (5–12ms in-memory for 147k
// paths) but acquiring the list: a cold `git ls-files --others` walk is
// seconds. So the corpus is cached per repo root and each half is refreshed by
// a precise signal rather than a guess:
//
//   tracked   — `ls-files --cached`, streamed. Its output only changes when the
//               repo's index file changes (add/rm/checkout/commit; worktree
//               edits don't move paths), so a stat of that file is an *exact*
//               invalidation probe, paid once per query.
//   untracked — never walked here. changes() already runs `git status -uall`
//               every time the panel opens and every time a turn ends, and
//               feeds the parse to noteStatus(); search therefore sees exactly
//               what the Changes section sees, by construction. Until the first
//               snapshot arrives the corpus is served tracked-only and flagged
//               `pending` so the client can say so.
//
// Non-git folders keep a bounded filesystem walk with a TTL — there is no
// index file to stat and no status run to ride on.
import fs from "node:fs";
import path from "node:path";
import { git, gitTokens } from "./git-exec.ts";

// Corpus ceiling. Far above any repo this panel is expected to meet (the
// motivating monorepo is 147k files); the cap exists so a pathological root
// cannot pin unbounded memory, and hitting it is reported, never silent.
export const MAX_INDEX_PATHS = 500_000;
// The walk has no gitignore to prune with, so it gets a tighter budget.
export const MAX_WALK_PATHS = 50_000;
const WALK_TTL_MS = 30_000;
// Directories folded away in the no-git walk. Same list the old find() used.
const WALK_IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage", ".git",
]);
const WALK_MAX_DEPTH = 8;
// Roots kept resident. A corpus for a monorepo measures tens of MB, so this is
// a real memory dial, not a tidiness one.
const MAX_ROOTS = 3;

export type Corpus = {
  paths: string[];        // POSIX, relative to the corpus root
  lower: string[];        // paths lowercased once at build, not per keystroke
  bases: string[];        // basenames lowercased
  changed: Set<string>;   // rel paths git currently reports touched (rank boost)
  fromGit: boolean;
  pending: boolean;       // git corpus with no status snapshot yet
  limited: boolean;       // a cap cut this corpus short (MAX_INDEX_PATHS / walk bounds)
};

type StatusSnapshot = { untracked: string[]; deleted: Set<string>; changed: Set<string> };
type GitRootState = {
  tracked: string[];
  trackedLimited: boolean;
  indexFile: string;
  indexStat: { mtimeMs: number; size: number } | null;
  status: StatusSnapshot | null;
  corpus: Corpus | null;  // derived; null = dirty
  building: Promise<void> | null;
  lastUsed: number;
};
type WalkRootState = { corpus: Corpus; builtAt: number; lastUsed: number };

function buildCorpus(paths: string[], opts: { changed: Set<string>; fromGit: boolean; pending: boolean; limited: boolean }): Corpus {
  const lower = new Array<string>(paths.length);
  const bases = new Array<string>(paths.length);
  for (let i = 0; i < paths.length; i++) {
    const l = paths[i].toLowerCase();
    lower[i] = l;
    bases[i] = l.slice(l.lastIndexOf("/") + 1);
  }
  return { paths, lower, bases, ...opts };
}

export class FileIndex {
  private gitRoots = new Map<string, GitRootState>();
  private walkRoots = new Map<string, WalkRootState>();
  constructor(private now: () => number = Date.now) {}

  clear(): void { this.gitRoots.clear(); this.walkRoots.clear(); }

  // The one place a git root's state is created. Shared by corpusGit and
  // noteStatus because the panel calls /workspace/changes BEFORE anyone types
  // into the find box — an unknown root in noteStatus is the COMMON case, and
  // dropping its snapshot would leave every repo's first search silently
  // missing all untracked files until the next status run.
  private gitRoot(root: string): GitRootState {
    let st = this.gitRoots.get(root);
    if (!st) {
      st = {
        tracked: [], trackedLimited: false, indexFile: path.join(root, ".git", "index"),
        indexStat: null, status: null, corpus: null, building: null,
        // Stamped at insert, not 0: evict() runs before the post-lookup touch,
        // and a zero would make the just-inserted root the LRU minimum.
        lastUsed: this.now(),
      };
      this.gitRoots.set(root, st);
      this.evict(this.gitRoots);
    }
    return st;
  }

  // The status half arrives from changes() — the one place that already parses
  // `git status`.
  noteStatus(root: string, entries: Array<{ path: string; status: string }>): void {
    const st = this.gitRoot(root);
    const snap: StatusSnapshot = { untracked: [], deleted: new Set(), changed: new Set() };
    for (const e of entries) {
      snap.changed.add(e.path);
      if (e.status === "untracked") snap.untracked.push(e.path);
      else if (e.status === "deleted") snap.deleted.add(e.path);
    }
    st.status = snap;
    st.corpus = null;
  }

  async corpusGit(root: string): Promise<Corpus> {
    const st = this.gitRoot(root);
    st.lastUsed = this.now();
    if (this.trackedStale(st)) {
      // One rebuild at a time per root: concurrent keystrokes share the flight.
      st.building ??= this.rebuildTracked(root, st).finally(() => { st.building = null; });
      await st.building;
    }
    if (!st.corpus) {
      const deleted = st.status?.deleted ?? new Set<string>();
      const untracked = st.status?.untracked ?? [];
      const paths = deleted.size > 0 ? st.tracked.filter((p) => !deleted.has(p)) : st.tracked;
      st.corpus = buildCorpus(untracked.length > 0 ? paths.concat(untracked) : paths, {
        changed: st.status?.changed ?? new Set(),
        fromGit: true,
        pending: st.status === null,
        limited: st.trackedLimited,
      });
    }
    return st.corpus;
  }

  private trackedStale(st: GitRootState): boolean {
    if (!st.indexStat) return true;
    try {
      const s = fs.statSync(st.indexFile);
      return s.mtimeMs !== st.indexStat.mtimeMs || s.size !== st.indexStat.size;
    } catch {
      return true; // unreadable index file: rebuild rather than serve who-knows-what
    }
  }

  private async rebuildTracked(root: string, st: GitRootState): Promise<void> {
    // Linked worktrees keep their index under .git/worktrees/<name>/, so the
    // path is asked of git rather than assumed. Best effort: the default
    // spelling is right for a normal checkout.
    const where = await git(root, ["rev-parse", "--git-path", "index"]);
    if (where.code === 0 && where.stdout.trim()) st.indexFile = path.resolve(root, where.stdout.trim());
    let statNow: { mtimeMs: number; size: number } | null = null;
    try {
      const s = fs.statSync(st.indexFile);
      statNow = { mtimeMs: s.mtimeMs, size: s.size };
    } catch { /* recorded as null: next query rebuilds again */ }
    const r = await gitTokens(root, ["ls-files", "-z", "--cached"], MAX_INDEX_PATHS);
    if (r.failed || (r.code !== 0 && !r.truncated)) {
      // Couldn't list: keep whatever we had (an old list beats an empty panel),
      // but leave indexStat null so the next query tries again.
      st.indexStat = null;
      return;
    }
    // A merge conflict lists a path once per index stage. ls-files emits index
    // order, so the duplicates are adjacent and one pass drops them — no Set,
    // and no dependency on a git new enough for --deduplicate.
    const toks = r.tokens;
    const tracked: string[] = [];
    for (let i = 0; i < toks.length; i++) if (i === 0 || toks[i] !== toks[i - 1]) tracked.push(toks[i]);
    st.tracked = tracked;
    st.trackedLimited = r.truncated;
    st.indexStat = statNow;
    st.corpus = null;
  }

  async corpusWalk(absRoot: string): Promise<Corpus> {
    const hit = this.walkRoots.get(absRoot);
    if (hit && this.now() - hit.builtAt < WALK_TTL_MS) {
      hit.lastUsed = this.now();
      return hit.corpus;
    }
    const { paths, limited } = await walkFiles(absRoot);
    const corpus = buildCorpus(paths, { changed: new Set(), fromGit: false, pending: false, limited });
    this.walkRoots.set(absRoot, { corpus, builtAt: this.now(), lastUsed: this.now() });
    this.evict(this.walkRoots);
    return corpus;
  }

  // Generic over the state type: Map's value slot is invariant in TS, so a
  // `Map<string, { lastUsed: number }>` parameter would reject both real maps.
  private evict<T extends { lastUsed: number }>(map: Map<string, T>): void {
    while (map.size > MAX_ROOTS) {
      let oldest: string | null = null;
      let at = Infinity;
      for (const [k, v] of map) if (v.lastUsed < at) { at = v.lastUsed; oldest = k; }
      if (oldest === null) return;
      map.delete(oldest);
    }
  }
}

// No repo, or no git: walk the filesystem. Bounded in depth, folds away the
// build/dependency directories by name (there is no .gitignore to consult), and
// never follows a symlinked directory — a loop there would hang the request.
// Collects every file up to the cap; ranking happens in the caller, so the cap
// cuts corpus size, not result quality below it.
async function walkFiles(absRoot: string): Promise<{ paths: string[]; limited: boolean }> {
  const out: string[] = [];
  let limited = false;
  async function walk(cur: string, rel: string, depth: number): Promise<void> {
    if (out.length >= MAX_WALK_PATHS) { limited = true; return; }
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= MAX_WALK_PATHS) { limited = true; return; }
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (WALK_IGNORE_DIRS.has(e.name)) continue;
        // Conservative: a skipped directory flags the walk as limited even if
        // it happens to be empty — for an advisory "part of this folder wasn't
        // indexed" note, a rare false positive beats a false negative.
        if (depth >= WALK_MAX_DEPTH) { limited = true; continue; }
        await walk(path.join(cur, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk(absRoot, "", 0);
  return { paths: out, limited };
}

export const fileIndex = new FileIndex();
