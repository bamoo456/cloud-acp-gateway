// Making an agent's HTML actually renderable.
//
// The panel renders an .html output in a sandboxed <iframe srcdoc>: allow-scripts,
// deliberately never allow-same-origin (see web/src/components/HtmlPreview.tsx).
// That gives the document an opaque origin, which is the whole security property
// — and it also means the document can fetch nothing at all, including the
// `png/*.png` sitting next to it on disk. So a generated mockup renders as a page
// of broken images, and downloading the single .html reproduces the same thing
// locally, because the assets were never in the file to begin with.
//
// An agent hits this wall hard, and expensively. Asked to make the mockup
// portable, the obvious move is to base64 the images into the HTML and write that
// out — but base64 is text, so it goes through the model's own output budget:
// 120KB of PNG became more than 100k tokens and could not be written at all.
// Those bytes never needed to pass through a model. They are on the same host as
// the gateway.
//
// So the gateway inlines them. Every relative reference is resolved against the
// document's own folder, passed through the caller's access gate — the same one
// every /workspace route uses — and replaced with a data: URI. Nothing about the
// sandbox changes, which is the point: its CSP already allows `img-src data:`,
// `font-src data:` and inline style, which is exactly what an inlined document
// needs and nothing more.
//
// Rewriting by pattern rather than by parsing HTML properly is a deliberate
// trade. This only ever substitutes attribute values it can see whole, and the
// cost of missing one is the broken image that was already there — a wrong
// document is not a possible outcome, so a parser would buy correctness nobody
// can observe.
import fs from "node:fs";
import path from "node:path";

// The document itself. Larger than the text preview's cap because a mockup with
// its images already inlined is a legitimate several-hundred-KB file, and
// truncating one turns "renders" into "renders half".
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
// One asset, and every asset together. An <iframe srcdoc> holds the whole
// document as a string in this page's memory, so the total is what matters.
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 6 * 1024 * 1024;

// Extension -> the type a data: URI must claim. Only what a document actually
// references: pictures, fonts, and stylesheets. Anything else is left alone
// rather than guessed at.
const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  // SVG is safe HERE and unsafe on /workspace/raw, for the same reason in
  // reverse: that route serves from the console's own origin, while this one
  // lands inside an opaque-origin sandbox where nothing it could execute can
  // reach the console. A mockup's icons are usually SVG, so refusing them would
  // be refusing the common case for a threat this context doesn't have.
  ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

export interface InlineResult {
  html: string;
  inlined: number;   // assets replaced with their bytes
  // References left as they were: outside what the access gate allows, missing on
  // disk, a type this doesn't inline, or past a cap. Surfaced because a preview
  // with holes in it must not read as the document being wrong.
  skipped: number;
  truncated: boolean; // a cap stopped the work, so `skipped` includes assets that would have fit
}

// Resolve a reference to an absolute path this request may read, or null. The
// gateway passes its own allowedPreviewPath — inlining must never widen what the
// panel can see, and a mockup that references ../../.ssh/id_rsa gets the same
// answer as a client asking for it directly.
export type ResolveAsset = (ref: string, baseDir: string) => Promise<string | null>;

// A reference this rewriter has no business touching: already inline, a remote
// URL, a fragment, or an empty attribute.
function isExternal(ref: string): boolean {
  const r = ref.trim();
  return !r || r.startsWith("#") || r.startsWith("data:") || r.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(r);
}

class Budget {
  spent = 0;
  inlined = 0;
  skipped = 0;
  truncated = false;
  // Assets are deduped by absolute path, so a spritesheet referenced forty times
  // is read once, counted once, and costs the budget once.
  private cache = new Map<string, string | null>();

  async load(abs: string): Promise<string | null> {
    const hit = this.cache.get(abs);
    if (hit !== undefined) return hit;
    const result = await this.read(abs);
    this.cache.set(abs, result);
    if (result) this.inlined++; else this.skipped++;
    return result;
  }

  private async read(abs: string): Promise<string | null> {
    const type = ASSET_TYPES[path.extname(abs).toLowerCase()];
    if (!type) return null;
    let st: fs.Stats;
    try { st = await fs.promises.stat(abs); } catch { return null; }
    if (!st.isFile()) return null;
    // Both caps set `truncated`, because both mean "this would have been inlined
    // if it fit" — which is a different thing to tell the reader than "this is a
    // remote URL we were never going to fetch".
    if (st.size > MAX_ASSET_BYTES) { this.truncated = true; return null; }
    // Base64 is 4 bytes of text per 3 bytes of file: charge the budget what the
    // document will actually carry, not what the file weighs.
    const cost = Math.ceil(st.size / 3) * 4;
    if (this.spent + cost > MAX_INLINE_TOTAL_BYTES) { this.truncated = true; return null; }
    let buf: Buffer;
    try { buf = await fs.promises.readFile(abs); } catch { return null; }
    this.spent += cost;
    return "data:" + type + ";base64," + buf.toString("base64");
  }
}

// Every `url(...)` in a stylesheet or a style attribute, rewritten against
// `baseDir` — which is the CSS file's own folder when the CSS came from a
// <link>, not the document's. Getting that wrong is how a stylesheet in css/
// looks for its images one directory too high.
async function inlineCssUrls(css: string, baseDir: string, resolve: ResolveAsset, budget: Budget): Promise<string> {
  const refs = new Map<string, string>();
  // Every reference is judged once, whether or not it worked: without this a
  // background image used on ten rules would be counted as ten skips.
  const seen = new Set<string>();
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const ref = m[2];
    if (isExternal(ref) || seen.has(ref)) continue;
    seen.add(ref);
    const abs = await resolve(ref, baseDir);
    if (!abs) { budget.skipped++; continue; }
    const data = await budget.load(abs);
    if (data) refs.set(ref, data);
  }
  if (!refs.size) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _q, ref: string) => {
    const data = refs.get(ref);
    return data ? "url(" + data + ")" : whole;
  });
}

