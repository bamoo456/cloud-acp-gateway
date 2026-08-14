import { describe, test, expect, afterEach } from "vitest";
import { matchOffsets, findRanges, paintHits, clearHits, MAX_HITS } from "./findInFile.ts";

type Registry = Map<string, { ranges: Range[] }>;

function stubHighlights(): Registry {
  const reg: Registry = new Map();
  const g = globalThis as unknown as {
    CSS?: { highlights?: Registry };
    Highlight?: unknown;
  };
  g.CSS = { ...(g.CSS ?? {}), highlights: reg };
  g.Highlight = class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } };
  return reg;
}

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("matchOffsets", () => {
  test("finds every occurrence, ignoring case", () => {
    expect(matchOffsets("Foo bar foo FOO", "foo")).toEqual([0, 8, 12]);
  });

  test("the query is a literal, not a pattern", () => {
    // A path or a call site is the ordinary query here, and both are full of
    // regex metacharacters.
    expect(matchOffsets("a.b and axb", "a.b")).toEqual([0]);
    expect(matchOffsets("run(x) later", "run(x)")).toEqual([0]);
  });

  test("stops at the cap", () => {
    expect(matchOffsets("a".repeat(MAX_HITS + 50), "a")).toHaveLength(MAX_HITS);
    expect(matchOffsets("aaaa", "a", 2)).toHaveLength(2);
  });

  test("an empty query matches nothing rather than everything", () => {
    expect(matchOffsets("anything", "")).toEqual([]);
  });
});

describe("findRanges", () => {
  test("matches across the elements syntax highlighting leaves behind", () => {
    // The whole point of searching the concatenated text: hljs splits `foo`
    // into a keyword span and a bare text node, and a per-element search would
    // miss it entirely.
    const el = root(`<pre><code>const <span class="hljs-title">fo</span>o = 1; // FOO</code></pre>`);
    const hits = findRanges(el, "foo");

    expect(hits).toHaveLength(2);
    expect(hits[0].toString()).toBe("foo");
    expect(hits[1].toString()).toBe("FOO");
  });

  test("skips a diff's line numbers, so a number finds code", () => {
    const el = root(`<div class="udiff-row">
      <span class="gutter">12</span><span class="gutter">12</span>
      <span class="code">const port = 12;</span>
    </div>`);
    const hits = findRanges(el, "12");

    expect(hits).toHaveLength(1);
    expect(hits[0].startContainer.parentElement?.className).toBe("code");
  });

  test("no query and no root find nothing", () => {
    expect(findRanges(root("<pre>text</pre>"), "")).toEqual([]);
    expect(findRanges(null, "text")).toEqual([]);
  });
});

describe("paintHits", () => {
  test("the current hit is held out of the general set so it stays visible", () => {
    const reg = stubHighlights();
    const hits = findRanges(root(`<pre>foo foo foo</pre>`), "foo");

    paintHits(hits, 1);

    expect(reg.get("wf-find")?.ranges).toEqual([hits[0], hits[2]]);
    expect(reg.get("wf-find-current")?.ranges).toEqual([hits[1]]);
  });

  test("clearing leaves nothing painted over the next file", () => {
    const reg = stubHighlights();
    paintHits(findRanges(root(`<pre>foo</pre>`), "foo"), 0);
    expect(reg.size).toBe(2);

    clearHits();
    expect(reg.size).toBe(0);

    // An index past the end is the state between a new query and its rescan.
    paintHits([], 0);
    expect(reg.size).toBe(0);
  });
});
