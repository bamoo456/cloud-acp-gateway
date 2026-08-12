# Project File-Find Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the file panel's Project-mode filename search correct and fast on huge monorepos (measured: 147k-file repo) by replacing the per-keystroke `git ls-files --cached --others` call with a cached, precisely-invalidated in-memory index, a tiered fuzzy matcher, and bounded top-K selection.

**Architecture:** Corpus acquisition splits in two: the tracked half comes from `git ls-files --cached` streamed over `spawn` (no 16MB `maxBuffer` cliff) and is invalidated exactly by stat'ing the repo's git index file; the untracked half piggybacks on the `git status -uall` that `changes()` already runs on every panel open / turn end — no separate working-tree walk is ever introduced. Matching runs in-process over precomputed lowercase arrays (measured 5–12ms for 147k paths) with a strict tier order that guarantees today's substring semantics can never be displaced by new fuzzy-only hits. Non-git folders keep the existing bounded filesystem walk as corpus source with TTL invalidation.

**Tech Stack:** Node ≥24 stdlib only (`child_process.spawn`, `fs`, `path`), TypeScript, `node --test` + vitest (web).

## Global Constraints

- **No new npm dependencies. No new system binaries.** git stays the only external tool, and it is already a hard dependency with a `git-missing` degradation path.
- Node engine floor: `>=24` (package.json).
- All server tests run through `npm test` (`node --import tsx --test src/*.test.ts` with the env vars in package.json). To run one file:
  `ACPG_NO_LISTEN=1 ACPG_AUTH_USER=test-user ACPG_AUTH_TOKEN=test-token ACPG_LEDGER_DIR="$(mktemp -d)" ACPG_AGENTS_FILE=agents.test.json CLAUDE_CONFIG_DIR="$(mktemp -d)" CODEX_HOME="$(mktemp -d)" node --import tsx --test src/<file>.test.ts`
- Web tests: `cd web && npx vitest run src/components/FileTree.test.ts`.
- Typecheck must stay clean: `npm run typecheck`.
- Commits use Conventional Commits, on branch `feat/find-index` (branched from `main`).
- Follow the codebase's comment style: comments explain *why*, in full sentences, matching the tone of `src/workspace.ts` / `src/search-core.ts`. Do not narrate what the next line does.
- Existing behavior contracts that MUST keep passing unchanged: `src/workspace.routes.test.ts` (the `/workspace/find` test asserts dotfile hits, `deep/` path hits, ignored-file exclusion, basename-over-midpath ranking, empty-query = no matches, and subdirectory re-basing). Do not edit that file except where Task 4 explicitly says so.
- **Non-goals:** the composer's `@` picker (`/files`, `listFiles` in gateway.ts) is NOT touched in this plan; the left-sidebar conversation search is NOT touched; no `fs.watch`, no fsmonitor daemon, no ripgrep.

## Design invariants (the reviewer will check these)

1. **Tier order is a hard guarantee, not a weight.** Tier 3 (whole-path substring of the raw query) reproduces today's match semantics exactly, and every tier-1/2/3 hit sorts strictly before every tier-4 (subsequence) hit. A file findable today must remain findable and must not be pushed out of the top-K by fuzzy-only matches.
2. **Truncation happens after ranking, never before.** `TopK` sees every match; today's "first 200 in alphabetical order, then rank" bug must not survive in either the git path or the walk path.
3. **No `--others` anywhere.** The untracked corpus comes only from `changes()`'s status parse (via `noteStatus`). If no snapshot exists yet, the corpus serves tracked-only and reports `pending: true` — it never blocks or spawns its own walk.
4. **The gateway never mutates the user's repo.** Read-only git invocations only, `--no-optional-locks -c core.fsmonitor=` preserved.

## File Structure

- Create: `src/git-exec.ts` — git process plumbing (`git`, `gitStdin`, new `gitTokens`), moved out of workspace.ts so file-index.ts can use it without an import cycle (workspace → file-index → git-exec).
- Create: `src/fuzzy.ts` + `src/fuzzy.test.ts` — pure matcher: query parse, tiers, subsequence score, `TopK`, comparator. Zero I/O (same layering rule as `search-core.ts`).
- Create: `src/file-index.ts` + `src/file-index.test.ts` — per-root corpus cache: git corpus (tracked stream + status snapshot merge, stat-based invalidation), walk corpus (moved `walkFiles`, TTL), LRU.
- Modify: `src/workspace.ts` — `find()` rewired onto index+matcher; `changes()` feeds `noteStatus`; `FindResult` extended; `gitFileList`/`rank`/old `walkFiles`/`FIND_*` constants deleted; git plumbing imports switched to git-exec.
- Modify: `src/workspace.test.ts` — new `find()` cases (fuzzy tiers, total, pending) added to the existing suite.
- Modify: `web/src/lib/api.ts:222` — `FindResult` gains `total`, `pending?`, `limited?`.
- Modify: `web/src/components/FileTree.tsx` — debounce 160→60ms; result notes for top-K/pending/limited.
- Modify: `web/src/components/FileTree.test.ts` — settle timing + mock shape.

