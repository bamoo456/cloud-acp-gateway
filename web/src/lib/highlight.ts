import hljs from "highlight.js";
import { basenameLower, extensionOf } from "./fileKind.ts";
import type { DiffRow } from "./unified-diff.ts";

// Syntax colour for the file preview and diff views — GitHub's own Light/Dark
// hljs theme, wired up in styles.css under .wf-hl. Extension -> hljs grammar
// id, scoped to the languages an agent actually writes (mirrors fileKind's
// BY_EXT) plus a few structured-data and doc formats worth colouring. hljs
// bundles every grammar these ids name; unknown extensions render as plain
// text, same as before this existed.
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", scala: "scala",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", dart: "dart", lua: "lua", r: "r",
  ex: "elixir", exs: "elixir", pl: "perl", m: "objectivec",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", css: "css", scss: "scss", less: "less", html: "xml", htm: "xml",
  json: "json", jsonl: "json", ndjson: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", xml: "xml",
  md: "markdown", markdown: "markdown", mdx: "markdown",
};
const NAME_TO_LANG: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile" };

export function highlightLanguageFor(name: string): string | undefined {
  const lang = NAME_TO_LANG[basenameLower(name)] ?? EXT_TO_LANG[extensionOf(name)];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

// highlight.js emits one <span> per token, and this DOM sits in the same
// document as any chat still streaming elsewhere on the page — the same cost
// markdown.ts's MAX_HIGHLIGHT_CHARS measured (~8.4k spans -> 1.4s per layout
// pass, ~80 spans -> 0ms; see that file). A char count alone is a poor proxy
// since token density varies by language, so this cheaply pre-filters input
// that's obviously too large, then measures the real span count and discards
// past that instead of guessing a single number is always safe.
const MAX_HIGHLIGHT_CHARS = 150_000;
const MAX_HIGHLIGHT_SPANS = 8_000;

// Returns highlighted HTML (hljs escapes all text, so it's safe to inject),
// or null when the language is unknown, the input is too large to colour
// cheaply, or highlighting fails outright — every null means "render `text`
// as plain text instead", never "render this HTML".
export function highlightBlock(text: string, lang: string): string | null {
  if (!text || text.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(lang)) return null;
  try {
    // ignoreIllegals: a diff hunk is a fragment of a file by definition, and a
    // full file's text can itself be cut at the preview's own byte cap — both
    // can land mid-construct, which hljs v11 throws on by default.
    const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    const spans = (html.match(/<span/g) ?? []).length;
    return spans > MAX_HIGHLIGHT_SPANS ? null : html;
  } catch {
    return null;
  }
}

// Splits hljs output back into per-line HTML fragments, closing every
// currently-open tag at each line break and reopening the same stack on the
// next line — so a token that spans lines (a block comment, a template
// string) still colours correctly on every line it touches, and each output
// line stays independently valid HTML. hljs only ever emits <span class="…">
// / </span> around escaped text (see HTMLRenderer in highlight.js/lib/core),
// so a text chunk never contains a literal "<".
function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  let current = "";
  const open: string[] = [];
  const tokenRe = /<span class="[^"]*">|<\/span>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    const tok = m[0];
    if (tok === "</span>") {
      current += tok;
      open.pop();
    } else if (tok[0] === "<") {
      current += tok;
      open.push(tok);
    } else {
      const parts = tok.split("\n");
      for (let i = 0; i < parts.length; i++) {
        current += parts[i];
        if (i < parts.length - 1) {
          current += "</span>".repeat(open.length);
          lines.push(current);
          current = open.join("");
        }
      }
    }
  }
  lines.push(current);
  return lines;
}

// Highlights `text` as `lang` and hands back one HTML fragment per line. Null
// covers everything highlightBlock already declines, plus the one extra way
// this can go wrong: the split not lining up 1:1 with the source lines. A
// mismatch would attribute tokens to the wrong line, which is worse than no
// colour at all, so this bails to plain text rather than risk it.
export function highlightLines(text: string, lang: string): string[] | null {
  const html = highlightBlock(text, lang);
  if (html == null) return null;
  const lines = splitHighlightedHtml(html);
  return lines.length === text.split("\n").length ? lines : null;
}

// One highlighted HTML fragment per diff row, or null for a row whose side
// couldn't be coloured. The old and new sides are highlighted as two whole
// blobs — every ctx/del line in source order for "old", every ctx/add line
// for "new" — so a token spanning lines keeps its state within a hunk, then
// each row picks its fragment out of whichever side it belongs to. A context
// line reads from the new side: highlighting only sees each hunk in
// isolation, and an edit just above a context line (opening a block comment,
// say) means the two sides aren't always token-identical even where the text
// is.
export function highlightDiffRows(rows: DiffRow[], lang: string): (string | null)[] {
  const oldLines = highlightLines(rows.filter((r) => r.t !== "add").map((r) => r.text).join("\n"), lang);
  const newLines = highlightLines(rows.filter((r) => r.t !== "del").map((r) => r.text).join("\n"), lang);
  const out: (string | null)[] = [];
  let oi = 0, ni = 0;
  for (const r of rows) {
    if (r.t === "del") out.push(oldLines?.[oi] ?? null);
    else out.push(newLines?.[ni] ?? null);
    if (r.t !== "add") oi++;
    if (r.t !== "del") ni++;
  }
  return out;
}
