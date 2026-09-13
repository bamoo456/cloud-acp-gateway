import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import { copyText } from "../lib/clipboard.ts";
import { flowchartNodes, renderMermaid, type DrawnDiagram } from "../lib/mermaid.ts";
import { workspaceImageSrc, type ImageBase } from "../lib/mdImages.ts";
import { lookupRef, resolveRef, type CodeRef, type ResolvedRef } from "../lib/codeRef.ts";
import { useStore } from "../store/store.ts";
import { Lightbox } from "./Lightbox.tsx";

// `diagrams` draws ```mermaid fences as diagrams. Opt-in, because a reply is
// rendered while it STREAMS and half a diagram's source arrives as a parse error
// every few tokens: the file panel's Preview has a whole file to start with, and
// the thread asks for it only once the turn has stopped (see `final`).
//
// `images` is the folder the document's own relative image paths are relative
// to. Without it they resolve against the console's origin, which is a 404 for
// every screenshot in a README (see lib/mdImages.ts).
//
// `cwd` is the folder the paths in this text were written FROM — the session
// that produced the answer, not whichever one is active now. Without it the
// code references stay plain text.
//
// `final` says the turn has stopped writing. A structured result becomes a card
// the moment its JSON parses, streamed or not; what `final` gates is the
// admission that it never will — half a JSON object is a block still arriving,
// not a broken one.
export function Markdown({ text, diagrams, images, cwd, final }: {
  text: string; diagrams?: boolean; images?: ImageBase; cwd?: string; final?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!diagrams || !ref.current) return;
    const host = ref.current;
    let alive = true;
    const mounted = () => alive;
    void renderMermaid(host, mounted).then((drawn) => {
      // Not gated on `drawn`: a diagram that would not draw still has metadata
      // to list, and that list is all the navigation left.
      if (alive) void linkDiagrams(host, drawn, cwd, final === true, mounted);
    });
    return () => { alive = false; };
  }, [text, diagrams, cwd, final]);

  const html = renderMarkdown(text, images ? { resolveSrc: (src) => workspaceImageSrc(src, images) } : undefined);

  // The marks markdown.ts left are inert until the gateway has said which file
  // each one is. A layout effect, keyed on the HTML: every streamed chunk
  // re-sets innerHTML and so drops the attributes added here, and the cache
  // in lib/codeRef.ts puts them back before that frame paints.
  const openFilePreview = useStore((s) => s.openFilePreview);
  useLayoutEffect(() => {
    if (!ref.current) return;
    // Cards first: the references they hold are resolved by the same loop.
    for (const block of ref.current.querySelectorAll<HTMLElement>(".acp-block")) renderAcpBlock(block, final === true);
    if (!cwd) return;
    let alive = true;
    hydrateRefs(ref.current.querySelectorAll<HTMLElement>(".md-ref"), cwd, () => alive);
    return () => { alive = false; };
  }, [html, cwd, final]);
  const openRef = (el: RefEl) => {
    // "file", never the default "diff": a path in prose is the file as it is
    // now, and a diff view would present that line as a historical location.
    openFilePreview({
      abs: el.dataset.abs ?? "", path: el.dataset.display, mode: "file", cwd,
      line: Number(el.dataset.line) || undefined, endLine: Number(el.dataset.end) || undefined,
    });
  };

  // A picture in a document is a picture you want to look at, and in a 440px
  // column it arrives shrunk to fit (see .md img). Delegated rather than a
  // handler per image: the HTML is set as a string, so there is nothing to
  // attach one to.
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const clicked = (e: React.MouseEvent) => {
    // The per-code-block copy button (markdown.ts injects it into the HTML, so
    // it is delegated here for the same reason the images are).
    // ponytail: the ✓ is toggled imperatively, so a chunk arriving mid-stream
    // wipes it — only matters if you copy a block while it is still being
    // written. Lift it into state if that ever bites.
    const btn = (e.target as Element).closest?.(".md-copy");
    if (btn) {
      void copyCode(btn as HTMLButtonElement);
      return;
    }
    const link = (e.target as Element).closest?.(NAVIGABLE);
    if (link) { openRef(link as RefEl); return; }
    const img = e.target as HTMLElement;
    if (!(img instanceof HTMLImageElement)) return;
    // A linked image is a link first: [![build](badge.svg)](https://ci/…) must
    // still go to the build, not open the badge.
    if (img.closest("a")) return;
    setZoom({ src: img.currentSrc || img.src, alt: img.alt || "Image" });
  };

  const keyed = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const link = (e.target as Element).closest?.(NAVIGABLE);
    if (!link) return;
    e.preventDefault();
    openRef(link as RefEl);
  };
  return (
    <>
      <div className="md" ref={ref} onClick={clicked} onKeyDown={keyed} dangerouslySetInnerHTML={{ __html: html }} />
      {zoom && <Lightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </>
  );
}

