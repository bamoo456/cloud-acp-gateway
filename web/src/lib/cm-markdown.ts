// CodeMirror extensions that make the composer render markdown *as you type*:
// the document stays plain markdown text (so the value we send the agent is
// unchanged), but bold/italic/inline-code/headings are styled inline and fenced
// code blocks get a dark background — the "live preview" look. Nothing here
// rewrites the document; it's all decoration over the source.

import { syntaxTree } from "@codemirror/language";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Extension, RangeSetBuilder } from "@codemirror/state";

// Inline token styling. Colors come from CSS variables (set in styles.css) so it
// tracks the active skin/theme rather than hard-coding hex here.
const highlightStyle = HighlightStyle.define([
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.monospace], class: "cm-md-code" },
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "800" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: [t.link, t.url], class: "cm-md-link" },
  { tag: [t.processingInstruction, t.meta], class: "cm-md-mark" },
  { tag: t.quote, class: "cm-md-quote" },
]);

// Fenced / indented code blocks: a background spanning the whole block (the dark
// "chip" from the design). Token styling can't paint a full-width block, so we
// add a line decoration to every line a code-block node covers.
const codeLine = Decoration.line({ class: "cm-md-codeblock" });

function buildCodeBlockDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            builder.add(line.from, line.from, codeLine);
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
        }
      },
    });
  }
  return builder.finish();
}

const codeBlockBackground = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildCodeBlockDeco(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildCodeBlockDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// The full bundle wired into the composer editor: the markdown language (parsing
// drives both the highlight tags and the code-block scan), inline highlighting,
// and the code-block background.
export function markdownRendering(): Extension {
  return [
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(highlightStyle),
    codeBlockBackground,
  ];
}
