// Browser bundle for rich chat markdown — markdown-it (CommonMark + GFM tables,
// lists, etc.) with highlight.js for fenced code. esbuild bundles this to
// public/vendor/md.js (IIFE), which console.html loads and calls via
// window.acpRenderMd. Kept out of console.html so the hand-rolled fallback there
// stays readable; if this script fails to load, console.html falls back to it.
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

const md = new MarkdownIt({
  html: false, // never trust agent output as raw HTML
  linkify: true, // auto-link bare URLs
  breaks: false, // proper markdown paragraphs (agent output uses blank lines)
  typographer: false, // do NOT smart-convert "--" → "–"; it would mangle CLI flags
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through */
      }
    }
    try {
      return hljs.highlightAuto(str).value;
    } catch {
      return "";
    }
  },
});

// Open links in a new tab (the console lives in an iframe-ish single page).
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

(window as unknown as { acpRenderMd: (t: string) => string }).acpRenderMd = (
  text: string,
) => md.render(String(text ?? ""));
