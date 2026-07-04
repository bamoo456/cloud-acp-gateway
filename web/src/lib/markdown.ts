import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

// Same renderer the legacy console bundled (markdown-it + highlight.js). Output
// is dropped into a .md container; styles.css carries the .hljs-* token colors.

// highlight.js emits one <span> per token. A few large code blocks produce
// thousands of DOM nodes, and on a long conversation that node count made every
// keystroke-driven layout pass take >1s (measured: ~8.4k spans → 1.4s/keystroke;
// ~80 spans → 0ms). So only highlight blocks small enough to stay cheap; render
// larger blocks — and untagged blocks, since auto-detection brute-forces every
// grammar and is itself a per-render hot spot — as plain (escaped) text.
const MAX_HIGHLIGHT_CHARS = 800;

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(str, lang) {
    if (lang && str.length <= MAX_HIGHLIGHT_CHARS && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang }).value; } catch { /* fall through */ }
    }
    return ""; // plain text: markdown-it escapes and renders it without per-token spans
  },
});

export function renderMarkdown(text: string): string {
  return md.render(text || "");
}
