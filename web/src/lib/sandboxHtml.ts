// Wraps arbitrary HTML text in a strict CSP before it's handed to a sandboxed
// <iframe srcdoc> (see HtmlPreview.tsx). The iframe's own sandbox="allow-scripts"
// (deliberately no allow-same-origin) is the real boundary — it gives the framed
// content an opaque origin with no access to this console's cookies, storage or
// session, and was verified empirically to block every outbound request it
// tried, same-origin and cross-origin, fetch and <img> alike. This CSP is
// defense-in-depth on top of that for engines where an opaque origin's network
// access isn't as tightly blocked.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

const HEAD_OPEN = /<head[^>]*>/i;
const HTML_OPEN = /<html[^>]*>/i;

// Inserts the CSP <meta> so it always lands inside a <head> — a meta CSP tag
// elsewhere in the document is not guaranteed to be honoured. Never prepend
// blindly: arbitrary/malformed HTML can't be trusted to already have a <head>
// in the right place, so this finds one (or makes one) instead.
export function sandboxHtml(html: string): string {
  const headMatch = HEAD_OPEN.exec(html);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + META + html.slice(at);
  }
  const htmlMatch = HTML_OPEN.exec(html);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, at) + "<head>" + META + "</head>" + html.slice(at);
  }
  return "<!DOCTYPE html><html><head>" + META + "</head><body>" + html + "</body></html>";
}
