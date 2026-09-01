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

// Images get their src rewritten before the HTML is built, not after it is in
// the DOM: an <img> inserted with the document's own relative path starts
// loading it immediately, so a post-pass would cost a 404 and a flash of a
// broken image on every picture in the file. `env` is markdown-it's own
// per-render channel, which is what makes this safe on a shared renderer.
interface MarkdownEnv { resolveSrc?: (src: string) => string }

const renderImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env: MarkdownEnv, self) => {
  const src = tokens[idx].attrGet("src");
  if (src && env?.resolveSrc) tokens[idx].attrSet("src", env.resolveSrc(src));
  return renderImage(tokens, idx, options, env, self);
};

// Every code block gets a copy button. It lives on a wrapper rather than inside
// the <pre> because .md pre scrolls (overflow: auto) — a button inside would
// scroll away with the code. Mermaid fences are left bare: lib/mermaid.ts
// matches "pre > code.language-mermaid" and replaces the <pre> with the drawn
// figure, which would strand a button pointing at nothing.
const COPY_SVG = '<svg class="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG = '<svg class="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

type Rule = NonNullable<MarkdownIt["renderer"]["rules"]["fence"]>;
const withCopy = (render: Rule): Rule => (tokens, idx, options, env, self) => {
  const html = render(tokens, idx, options, env, self);
  if (tokens[idx].info.trim().split(/\s+/)[0] === "mermaid") return html;
  return `<div class="md-pre">${html}<button type="button" class="msg-copy md-copy" title="Copy" aria-label="Copy code">${COPY_SVG}${CHECK_SVG}</button></div>`;
};
md.renderer.rules.fence = withCopy(md.renderer.rules.fence!);
md.renderer.rules.code_block = withCopy(md.renderer.rules.code_block!);

export function renderMarkdown(text: string, env?: MarkdownEnv): string {
  return md.render(text || "", env ?? {});
}
