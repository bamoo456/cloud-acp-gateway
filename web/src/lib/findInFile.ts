// Find-in-file for the viewer.
//
// Two things shape it. It searches the rendered block's CONCATENATED text
// rather than each element's own, so a match still lands when syntax
// highlighting has split the word across spans (`fo` + `<span>o</span>`). And
// it paints through the CSS Custom Highlight API instead of wrapping hits in
// <mark>: wrapping means rewriting the highlighted HTML on every keystroke, and
// FileContents renders a whole file as ONE text node precisely to avoid that
// kind of DOM churn.
//
// The API is Safari 17.2+ / Chrome 105+. An older engine gets a search that
// counts and scrolls but paints nothing — worth more than no search at all on
// the phone this exists for.

// A common word in a big file matches thousands of times, and every hit is a
// live Range the engine re-measures on layout. Nobody pages through 4,000.
// ponytail: hard cap; make it incremental if anyone actually hits it.
export const MAX_HITS = 500;

// Highlight names are per-caller because the registry is document-global: the
// file panel and the thread can be searched at the same time on a desktop
// layout, and one clearing or overwriting the other's highlights would leave
// the losing panel's matches unpainted. Each name needs its own ::highlight()
// rule in styles.css.
export const DEFAULT_HIGHLIGHT = "wf-find";

export function matchOffsets(text: string, query: string, cap = MAX_HITS): number[] {
  if (!query) return [];
  // A case-insensitive RegExp over the ORIGINAL text, not indexOf over a
  // lower-cased copy: toLowerCase() can change a string's length (İ → i̇), and
  // every offset past that point would then paint the wrong characters.
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const out: number[] = [];
  for (let m = re.exec(text); m && out.length < cap; m = re.exec(text)) out.push(m.index);
  return out;
}

export function findRanges(root: HTMLElement | null, query: string): Range[] {
  if (!root || !query) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let total = 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // A diff's line numbers are text like any other, so "12" would otherwise
    // light up the gutter of every hunk before it found a line of code.
    acceptNode: (n) =>
      n.parentElement?.closest(".gutter") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text;
    if (!t.data) continue;
    nodes.push(t);
    starts.push(total);
    total += t.data.length;
  }
  const text = nodes.map((n) => n.data).join("");
  return matchOffsets(text, query).map((at) => {
    const r = document.createRange();
    const [sn, so] = locate(nodes, starts, at);
    const [en, eo] = locate(nodes, starts, at + query.length);
    r.setStart(sn, so);
    r.setEnd(en, eo);
    return r;
  });
}

// Which text node a whole-block offset falls in. Binary search rather than a
// scan: a highlighted file is tens of thousands of nodes and this runs per hit.
function locate(nodes: Text[], starts: number[], offset: number): [Text, number] {
  let lo = 0, hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return [nodes[lo], Math.min(offset - starts[lo], nodes[lo].data.length)];
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
// Off globalThis rather than the bare `CSS` binding: on an engine without it
// that identifier is a ReferenceError, not undefined.
type Globals = { CSS?: { highlights?: Map<string, unknown> }; Highlight?: HighlightCtor };
const registry = () => (globalThis as unknown as Globals).CSS?.highlights;
const highlightCtor = () => (globalThis as unknown as Globals).Highlight;

export function paintHits(hits: Range[], index: number, name = DEFAULT_HIGHLIGHT): void {
  const reg = registry(), Ctor = highlightCtor();
  if (!reg || !Ctor) return;
  const current = hits[index];
  if (!current) { clearHits(name); return; }
  // The current hit is held out of the general set rather than layered over it:
  // two highlights covering the same range are painted in registration order,
  // so an overlapping "all" would win and the current match would look like
  // every other one.
  reg.set(name, new Ctor(...hits.filter((_, i) => i !== index)));
  reg.set(name + "-current", new Ctor(current));
}

// The registry is document-global — highlights left behind by a closed panel
// stay painted over whatever renders next.
export function clearHits(name = DEFAULT_HIGHLIGHT): void {
  const reg = registry();
  if (!reg) return;
  reg.delete(name);
  reg.delete(name + "-current");
}

// The viewer renders a file as a single text node, so scrollIntoView() on the
// match's parent would scroll to the top of the whole file. Measure the range
// itself and move the scrollers by the difference instead.
export function scrollToHit(box: HTMLElement | null, hit: Range | undefined): void {
  if (!box || !hit || typeof hit.getBoundingClientRect !== "function") return;
  const r = hit.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const b = box.getBoundingClientRect();
  box.scrollTop += r.top - b.top - b.height / 2 + r.height / 2;
  // Long lines scroll inside the <pre> (white-space: pre), not the panel, so a
  // match off the right edge needs the second scroller moved too.
  const pre = hit.startContainer.parentElement?.closest("pre");
  if (pre && pre.scrollWidth > pre.clientWidth) {
    const p = pre.getBoundingClientRect();
    pre.scrollLeft += r.left - p.left - p.width / 2;
  }
}
