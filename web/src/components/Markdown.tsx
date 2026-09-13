import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import { copyText } from "../lib/clipboard.ts";
import { renderMermaid } from "../lib/mermaid.ts";
import { workspaceImageSrc, type ImageBase } from "../lib/mdImages.ts";
import { lookupRef, resolveRef, type ResolvedRef } from "../lib/codeRef.ts";
import { useStore } from "../store/store.ts";
import { Lightbox } from "./Lightbox.tsx";

// `diagrams` draws ```mermaid fences as diagrams. Opt-in, and only the file
// panel's Preview asks for it: a reply is rendered while it STREAMS, so half a
// diagram's source would arrive as a parse error every few tokens — the file
// being previewed is whole by the time anyone opens it.
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
    let alive = true;
    void renderMermaid(ref.current, () => alive);
    return () => { alive = false; };
  }, [text, diagrams]);

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
    for (const el of ref.current.querySelectorAll<HTMLElement>(".md-ref")) {
      const path = el.dataset.path ?? "";
      const hit = lookupRef(cwd, path);
      if (hit !== undefined) { markResolved(el, hit); continue; }
      void resolveRef(cwd, path).then((r) => { if (alive && el.isConnected) markResolved(el, r); });
    }
    return () => { alive = false; };
  }, [html, cwd, final]);
  const openRef = (el: HTMLElement) => {
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
    const link = (e.target as Element).closest?.(".md-ref.resolved");
    if (link) { openRef(link as HTMLElement); return; }
    const img = e.target as HTMLElement;
    if (!(img instanceof HTMLImageElement)) return;
    // A linked image is a link first: [![build](badge.svg)](https://ci/…) must
    // still go to the build, not open the badge.
    if (img.closest("a")) return;
    setZoom({ src: img.currentSrc || img.src, alt: img.alt || "Image" });
  };

  const keyed = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const link = (e.target as Element).closest?.(".md-ref.resolved");
    if (!link) return;
    e.preventDefault();
    openRef(link as HTMLElement);
  };
  return (
    <>
      <div className="md" ref={ref} onClick={clicked} onKeyDown={keyed} dangerouslySetInnerHTML={{ __html: html }} />
      {zoom && <Lightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </>
  );
}

// Only a resolved reference gets the affordance — an unresolved one is left as
// the plain text it arrived as, with nothing to suggest it can be opened.
function markResolved(el: HTMLElement, hit: ResolvedRef | null) {
  if (!hit) return;
  el.classList.add("resolved");
  el.setAttribute("role", "link");
  el.tabIndex = 0;
  el.title = hit.path;
  el.dataset.abs = hit.abs;
  el.dataset.display = hit.path;
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
    if (final) wrap.append(el("div", "acp-note", "Structured result couldn't be read — showing the raw reply"));
    return;
  }
  pre.hidden = true;
  wrap.append(card);
}

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
