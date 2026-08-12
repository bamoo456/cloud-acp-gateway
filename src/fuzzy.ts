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
