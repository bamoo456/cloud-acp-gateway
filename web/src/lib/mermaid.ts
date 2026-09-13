// Mermaid diagrams in the markdown preview — a fenced ```mermaid block becomes
// the picture it describes.
//
// Two things are copied from Zed's preview deliberately:
//
//   Colours come from the reader's own theme, not from mermaid's defaults. Zed
//   builds a merman theme out of the editor theme for exactly this reason: a
//   diagram in mermaid's stock lavender on a dark page reads as a screenshot
//   someone pasted rather than as part of the document. Mermaid's "base" theme
//   derives its whole ramp from the variables below, so the four themes and both
//   colour schemes are covered by reading the tokens already on the page.
//
//   A diagram keeps its NATURAL size and the pane scrolls under it, rather than
//   being squeezed into the pane's width — Zed shipped that as a bug fix
//   (zed#61260), and it is the right call in a 440px panel where fitting a wide
//   flowchart means a picture OF a flowchart instead of one you can read. The
//   width part is the stylesheet's (.md-mermaid); this file only renders.
//
// mermaid is around a megabyte of JavaScript, so it is imported when the first
// diagram is actually opened and never in the app bundle.

// markdown-it renders a fence it cannot highlight as <pre><code class="language-X">
// (see renderMarkdown, whose highlight() returns "" for anything hljs doesn't
// know — mermaid included).
const BLOCK = "pre > code.language-mermaid";

export function mermaidBlocks(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(BLOCK)];
}

// Unique per document and stable across re-renders of one container. mermaid
// puts this in the SVG's id and in the ids of every marker inside it, so two
// diagrams sharing one would share arrowheads.
let seq = 0;

// The page's palette as mermaid's variables. Read off the element the diagram
// will sit in, so a container inside a differently-themed subtree gets that
// subtree's colours rather than the document's.
export function themeVariables(el: Element): Record<string, string> {
  const css = getComputedStyle(el);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const text = token("--text", "#1f1e1d");
  const surface = token("--surface", "#ffffff");
  const surface2 = token("--surface-2", "#f0efec");
  const border = token("--border-strong", token("--border", "#e7e5e0"));
  const muted = token("--muted", "#84827d");
  const accent = token("--accent", text);
  return {
    // The page itself, so a transparent diagram doesn't sit on white in dark mode.
    background: surface,
    // Nodes, and everything mermaid derives from them.
    primaryColor: surface2,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: surface,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: surface2,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    mainBkg: surface2,
    nodeBorder: border,
    nodeTextColor: text,
    // Edges and their labels. The label's background must be the page's, or a
    // line crossing behind it shows through the text.
    lineColor: muted,
    textColor: text,
    edgeLabelBackground: surface,
    // Clusters (a subgraph's box) sit UNDER their nodes, so they take the page
    // colour and the nodes keep the raised one.
    clusterBkg: surface,
    clusterBorder: border,
    titleColor: text,
    noteBkgColor: surface2,
    noteTextColor: text,
    noteBorderColor: border,
    // The accent earns the roles that mean "this one": a sequence diagram's
    // activation bar, a state diagram's transitions.
    activationBkgColor: accent,
    activationBorderColor: accent,
    fontFamily: token("--sans", "system-ui, sans-serif"),
    fontSize: "14px",
  };
}

// Undo mermaid's own fit-to-container sizing. It emits width="100%" with an
// inline `max-width: <natural>px`, which shrinks a wide diagram to whatever box
// it lands in — the panel is 440px, so that is the difference between a sequence
// diagram and a grey smudge. Sizing it from the viewBox instead makes the figure
// wider than the pane, which is what gives .md-mermaid something to scroll.
//
// Done here rather than through mermaid's `useMaxWidth: false`, which is a
// separate flag per diagram type: this is one rule and it covers the types
// nobody has drawn yet.
function naturalSize(svg: SVGSVGElement | null): void {
  if (!svg) return;
  const width = svg.viewBox?.baseVal?.width;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";
  // No viewBox (mermaid always writes one, but an error SVG may not): leave the
  // browser to size it rather than pinning it to 0.
  if (width) svg.style.width = width + "px";
}