---

### Task 1: Pure matcher — `src/fuzzy.ts`

**Files:**
- Create: `src/fuzzy.ts`
- Test: `src/fuzzy.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (Task 4 depends on these exact names):
  - `parseFindQuery(input: string): FindQuery | null` where `FindQuery = { raw: string; dirTerms: string[]; base: string }`
  - `matchPath(pathLower: string, baseLower: string, q: FindQuery): PathMatch | null` where `PathMatch = { tier: 1 | 2 | 3 | 4; score: number }`
  - `subsequenceScore(hay: string, needle: string): number | null`
  - `class TopK<T> { constructor(k: number, cmp: (a: T, b: T) => number); push(item: T): void; items(): T[]; total: number }`
  - `type RankedFile = { rel: string; tier: number; score: number; changed: boolean }`
  - `compareRanked(a: RankedFile, b: RankedFile): number`

- [ ] **Step 1: Write the failing tests**

```ts
// src/fuzzy.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseFindQuery, matchPath, subsequenceScore, TopK, compareRanked, type RankedFile,
} from "./fuzzy.ts";

describe("parseFindQuery", () => {
  test("lowercases, trims, and splits the basename segment off", () => {
    assert.deepEqual(parseFindQuery("  FilePanel "), { raw: "filepanel", dirTerms: [], base: "filepanel" });
    assert.deepEqual(parseFindQuery("web/comp/Panel"), { raw: "web/comp/panel", dirTerms: ["web", "comp"], base: "panel" });
  });
  test("a trailing slash means 'directory filter only' — base is empty", () => {
    assert.deepEqual(parseFindQuery("deep/"), { raw: "deep/", dirTerms: ["deep"], base: "" });
  });
  test("empty and whitespace queries are null; bare slashes keep raw-substring semantics", () => {
    assert.equal(parseFindQuery("   "), null);
    // "/" matched every nested path before (path.includes("/")); tier 3 preserves that.
    assert.deepEqual(parseFindQuery("/"), { raw: "/", dirTerms: [], base: "" });
  });
});

describe("subsequenceScore", () => {
  test("null when not a subsequence, a score when it is", () => {
    assert.equal(subsequenceScore("filepanel.tsx", "zzz"), null);
    assert.equal(subsequenceScore("filepanel.tsx", "xf"), null, "order matters");
    assert.ok(subsequenceScore("filepanel.tsx", "fipa")! > 0);
  });
  test("consecutive runs beat scattered matches", () => {
    // "fnl" is a genuine but scattered subsequence (f..n..l); "pane" is one run.
    assert.ok(subsequenceScore("filepanel.tsx", "pane")! > subsequenceScore("filepanel.tsx", "fnl")!);
  });
  test("word-boundary starts beat mid-word hits", () => {
    // "tr" starting file-tree's second word vs buried inside "control"
    assert.ok(subsequenceScore("file-tree.tsx", "tr")! > subsequenceScore("control.tsx", "tr")!);
  });
});

describe("matchPath", () => {
  const q = (s: string) => parseFindQuery(s)!;
  const m = (p: string, query: string) => matchPath(p, p.slice(p.lastIndexOf("/") + 1), q(query));
  test("tier 1: basename prefix", () => {
    assert.equal(m("web/src/filepanel.tsx", "filep")!.tier, 1);
  });
  test("tier 2: basename substring", () => {
    assert.equal(m("web/src/filepanel.tsx", "panel")!.tier, 2);
  });
  test("tier 3: raw path substring — today's semantics, above all fuzzy", () => {
    assert.equal(m("web/src/components/x.ts", "components")!.tier, 3);
    assert.equal(m("src/deep/nested.ts", "deep/")!.tier, 3);
  });
  test("tier 4: basename subsequence", () => {
    assert.equal(m("web/src/filepanel.tsx", "fipa")!.tier, 4);
  });
  test("no fuzzy across the whole path: a query scattered over directories is no match", () => {
    // "wxts" is a subsequence of the PATH "web/src/x.ts" but not of the basename.
    assert.equal(m("web/src/x.ts", "wxts"), null);
  });
  test("dir segments gate basename tiers in order", () => {
    assert.equal(m("web/src/components/filepanel.tsx", "comp/panel")!.tier, 2);
    assert.equal(m("web/src/other/filepanel.tsx", "comp/panel"), null);
    // Out of order is not a match either.
    assert.equal(m("web/src/components/filepanel.tsx", "components/web/panel"), null);
  });
});

describe("TopK", () => {
  const cmp = (a: number, b: number) => a - b;
  test("keeps the K best of everything pushed, not the first K seen", () => {
    const t = new TopK<number>(3, cmp);
    for (const n of [9, 8, 7, 1, 2, 3, 6]) t.push(n);
    assert.deepEqual(t.items(), [1, 2, 3]);
    assert.equal(t.total, 7);
  });
  test("stable for fewer than K items", () => {
    const t = new TopK<number>(10, cmp);
    [3, 1, 2].forEach((n) => t.push(n));
    assert.deepEqual(t.items(), [1, 2, 3]);
  });
});

