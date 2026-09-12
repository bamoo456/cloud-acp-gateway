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
export function Markdown({ text, diagrams, images, cwd }: {
  text: string; diagrams?: boolean; images?: ImageBase; cwd?: string;
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
    if (!cwd || !ref.current) return;
    let alive = true;
    for (const el of ref.current.querySelectorAll<HTMLElement>(".md-ref")) {
      const path = el.dataset.path ?? "";
      const hit = lookupRef(cwd, path);
      if (hit !== undefined) { markResolved(el, hit); continue; }
      void resolveRef(cwd, path).then((r) => { if (alive && el.isConnected) markResolved(el, r); });
    }
    return () => { alive = false; };
  }, [html, cwd]);
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
