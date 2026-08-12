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
    assert.ok(subsequenceScore("filepanel.tsx", "pane")! > subsequenceScore("filepanel.tsx", "fple")!);
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