describe("compareRanked", () => {
  const r = (rel: string, tier: number, score: number, changed = false): RankedFile => ({ rel, tier, score, changed });
  test("tier dominates score; changed dominates within a tier; shorter path breaks ties", () => {
    assert.ok(compareRanked(r("a", 2, -100), r("b", 4, 999)) < 0);
    assert.ok(compareRanked(r("a", 2, 0, true), r("b", 2, 50, false)) < 0);
    assert.ok(compareRanked(r("src/a.ts", 2, 0), r("src/deep/a.ts", 2, 0)) < 0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `ACPG_NO_LISTEN=1 ACPG_AUTH_USER=test-user ACPG_AUTH_TOKEN=test-token ACPG_LEDGER_DIR="$(mktemp -d)" ACPG_AGENTS_FILE=agents.test.json CLAUDE_CONFIG_DIR="$(mktemp -d)" CODEX_HOME="$(mktemp -d)" node --import tsx --test src/fuzzy.test.ts`
Expected: FAIL — cannot find module `./fuzzy.ts`.

- [ ] **Step 3: Implement `src/fuzzy.ts`**

```ts
// Pure filename-matching primitives for /workspace/find: query parsing, match
// tiers, subsequence scoring, and bounded top-K selection. No filesystem and no
// git — deterministic on inputs, so the I/O stages can be tested separately
// (the same layering rule search-core.ts follows for transcript search).

export type FindQuery = {
  raw: string;        // trimmed + lowercased input; tier 3 matches this against the whole path
  dirTerms: string[]; // "/"-separated leading segments; must appear in order in the dir part
  base: string;       // last segment, matched against the basename ("" for "dir/" queries)
};

export function parseFindQuery(input: string): FindQuery | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const segs = raw.split("/").filter(Boolean);
  if (segs.length === 0) return { raw, dirTerms: [], base: "" }; // bare slashes: raw substring only
  const base = raw.endsWith("/") ? "" : segs.pop()!;
  return { raw, dirTerms: segs, base };
}

// Greedy leftmost subsequence of `needle` in `hay`, scored fzy-style: bonuses
// for consecutive runs and word starts, penalties for stretch and a late first
// hit. Null when `needle` is not a subsequence. Both strings must already be
// lowercase — the corpus stores lowercased basenames, which is also why there
// is no camelCase-boundary bonus (case is gone by the time we see the text).
export function subsequenceScore(hay: string, needle: string): number | null {
  if (!needle) return null;
  let score = 0, prev = -2, first = -1, j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] !== needle[j]) continue;
    if (first < 0) first = i;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || "-_. ".includes(hay[i - 1])) score += 2;
    prev = i; j++;
  }
  if (j < needle.length) return null;
  return score * 4 - (prev - first + 1 - needle.length) - first;
}

export type PathMatch = { tier: 1 | 2 | 3 | 4; score: number };

// Every dir term must appear in order, each search resuming after the last hit.
function dirMatches(dirLower: string, terms: string[]): boolean {
  let at = 0;
  for (const t of terms) {
    const i = dirLower.indexOf(t, at);
    if (i < 0) return false;
    at = i + t.length;
  }
  return true;
}

// Tier 1: basename prefix. Tier 2: basename substring. Tier 3: whole-path
// substring of the raw query — exactly the pre-index semantics, kept as its own
// tier so anything findable before this change stays findable AND outranks
// every fuzzy-only hit (tier 4, basename subsequence). Fuzzy is deliberately
// basename-scoped: a subsequence over a monorepo-length path matches almost
// everything (measured: 47% of a 147k-file repo for a 5-char query), which is
// not filtering, it's noise. dirTerms gate tiers 1/2/4; tier 3 ignores them
// because the raw query spells its own slashes.
export function matchPath(pathLower: string, baseLower: string, q: FindQuery): PathMatch | null {
  const dir = pathLower.slice(0, pathLower.length - baseLower.length);
  const dirOk = q.dirTerms.length === 0 || dirMatches(dir, q.dirTerms);
  if (q.base && dirOk) {
    if (baseLower.startsWith(q.base)) return { tier: 1, score: -baseLower.length };
    const at = baseLower.indexOf(q.base);
    if (at >= 0) return { tier: 2, score: -(at * 100 + baseLower.length) };
  }
  if (pathLower.includes(q.raw)) return { tier: 3, score: -pathLower.length };
  if (q.base && dirOk) {
    const s = subsequenceScore(baseLower, q.base);
    if (s !== null) return { tier: 4, score: s };
  }
  return null;
}

// Bounded best-K selection. A sorted array with binary-search insertion — K is
// 200 and the comparator is cheap, so O(K) splices beat a heap's constant
// factor at this size. `total` counts every push: it is what tells the caller
// that the K it kept was a cut, and how deep the cut was.
export class TopK<T> {
  private arr: T[] = [];
  total = 0;
  constructor(private k: number, private cmp: (a: T, b: T) => number) {}
  push(item: T): void {
    this.total++;
    if (this.arr.length >= this.k && this.cmp(item, this.arr[this.arr.length - 1]) >= 0) return;
    let lo = 0, hi = this.arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cmp(item, this.arr[mid]) < 0) hi = mid; else lo = mid + 1;
    }
    this.arr.splice(lo, 0, item);
    if (this.arr.length > this.k) this.arr.pop();
  }
  items(): T[] { return this.arr; }
}

export type RankedFile = { rel: string; tier: number; score: number; changed: boolean };

// Tier is a hard boundary, then files git currently reports touched — in this
// panel the agent's own output is the likeliest target — then score, then the
// shorter path, then stable alphabetical (code-unit order, same as the paths'
// own sort).
export function compareRanked(a: RankedFile, b: RankedFile): number {
  return a.tier - b.tier
    || Number(b.changed) - Number(a.changed)
    || b.score - a.score
    || a.rel.length - b.rel.length
    || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Same command as Step 2. Expected: PASS (all describes).
Note: the first `subsequenceScore` test line as written above is tautological — replace it with the two meaningful assertions below it if the reviewer flags it; the intent is: `subsequenceScore("filepanel.tsx", "zzz") === null` and `subsequenceScore("filepanel.tsx", "fipa")! > 0`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/fuzzy.ts src/fuzzy.test.ts
git commit -m "feat: pure tiered fuzzy matcher and bounded top-K for file find"
```

---

### Task 2: Git process plumbing — `src/git-exec.ts` with streamed `gitTokens`

**Files:**
- Create: `src/git-exec.ts`
- Modify: `src/workspace.ts` (move `git`/`gitStdin`/`GIT_TIMEOUT_MS`/`GIT_MAX_BUFFER`/`GitResult` out; import them back)
- Test: `src/git-exec.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 3–4 depend on these exact names):
  - `git(cwd: string, args: string[]): Promise<GitResult>` (moved verbatim)
  - `gitStdin(cwd: string, args: string[], input: string): Promise<GitResult>` (moved verbatim)
  - `gitTokens(cwd: string, args: string[], maxTokens: number): Promise<{ code: number; tokens: string[]; truncated: boolean; failed: boolean }>` (new)
  - `type GitResult = { code: number; stdout: string; stderr: string; failed: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// src/git-exec.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitTokens } from "./git-exec.ts";

function makeRepo(files: string[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-gx-")));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x\n");
  }
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return dir;
}

describe("gitTokens", () => {
  test("streams NUL-separated ls-files output into whole tokens", async () => {
    const repo = makeRepo(["a.ts", "src/b.ts", "src/深い/設計 稿.png"]);
    const r = await gitTokens(repo, ["ls-files", "-z", "--cached"], 10_000);
    assert.equal(r.code, 0);
    assert.equal(r.failed, false);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.tokens.sort(), ["a.ts", "src/b.ts", "src/深い/設計 稿.png"]);
  });
  test("caps at maxTokens, kills the child, and says so", async () => {
    const repo = makeRepo(["a.ts", "b.ts", "c.ts", "d.ts"]);
    const r = await gitTokens(repo, ["ls-files", "-z", "--cached"], 2);
    assert.equal(r.truncated, true);
    assert.equal(r.tokens.length, 2);
  });
  test("a non-repo directory reports git's failure code, not a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-gx-plain-"));
    const r = await gitTokens(dir, ["ls-files", "-z", "--cached"], 10);
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.tokens, []);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `ACPG_NO_LISTEN=1 ACPG_AUTH_USER=test-user ACPG_AUTH_TOKEN=test-token ACPG_LEDGER_DIR="$(mktemp -d)" ACPG_AGENTS_FILE=agents.test.json CLAUDE_CONFIG_DIR="$(mktemp -d)" CODEX_HOME="$(mktemp -d)" node --import tsx --test src/git-exec.test.ts`
Expected: FAIL — cannot find module `./git-exec.ts`.

- [ ] **Step 3: Create `src/git-exec.ts` and rewire `workspace.ts`**

Move from `src/workspace.ts` **verbatim, comments included**: the `GIT_TIMEOUT_MS` and `GIT_MAX_BUFFER` constants (workspace.ts:24-30), the `GitResult` type, `git()` (workspace.ts:236-256), and `gitStdin()` (workspace.ts:258-285). Export all of them. Then add:

```ts
import { spawn } from "node:child_process";

// `git`, but with stdout streamed and split on NUL as it arrives instead of
// buffered whole. execFile's maxBuffer turns a big listing into a silent
// failure — a 147k-file monorepo's ls-files output already sits within 2% of
// the 16MB cap, and blowing it degrades find() to a worse walk without telling
// anyone. A stream has no such cliff; maxTokens is the explicit memory bound
// that replaces it, and hitting it kills the child and reports the cut.
export function gitTokens(
  cwd: string,
  args: string[],
  maxTokens: number,
): Promise<{ code: number; tokens: string[]; truncated: boolean; failed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tokens: string[] = [];
    let leftover = "";
    let truncated = false;
    let failed = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The tail token has no trailing NUL; -z output ends with one, so a
      // non-empty leftover only exists when the stream was cut mid-token.
      if (leftover && !truncated && tokens.length < maxTokens) tokens.push(leftover);
      resolve({ code, tokens, truncated, failed });
    };
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, GIT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      const parts = (leftover + chunk).split("\0");
      leftover = parts.pop() ?? "";
      for (const t of parts) {
        if (!t) continue;
        if (tokens.length >= maxTokens) { truncated = true; child.kill("SIGKILL"); return; }
        tokens.push(t);
      }
    });
    // A failed spawn (no git binary) emits "error" and may never emit "close".
    child.on("error", () => { failed = true; finish(-1); });
    // A deliberate kill (cap / timeout) exits via signal with code null; that
    // is our doing, not git failing, so the cap case still reports code 0.
    child.on("close", (code) => finish(truncated ? 0 : code ?? -1));
  });
}
```

In `src/workspace.ts`: delete the moved code, add `import { git, gitStdin, GIT_MAX_BUFFER } from "./git-exec.ts";` (keep whichever of the constants workspace still references — check usages before deleting). Everything else in workspace.ts stays byte-identical in this task.

- [ ] **Step 4: Run the new test and the full server suite**

Run: the Step-2 command → PASS. Then `npm test` → all existing suites still pass (the move must be behavior-neutral).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/git-exec.ts src/git-exec.test.ts src/workspace.ts
git commit -m "refactor: extract git exec plumbing; add streamed NUL-token runner"
```

---

### Task 3: Corpus cache — `src/file-index.ts`

**Files:**
- Create: `src/file-index.ts`
- Test: `src/file-index.test.ts`

**Interfaces:**
- Consumes: `git`, `gitTokens` from `./git-exec.ts` (Task 2).
- Produces (Task 4 depends on these exact names):
  - `type Corpus = { paths: string[]; lower: string[]; bases: string[]; changed: Set<string>; fromGit: boolean; pending: boolean; limited: boolean }`
  - `class FileIndex { constructor(now?: () => number); corpusGit(root: string): Promise<Corpus>; corpusWalk(absRoot: string): Promise<Corpus>; noteStatus(root: string, entries: Array<{ path: string; status: string }>): void; clear(): void }`
  - `export const fileIndex: FileIndex` (module singleton)
  - `export const MAX_INDEX_PATHS = 500_000`, `export const MAX_WALK_PATHS = 50_000`

- [ ] **Step 1: Write the failing tests**

```ts
// src/file-index.test.ts
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileIndex } from "./file-index.ts";

function makeRepo(files: string[]): { dir: string; run: (...a: string[]) => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fi-")));
  const run = (...args: string[]) => void execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x\n");
  }
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return { dir, run };
}

describe("FileIndex git corpus", () => {
  test("serves tracked paths with precomputed lowercase and basename arrays", async () => {
    const { dir } = makeRepo(["A.ts", "src/Deep/B.TSX"]);
    const idx = new FileIndex();
    const c = await idx.corpusGit(dir);
    assert.deepEqual([...c.paths].sort(), ["A.ts", "src/Deep/B.TSX"]);
    const i = c.paths.indexOf("src/Deep/B.TSX");
    assert.equal(c.lower[i], "src/deep/b.tsx");
    assert.equal(c.bases[i], "b.tsx");
    assert.equal(c.fromGit, true);
    assert.equal(c.pending, true, "no status snapshot yet: untracked half missing");
  });

  test("a second call reuses the corpus object; a git index change rebuilds it", async () => {
    const { dir, run } = makeRepo(["a.ts"]);
    const idx = new FileIndex();
    const c1 = await idx.corpusGit(dir);
    assert.equal(await idx.corpusGit(dir), c1, "unchanged index → same object, no re-list");
    fs.writeFileSync(path.join(dir, "b.ts"), "x\n");
    run("add", "b.ts"); // rewrites .git/index → mtime/size change
    const c2 = await idx.corpusGit(dir);
    assert.notEqual(c2, c1);
    assert.ok(c2.paths.includes("b.ts"));
  });

  test("noteStatus merges untracked in, subtracts worktree deletions, and marks changed", async () => {
    const { dir } = makeRepo(["kept.ts", "gone.ts"]);
    const idx = new FileIndex();
    await idx.corpusGit(dir);
    idx.noteStatus(dir, [
      { path: "new.ts", status: "untracked" },
      { path: "gone.ts", status: "deleted" },
      { path: "kept.ts", status: "modified" },
    ]);
    const c = await idx.corpusGit(dir);
    assert.equal(c.pending, false);
    assert.ok(c.paths.includes("new.ts"), "untracked joined the corpus without any --others walk");
    assert.ok(!c.paths.includes("gone.ts"), "worktree-deleted no longer listed (it would 404 on open)");
    assert.ok(c.changed.has("kept.ts") && c.changed.has("new.ts"));
  });

  test("a snapshot arriving before the first query is kept — the panel calls changes() before anyone searches", async () => {
    const { dir } = makeRepo(["kept.ts"]);
    const idx = new FileIndex();
    idx.noteStatus(dir, [{ path: "new.ts", status: "untracked" }]);
    const c = await idx.corpusGit(dir);
    assert.equal(c.pending, false, "the pre-query snapshot must not be dropped");
    assert.ok(c.paths.includes("new.ts"));
    assert.ok(c.paths.includes("kept.ts"));
  });

  test("evicts the least-recently-used root beyond the cap", async () => {
    const repos = [makeRepo(["a.ts"]), makeRepo(["b.ts"]), makeRepo(["c.ts"]), makeRepo(["d.ts"])];
    const idx = new FileIndex();
    const first = await idx.corpusGit(repos[0].dir);
    for (const r of repos.slice(1)) await idx.corpusGit(r.dir);
    // Root 0 was evicted (cap is 3): asking again rebuilds rather than reusing.
    assert.notEqual(await idx.corpusGit(repos[0].dir), first);
  });
});

describe("FileIndex git corpus (edge cases)", () => {
  test("a merge conflict does not multi-list the conflicted file", async () => {
    const { dir, run } = makeRepo(["f.txt"]);
    run("checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(dir, "f.txt"), "side\n");
    run("commit", "-qam", "side");
    run("checkout", "-q", "main");
    fs.writeFileSync(path.join(dir, "f.txt"), "main\n");
    run("commit", "-qam", "main");
    try { run("merge", "side"); } catch { /* the conflict is the fixture */ }
    const c = await new FileIndex().corpusGit(dir);
    assert.deepEqual(c.paths.filter((p) => p === "f.txt"), ["f.txt"],
      "ls-files lists one entry per conflict stage; the corpus must not");
  });

  test("clear() drops cached roots", async () => {
    const { dir } = makeRepo(["a.ts"]);
    const idx = new FileIndex();
    const c1 = await idx.corpusGit(dir);
    idx.clear();
    assert.notEqual(await idx.corpusGit(dir), c1, "post-clear query rebuilds");
  });
});

describe("FileIndex walk corpus", () => {
  test("a tree deeper than the walk bound is flagged limited", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fw-"));
    // 9 nested levels: the file at the bottom sits past WALK_MAX_DEPTH (8).
    const deep = path.join(dir, ..."abcdefghi".split(""));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "buried.ts"), "x");
    fs.writeFileSync(path.join(dir, "top.ts"), "x");
    const c = await new FileIndex().corpusWalk(dir);
    assert.equal(c.limited, true);
    assert.ok(c.paths.includes("top.ts"));
    assert.ok(!c.paths.some((p) => p.endsWith("buried.ts")));
  });

  test("lists files under a non-git folder, honoring the ignore list and depth", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fw-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/a.ts"), "x");
    fs.writeFileSync(path.join(dir, "node_modules/x/b.js"), "x");
    const idx = new FileIndex();
    const c = await idx.corpusWalk(dir);
    assert.deepEqual(c.paths, ["src/a.ts"]);
    assert.equal(c.fromGit, false);
    assert.equal(c.pending, false);
  });

  test("caches within the TTL and re-walks after it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-fw-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "x");
    let clock = 0;
    const idx = new FileIndex(() => clock);
    const c1 = await idx.corpusWalk(dir);
    fs.writeFileSync(path.join(dir, "b.ts"), "x");
    clock = 10_000; // inside TTL: stale by design
    assert.equal(await idx.corpusWalk(dir), c1);
    clock = 40_000; // past TTL (30s): fresh walk sees b.ts
    const c2 = await idx.corpusWalk(dir);
    assert.ok(c2.paths.includes("b.ts"));
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: the standard single-file command with `src/file-index.test.ts`.
Expected: FAIL — cannot find module `./file-index.ts`.

- [ ] **Step 3: Implement `src/file-index.ts`**

```ts
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
      st.building ??= this.rebuildTracked(root, st).finally(() => { st!.building = null; });
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
```

- [ ] **Step 4: Run tests, verify they pass**

Standard single-file command with `src/file-index.test.ts`. Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/file-index.ts src/file-index.test.ts
git commit -m "feat: per-root file corpus cache with exact git-index invalidation"
```

---

### Task 4: Rewire `find()` and `changes()`; extend `FindResult`

**Files:**
- Modify: `src/workspace.ts` (`find()` at :541, `changes()` at :304, `FindResult` at :96; delete `gitFileList`, `rank`, old `walkFiles`, `FIND_IGNORE_DIRS`, `FIND_MAX_DEPTH`)
- Modify: `src/workspace.test.ts` (add a `find` describe-block)
- Test-gate: `src/workspace.routes.test.ts` must pass **unmodified**.

**Interfaces:**
- Consumes: `parseFindQuery`, `matchPath`, `TopK`, `compareRanked`, `RankedFile` (Task 1); `fileIndex` (Task 3).
- Produces (Task 5 depends on this exact shape):
  ```ts
  export interface FindResult {
    files: FoundFile[];
    truncated: boolean;   // more matches existed than were returned
    fromGit: boolean;
    total: number;        // every match seen, including beyond the K kept
    pending?: boolean;    // untracked half not indexed yet (first query in a repo)
    limited?: boolean;    // the corpus itself was capped (walk depth/size, MAX_INDEX_PATHS)
  }
  ```

- [ ] **Step 1: Add failing tests to `src/workspace.test.ts`**

Append this describe-block (it reuses the file's existing `makeRepo` fixture and imports; add `find` and `changes` to the import list if missing, plus `import { fileIndex } from "./file-index.ts";`):

```ts
describe("find", () => {
  test("fuzzy basename hits work, and substring hits always outrank them", async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "web/src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "web/src/filepanel.tsx"), "x");
    fs.writeFileSync(path.join(dir, "web/src/fip-appendix.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    fileIndex.clear();
    const fuzzy = await find(dir, dir, "fipa");
    assert.ok(fuzzy.files.some((f) => f.path === "web/src/filepanel.tsx"), "subsequence match found");
    // "fip" is a substring of fip-appendix and only a subsequence-prefix of filepanel:
    const sub = await find(dir, dir, "fip");
    assert.equal(sub.files[0].path, "web/src/fip-appendix.txt", "tier 1/2 beats tier 4");
    assert.equal(sub.total, sub.files.length);
  });

  test("results are ranked before the cap, not truncated alphabetically-first", async () => {
    const dir = makeRepo();
    // 250 alphabetically-early mid-path matches + 1 late basename match.
    for (let i = 0; i < 250; i++) {
      const p = path.join(dir, "aaa", `x${String(i).padStart(3, "0")}-hit.ts`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    }
    fs.mkdirSync(path.join(dir, "zzz"), { recursive: true });
    fs.writeFileSync(path.join(dir, "zzz/hit.ts"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    fileIndex.clear();
    const r = await find(dir, dir, "hit");
    assert.equal(r.truncated, true);
    assert.equal(r.total, 251);
    // The basename-prefix match must be present and first despite sorting last
    // alphabetically — the old code cut at 200 before ranking and lost it.
    assert.equal(r.files[0].path, "zzz/hit.ts");
  });

  test("changes() feeds the index: untracked files are findable with no --others walk", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "brand-new.ts"), "x");
    fileIndex.clear();
    const before = await find(dir, dir, "brand-new");
    assert.equal(before.pending, true, "no status snapshot yet");
    assert.equal(before.files.length, 0);
    await changes(dir); // the panel's own status run — this is the wiring under test
    const after = await find(dir, dir, "brand-new");
    assert.equal(after.pending, undefined);
    assert.deepEqual(after.files.map((f) => f.path), ["brand-new.ts"]);
  });

  test("searching from a subdirectory re-bases paths, same as before", async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "src/deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/deep/nested.ts"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    fileIndex.clear();
    const r = await find(dir, path.join(dir, "src"), "nested");
    assert.deepEqual(r.files.map((f) => f.path), ["deep/nested.ts"]);
    assert.equal(r.files[0].abs, path.join(dir, "src", "deep", "nested.ts"));
  });

  test("a non-git folder still finds files (walk corpus), flagged fromGit:false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpg-nongit-"));
    fs.mkdirSync(path.join(dir, "notes"));
    fs.writeFileSync(path.join(dir, "notes/idea.md"), "x");
    fileIndex.clear();
    const r = await find(dir, dir, "idea");
    assert.deepEqual(r.files.map((f) => f.path), ["notes/idea.md"]);
    assert.equal(r.fromGit, false);
  });
});
```

- [ ] **Step 2: Run tests, verify the new block fails**

Standard command with `src/workspace.test.ts`. Expected: FAIL (`find` has no `total`, untracked not served, ranking wrong).

- [ ] **Step 3: Rewrite `find()`, wire `changes()`, extend `FindResult`**

In `src/workspace.ts`:

1. `FindResult` (at :96) becomes the shape in **Interfaces** above (keep the existing comment about `fromGit`).
2. In `changes()` — immediately after `const parsed = parseStatusZ(status.stdout);` (:324) — add:
   ```ts
   // The full parse, before the MAX_CHANGED_FILES cut: the payload is capped for
   // display, but the search index wants every untracked path status found.
   fileIndex.noteStatus(root, parsed);
   ```
3. Replace `find()`, `rank()`, `gitFileList()`, `walkFiles()`, `FIND_IGNORE_DIRS`, `FIND_MAX_DEPTH` with:

```ts
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
  const corpus = root ? await fileIndex.corpusGit(root) : await fileIndex.corpusWalk(abs);

  // The corpus is rooted at the repo root, but the caller searches from `abs`
  // (a conversation can run in a subdirectory). Constrain and re-base here, in
  // memory — the old code asked git to scope the listing instead, which is why
  // paths were always answered relative to the search root. Keep that contract.
  let prefix = "";
  if (root) {
    const rel = toPosix(path.relative(root, abs));
    if (rel && rel !== "." && !rel.startsWith("..")) prefix = rel + "/";
  }

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
```

4. Imports: add `import { parseFindQuery, matchPath, TopK, compareRanked, type RankedFile } from "./fuzzy.ts";` and `import { fileIndex } from "./file-index.ts";`. Remove now-unused imports if any.

- [ ] **Step 4: Run the full server suite**

`npm test` — the new `find` block passes AND `workspace.routes.test.ts` passes untouched (dotfiles, `deep/`, ignored exclusion, basename-first ordering, empty query, subdir re-basing). If a routes assertion fails, the fix goes in fuzzy.ts/find(), never in the routes test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/workspace.ts src/workspace.test.ts
git commit -m "feat: find() on the corpus index — ranked top-K, fuzzy tiers, no --others"
```

