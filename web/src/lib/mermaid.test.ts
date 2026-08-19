import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mermaidBlocks, themeVariables, renderMermaid } from "./mermaid.ts";
import { renderMarkdown } from "./markdown.ts";

const container = (markdown: string) => {
  const el = document.createElement("div");
  el.className = "md";
  el.innerHTML = renderMarkdown(markdown);
  document.body.appendChild(el);
  return el;
};

describe("mermaid diagrams in markdown", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => { document.body.innerHTML = ""; });

  test("finds mermaid fences and nothing else", () => {
    const el = container([
      "```mermaid", "graph TD;", "  A-->B;", "```", "",
      "```ts", "const a = 1;", "```", "",
      "```", "plain", "```",
    ].join("\n"));
    const blocks = mermaidBlocks(el);
    expect(blocks.length).toBe(1);
    // The source as written, not as escaped into the DOM — mermaid needs the
    // arrow back.
    expect(blocks[0].textContent).toContain("A-->B");
  });

  test("takes its colours from the page's own tokens", () => {
    const el = document.createElement("div");
    el.style.setProperty("--surface", "#101010");
    el.style.setProperty("--surface-2", "#202020");
    el.style.setProperty("--text", "#fafafa");
    el.style.setProperty("--muted", "#909090");
    el.style.setProperty("--border-strong", "#303030");
    document.body.appendChild(el);

    const v = themeVariables(el);
    expect(v.background).toBe("#101010");
    expect(v.mainBkg).toBe("#202020");
    expect(v.primaryTextColor).toBe("#fafafa");
    expect(v.lineColor).toBe("#909090");
    expect(v.nodeBorder).toBe("#303030");
    // A cluster sits under its nodes, so it must not share their colour.
    expect(v.clusterBkg).toBe("#101010");
  });

  test("a token the theme doesn't define falls back rather than emitting ''", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // jsdom applies no stylesheet, so every token here is undefined — which is
    // also what an older theme missing a token looks like. An empty string would
    // reach mermaid as a colour and paint the diagram black.
    for (const value of Object.values(themeVariables(el))) expect(value).not.toBe("");
  });

  // jsdom has no SVG text metrics (getBBox), so mermaid cannot lay a diagram out
  // here at all: this is the only half of the render that IS testable without a
  // browser — and it is the half that has to hold for a malformed diagram too.
  test("a diagram that won't draw keeps its source and says why", async () => {
    const el = container(["```mermaid", "not a diagram at all {{{", "```"].join("\n"));
    await renderMermaid(el);

    // The code block is still there — an empty box says less than the source.
    expect(el.querySelector("pre")).not.toBeNull();
    expect(el.querySelector("pre")?.className).toContain("md-mermaid-failed");
    expect(el.querySelector(".md-mermaid-error")?.textContent).toContain("couldn't be drawn");
    // mermaid parents its own error drawing to <body> and only cleans up after a
    // success: nothing of ours may be left outside the container.
    expect([...document.body.children].filter((c) => c !== el)).toEqual([]);
  });

  test("a container with no diagram never loads mermaid", async () => {
    const el = container("# just a heading\n\n```ts\nconst a = 1;\n```\n");
    const before = el.innerHTML;
    await renderMermaid(el);
    expect(el.innerHTML).toBe(before);
  });
});