// A reference in prose, in a card, or on a diagram node: the same marks, read
// back the same way by openRef. A <g> is not an HTMLElement, which is why role,
// tabindex and title are set as attributes — the properties are HTML's alone.
type RefEl = HTMLElement | SVGElement;
const NAVIGABLE = ".md-ref.resolved, .acp-node.resolved";

// Only a resolved reference gets the affordance — an unresolved one is left as
// the plain text it arrived as, with nothing to suggest it can be opened.
function markResolved(el: RefEl, hit: ResolvedRef | null) {
  if (!hit) return;
  el.classList.add("resolved");
  el.setAttribute("role", "link");
  el.setAttribute("tabindex", "0");
  el.setAttribute("title", hit.path);
  el.dataset.abs = hit.abs;
  el.dataset.display = hit.path;
}

// Ask the gateway which file each marked reference is, off the cache in
// lib/codeRef.ts. `alive` is a callback rather than a flag because the diagram
// pass reaches here several awaits after the effect that started it.
function hydrateRefs(els: Iterable<RefEl>, cwd: string, alive: () => boolean) {
  for (const mark of els) {
    const path = mark.dataset.path ?? "";
    const hit = lookupRef(cwd, path);
    if (hit !== undefined) { markResolved(mark, hit); continue; }
    void resolveRef(cwd, path).then((r) => { if (alive() && mark.isConnected) markResolved(mark, r); });
  }
}

// A trace or a review guide (markdown.ts marked the wrapper) drawn as the card
// a tool call gets — the same frame, because it is the same kind of object: a
// machine-produced result you fold away once you have read it. The raw <pre> is
// hidden rather than removed: copyCode reads the <code> inside this wrapper.
function renderAcpBlock(wrap: HTMLElement, final: boolean) {
  if (wrap.querySelector(".acp-result, .acp-note")) return;
  const pre = wrap.querySelector("pre");
  if (!pre) return;
  const card = acpCard(wrap.dataset.kind === "guide" ? "guide" : "trace", pre.textContent ?? "");
  if (!card) {
    if (final) wrap.append(el("div", "acp-note", UNREADABLE));
    return;
  }
  pre.hidden = true;
  wrap.append(card);
}

// Said once, for a card and for a diagram's metadata alike.
const UNREADABLE = "Structured result couldn't be read — showing the raw reply";

const TRACE_SECTIONS: [string, string][] = [
  ["definition", "Definition"], ["callers", "Callers"], ["callees", "Callees"], ["references", "References"],
];

function acpCard(kind: "trace" | "guide", raw: string): HTMLElement | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  const body = el("div", "tbody");
  if (kind === "trace") {
    for (const [key, heading] of TRACE_SECTIONS) {
      const items = asArray(data[key]).map((it) => acpItem(it, "div")).filter(Boolean) as HTMLElement[];
      if (!items.length) continue;
      const section = el("div", "tc-item", undefined, el("div", "loc", heading), ...items);
      body.append(section);
    }
    const notes = asString(data.notes);
    if (notes) body.append(el("div", "tc-item", notes));
  } else {
    const steps = asArray(data.steps).map((s) => acpItem(s, "li")).filter(Boolean) as HTMLElement[];
    if (!steps.length) return null;
    body.append(el("div", "tc-item", undefined, el("ol", undefined, undefined, ...steps)));
  }
  if (!body.childElementCount) return null;
  const card = el("details", "tool acp-result") as HTMLDetailsElement;
  card.open = true;
  card.append(
    el("summary", undefined, undefined,
      el("span", "tkind", kind),
      el("span", "ttitle", asString(kind === "trace" ? data.symbol : data.title))),
    body,
  );
  return card;
}

// One navigable item. No path is no reference: the agent was told to supply one
// for everything it wants opened, so an item without it stays the explanatory
// text it is, rather than becoming a link to a file nobody named.
function acpItem(raw: unknown, tag: "div" | "li"): HTMLElement | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  const path = asString(it.path), label = asString(it.label), why = asString(it.why);
  const line = asLine(it.line), end = asLine(it.endLine);
  const row = el(tag, "acp-item");
  if (path) {
    const loc = path + (line ? ":" + line : "");
    const span = el("span", "md-ref", label ? `${label} · ${loc}` : loc);
    span.dataset.path = path;
    if (line) span.dataset.line = String(line);
    if (end) span.dataset.end = String(end);
    row.append(span);
  } else if (label) {
    row.append(el("span", undefined, label));
  }
  if (why) row.append(el("span", "acp-why", row.childElementCount ? " — " + why : why));
  return row.childElementCount ? row : null;
}