// A drawn diagram and the source it was drawn from. The source is what
// flowchartNodes has to re-read to name the nodes, and it is not recoverable
// from the SVG — the fence it came from has been replaced by then.
export interface DrawnDiagram { figure: HTMLElement; src: string }

// The nodes a flowchart source declares, as the parser sees them: `id` is the
// identifier written in the source, `domId` the id the renderer will give the
// node's <g>. Null for anything that is not a flowchart — other diagram types
// reach the same unified renderer, but only the flowchart forms are the ones
// #290 scopes this to — and for a source that will not parse.
//
// Only meaningful after renderMermaid has run: mermaid.initialize is what
// registers the diagram types getDiagramFromText matches against.
export async function flowchartNodes(src: string): Promise<{ id: string; domId: string }[] | null> {
  try {
    const { default: mermaid } = await import("mermaid");
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(src);
    const db = diagram.db as { getData?: () => { nodes?: { id?: unknown; domId?: unknown }[] } };
    if (!diagram.type.startsWith("flowchart") || typeof db.getData !== "function") return null;
    const nodes = db.getData().nodes;
    if (!Array.isArray(nodes)) return null;
    // A subgraph comes back in the same list without a domId, so the shape is
    // the filter rather than the length.
    return nodes.flatMap((n) =>
      typeof n.id === "string" && typeof n.domId === "string" ? [{ id: n.id, domId: n.domId }] : []);
  } catch {
    return null;
  }
}

// Replace every mermaid fence under `root` with its diagram. `alive` is checked
// between diagrams: the container belongs to React, and a file switched while
// this was awaiting must not have last file's diagrams written into it.
export async function renderMermaid(root: HTMLElement, alive: () => boolean = () => true): Promise<DrawnDiagram[]> {
  const drawn: DrawnDiagram[] = [];
  const blocks = mermaidBlocks(root);
  if (!blocks.length) return drawn;
  const { default: mermaid } = await import("mermaid");
  if (!alive()) return drawn;
  mermaid.initialize({
    startOnLoad: false,
    // The source is a file being previewed, so it is not trusted to inject
    // markup or run script through a label.
    securityLevel: "strict",
    theme: "base",
    themeVariables: themeVariables(root),
  });
  for (const code of blocks) {
    const pre = code.parentElement;
    // Re-rendered under us, or already replaced: nothing to swap out.
    if (!alive() || !pre || !pre.isConnected) return drawn;
    const id = "mmd-" + ++seq;
    // textContent, not innerHTML: the fence's <, > and & are escaped in the
    // DOM and mermaid needs the source as it was written.
    const src = code.textContent ?? "";
    try {
      // Only the markup: render also hands back bindFunctions, the bridge that
      // wires a source's own `click` directives onto the drawn nodes. Calling it
      // would run whatever the agent wrote; what navigates here is the metadata
      // block instead (see Markdown.tsx).
      const { svg } = await mermaid.render(id, src);
      if (!alive() || !pre.isConnected) return drawn;
      const figure = document.createElement("div");
      figure.className = "md-mermaid";
      figure.innerHTML = svg;
      naturalSize(figure.querySelector("svg"));
      pre.replaceWith(figure);
      drawn.push({ figure, src });
    } catch (e) {
      // The block stays. A diagram that won't parse is still the text somebody
      // wrote, and an empty box says less than the source does — so say what
      // mermaid objected to and leave the code where it is.
      if (!pre.isConnected) return drawn;
      pre.classList.add("md-mermaid-failed");
      const note = document.createElement("div");
      note.className = "md-mermaid-error";
      note.textContent = "This diagram couldn't be drawn: " + (e instanceof Error ? e.message : String(e));
      pre.after(note);
      // mermaid parents its own error diagram to <body> on a failure and only
      // cleans up after a success. Left alone, every bad diagram leaves a
      // sketch of a bomb at the end of the page.
      document.getElementById(id)?.remove();
      document.getElementById("d" + id)?.remove();
    }
  }
  return drawn;
}