---

### Task 5: Web — faster debounce, honest notes

**Files:**
- Modify: `web/src/lib/api.ts:222` (`FindResult` type)
- Modify: `web/src/components/FileTree.tsx` (debounce, meta state, notes)
- Modify: `web/src/components/FileTree.test.ts` (timing + mock shape)

**Interfaces:**
- Consumes: the Task-4 `FindResult` JSON shape.
- Produces: UI only.

- [ ] **Step 1: Update the test file first**

In `web/src/components/FileTree.test.ts`:
- Change the mock: `findWorkspaceFiles = vi.fn().mockResolvedValue({ files: [{ path: "src/app.ts", abs: "/repo/src/app.ts" }], truncated: false, fromGit: true, total: 1 });`
- Change `const settle = () => new Promise((r) => setTimeout(r, 220));` to `120` and update its comment: the debounce is now 60ms because a query costs a memory scan, not a git run.
- Add one test:

```ts
test("says when results are the top slice of a larger match set", async () => {
  findWorkspaceFiles.mockResolvedValue({
    files: [{ path: "src/app.ts", abs: "/repo/src/app.ts" }],
    truncated: true, fromGit: true, total: 4321,
  });
  await mount(); // use this suite's existing render helper + type-into-box pattern
  await typeQuery("app");
  await settle();
  expect(container.textContent).toContain("Showing the 1 best matches of 4321");
});
```
(Adapt `mount`/`typeQuery` to whatever helpers the suite already uses for the existing find-box tests — follow the surrounding tests' render/act pattern exactly.)

- [ ] **Step 2: Run web tests, verify the new one fails**

Run: `cd web && npx vitest run src/components/FileTree.test.ts`
Expected: the new test FAILS (old truncation copy), timing-adjusted old tests may fail too until the debounce changes.

- [ ] **Step 3: Implement the UI changes**

In `web/src/lib/api.ts`, replace the `FindResult` interface:
```ts
export interface FindResult {
  files: FoundFile[]; truncated: boolean; fromGit: boolean;
  total: number; pending?: boolean; limited?: boolean;
}
```

In `web/src/components/FileTree.tsx`:
- Debounce `160` → `60` in `Results`' effect (:136), updating the comment: the server answers from an in-memory index now; the debounce only coalesces keystrokes.
- Extend the meta state: `const [meta, setMeta] = useState<{ truncated: boolean; fromGit: boolean; total: number; pending?: boolean; limited?: boolean }>({ truncated: false, fromGit: false, total: 0 });`
- Replace the truncation note and add the two new ones at the bottom of `Results`' returned fragment:
```tsx
{meta.pending && (
  <div className="wf-note">New files are still being indexed — refresh the panel if something just written is missing.</div>
)}
{meta.limited && !meta.fromGit && (
  <div className="wf-note">This folder isn't a git checkout, so only part of it could be indexed.</div>
)}
{meta.truncated && (
  <div className="wf-note">Showing the {files.length} best matches of {meta.total}.</div>
)}
```
- Keep the existing empty-state `fromGit` hint (:146) unchanged.

- [ ] **Step 4: Run web tests, verify they pass**

`cd web && npx vitest run src/components/FileTree.test.ts` — PASS, all tests.

- [ ] **Step 5: Typecheck both trees and commit**

```bash
npm run typecheck
git add web/src/lib/api.ts web/src/components/FileTree.tsx web/src/components/FileTree.test.ts
git commit -m "feat(web): 60ms find debounce; top-K, pending and limited-index notes"
```

---

## Final verification (orchestrator runs after all tasks)

1. `npm run typecheck` && `npm test` && `cd web && npx vitest run` — all green.
2. Manual smoke on a real monorepo (e.g. `~/git/products`): first search returns in <200ms after warm-up; searching `service` reports "best matches of ~32k"; a file the agent just wrote appears after the turn ends without a manual refresh.
3. Grep for leftovers: `gitFileList`, `rank(`, `FIND_IGNORE_DIRS`, `FIND_MAX_DEPTH` must have no remaining references in `src/`.