// A drawn diagram and the metadata block that follows it. reviewPrompt.ts asks
// for the two in that order, and agents write prose in between, so the pair is
// "the next metadata block before the next diagram" rather than the next
// sibling. Everything is recomputed from the freshly drawn figures: a re-render
// replaces them, and nothing here closes over the mapping it read last time.
async function linkDiagrams(host: HTMLElement, drawn: DrawnDiagram[], cwd: string | undefined, final: boolean, alive: () => boolean) {
  const source = new Map(drawn.map((d) => [d.figure, d.src]));
  // A diagram that failed to draw is in the walk too: it has no nodes to map, but
  // it still owns its metadata — and it must stand between that metadata and the
  // figure before it rather than let the two pair up.
  const parts = [...host.querySelectorAll<HTMLElement>(".md-mermaid, .md-mermaid-failed, .acp-nodes")];
  for (let i = 0; i < parts.length; i++) {
    const figure = parts[i], meta = parts[i + 1];
    const src = source.get(figure);
    // A figure this pass did not draw is either one that failed — which still
    // gets its reference list, minus the nodes — or one drawn by an earlier
    // pass, which has its list already.
    if (src === undefined && !figure.classList.contains("md-mermaid-failed")) continue;
    if (!meta?.classList.contains("acp-nodes") || meta.dataset.linked) continue;
    meta.dataset.linked = "1";
    const refs = nodeRefs(meta.dataset.json ?? "");
    if (!refs) {
      // The picture still stands; what is lost is only the navigation. The block
      // it came with is unhidden so the reply is still all there.
      if (final) { meta.hidden = false; meta.after(el("div", "acp-note", UNREADABLE)); }
      continue;
    }
    const nodes = src === undefined ? null : await flowchartNodes(src);
    if (!alive() || !figure.isConnected) return;
    const marks: RefEl[] = [];
    for (const node of nodes ?? []) {
      const ref = refs.get(node.id);
      if (!ref) continue;
      const g = nodeElement(figure, node.domId);
      if (!g) continue;
      g.classList.add("acp-node");
      g.dataset.path = ref.path;
      if (ref.line) g.dataset.line = String(ref.line);
      if (ref.endLine) g.dataset.end = String(ref.endLine);
      marks.push(g);
    }
    // Every mapping listed under the figure, whether its node was matched or
    // not: the node match is best-effort, and this list is the part that always
    // navigates.
    const rows = [...refs.values()].map((ref) => acpItem(ref, "div")).filter((row): row is HTMLElement => !!row);
    const list = el("div", "acp-node-list", undefined, el("div", "loc", "References"), ...rows);
    if (rows.length) {
      // Under the diagram, or under the note standing in for the one that failed.
      const error = figure.nextElementSibling;
      (error?.classList.contains("md-mermaid-error") ? error : figure).after(list);
      marks.push(...list.querySelectorAll<HTMLElement>(".md-ref"));
    }
    if (cwd) hydrateRefs(marks, cwd, alive);
  }
  // Metadata that never found a diagram — written before its picture, or beside
  // a fence mermaid never drew. markdown.ts hides every acp-nodes block, so
  // leaving it alone drops that part of the reply out of sight entirely.
  if (!final) return;
  for (const meta of host.querySelectorAll<HTMLElement>(".acp-nodes:not([data-linked])")) {
    meta.dataset.linked = "1";
    meta.hidden = false;
    meta.after(el("div", "acp-note", UNREADABLE));
  }
}

// getData() names a node with the id the parser gave it; the renderer writes
// that id onto the <g> behind the diagram's own render prefix. So the match is
// on the suffix, and never on a label — a label is agent text, and one that
// happens to read like a path would otherwise become a link to a file nobody
// mapped.
function nodeElement(figure: HTMLElement, domId: string): SVGElement | null {
  for (const g of figure.querySelectorAll<SVGElement>("g.node[id]")) {
    if (g.id === domId || g.id.endsWith("-" + domId)) return g;
  }
  return null;
}

// The metadata a diagram was sent with: { "<node id in the source>": ref }.
// Null when it cannot be read, which includes a mapping holding nothing anyone
// could open — an empty mapping is a result that never arrived rather than a
// diagram deliberately left unlinked.
function nodeRefs(json: string): Map<string, CodeRef> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = new Map<string, CodeRef>();
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const path = asString(entry.path);
    if (!path) continue;
    const ref: CodeRef = { path };
    const label = asString(entry.label), line = asLine(entry.line), end = asLine(entry.endLine);
    if (label) ref.label = label;
    if (line) ref.line = line;
    if (end) ref.endLine = end;
    out.set(id, ref);
  }
  return out.size ? out : null;
}

const asString = (v: unknown) => (typeof v === "string" ? v : "");
const asArray = (v: unknown) => (Array.isArray(v) ? v : []);
const asLine = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);

function el(tag: string, className?: string, text?: string, ...children: HTMLElement[]): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  node.append(...children);
  return node;
}

async function copyCode(btn: HTMLButtonElement) {
  const code = btn.parentElement?.querySelector("code")?.textContent ?? "";
  if (!code || !(await copyText(code))) return;
  btn.classList.add("copied");
  setLabel(btn, "Copied");
  setTimeout(() => {
    btn.classList.remove("copied");
    setLabel(btn, "Copy code");
  }, 1500);
}

function setLabel(btn: HTMLButtonElement, label: string) {
  btn.title = label;
  btn.setAttribute("aria-label", label);
}