// Tags whose `src` names something to draw or play. Deliberately not <script>:
// the sandbox's CSP allows inline script but not `script-src data:`, so a script
// turned into a data: URI would be blocked — a silently broken document in place
// of a visibly missing one. Those are counted as skipped instead.
const MEDIA_TAGS = /<(img|source|video|audio|embed|track|input)\b[^>]*>/gi;
const SRCS = /\s(src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const LINKS = /<link\b[^>]*>/gi;
const SCRIPT_SRC = /<script\b[^>]*\ssrc\s*=/gi;
// `srcset` is counted and never rewritten, for the same reason as scripts but a
// different mechanism: its value is a comma-separated candidate list, and a URL
// containing a comma would be split wrong. Rewriting it could produce a document
// that is WRONG rather than one that is merely missing a picture, which is the
// one outcome this file's approach is built to rule out.
const SRCSET = /\ssrcset\s*=\s*(?:"[^"]*"|'[^']*')/gi;

// Replace every `<link rel=stylesheet href=…>` with the stylesheet itself, its
// own url()s already inlined. An inline <style> rather than a data: URI href for
// the same CSP reason as scripts — `style-src 'unsafe-inline'` covers the element,
// nothing covers `style-src data:`.
async function inlineStylesheets(html: string, baseDir: string, resolve: ResolveAsset, budget: Budget): Promise<string> {
  const replacements = new Map<string, string>();
  for (const m of html.matchAll(LINKS)) {
    const tag = m[0];
    if (replacements.has(tag) || !/\srel\s*=\s*['"]?[^'">]*stylesheet/i.test(tag)) continue;
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const ref = href?.[1] ?? href?.[2] ?? "";
    if (!ref || isExternal(ref)) continue;
    const abs = await resolve(ref, baseDir);
    if (!abs || path.extname(abs).toLowerCase() !== ".css") { budget.skipped++; continue; }
    let css: string;
    try { css = await fs.promises.readFile(abs, "utf8"); } catch { budget.skipped++; continue; }
    if (css.length > MAX_ASSET_BYTES) { budget.skipped++; budget.truncated = true; continue; }
    const resolved = await inlineCssUrls(css, path.dirname(abs), resolve, budget);
    budget.inlined++;
    replacements.set(tag, "<style>\n" + resolved + "\n</style>");
  }
  let out = html;
  for (const [tag, style] of replacements) out = out.split(tag).join(style);
  return out;
}

async function inlineMedia(html: string, baseDir: string, resolve: ResolveAsset, budget: Budget): Promise<string> {
  const refs = new Map<string, string>();
  const seen = new Set<string>();
  for (const tag of html.matchAll(MEDIA_TAGS)) {
    for (const m of tag[0].matchAll(SRCS)) {
      const ref = m[2] ?? m[3] ?? "";
      if (isExternal(ref) || seen.has(ref)) continue;
      seen.add(ref);
      const abs = await resolve(ref, baseDir);
      if (!abs) { budget.skipped++; continue; }
      const data = await budget.load(abs);
      if (data) refs.set(ref, data);
    }
  }
  let out = html;
  if (refs.size) {
    out = out.replace(MEDIA_TAGS, (tag) => tag.replace(SRCS, (whole, attr: string, dq: string, sq: string) => {
      const data = refs.get(dq ?? sq ?? "");
      return data ? ` ${attr}="${data}"` : whole;
    }));
  }
  // Counted, never rewritten — see MEDIA_TAGS and SRCSET. Counting them is what
  // keeps the preview's own note honest: a reference nobody handled must show up
  // somewhere, or the gap reads as the document being broken.
  budget.skipped += [...out.matchAll(SCRIPT_SRC)].length + [...out.matchAll(SRCSET)].length;
  return out;
}

export async function inlineHtmlAssets(
  html: string, baseDir: string, resolve: ResolveAsset,
): Promise<InlineResult> {
  const budget = new Budget();
  let out = await inlineStylesheets(html, baseDir, resolve, budget);
  out = await inlineMedia(out, baseDir, resolve, budget);
  // Style attributes and <style> blocks, after the media pass so an inlined
  // stylesheet's urls are already data: and are not looked at twice.
  out = await inlineCssUrls(out, baseDir, resolve, budget);
  return { html: out, inlined: budget.inlined, skipped: budget.skipped, truncated: budget.truncated };
}

export interface HtmlRender extends InlineResult {
  // The document was cut at MAX_HTML_BYTES before anything was inlined, so the
  // preview is incomplete for a reason that has nothing to do with its assets.
  htmlTruncated: boolean;
}

// One .html file, ready to hand to a sandboxed iframe. Null when it isn't a
// readable file — the caller turns that into a 404, exactly as preview() does.
export async function renderHtmlFile(abs: string, resolve: ResolveAsset): Promise<HtmlRender | null> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(abs); } catch { return null; }
  if (!st.isFile()) return null;
  let raw: Buffer;
  try { raw = await fs.promises.readFile(abs); } catch { return null; }
  const htmlTruncated = raw.length > MAX_HTML_BYTES;
  const html = (htmlTruncated ? raw.subarray(0, MAX_HTML_BYTES) : raw).toString("utf8");
  const result = await inlineHtmlAssets(html, path.dirname(abs), resolve);
  return { ...result, htmlTruncated };
}
