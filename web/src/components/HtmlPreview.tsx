import { useMemo } from "react";
import { sandboxHtml } from "../lib/sandboxHtml.ts";

// A best-effort live render of a single-file HTML document — a mockup, a
// report, a small demo an agent wrote out. Fully sandboxed: allow-scripts
// only, deliberately never allow-same-origin, allow-forms, allow-popups,
// allow-top-navigation, allow-downloads or allow-modals. That alone gives the
// framed content an opaque origin with no access to this console's cookies,
// storage or session, and was verified empirically to block every outbound
// request it tried — same-origin and cross-origin, fetch and <img> alike. The
// injected CSP (sandboxHtml.ts) is defense-in-depth on top of that.
export function HtmlPreview({ html }: { html: string }) {
  const srcDoc = useMemo(() => sandboxHtml(html), [html]);
  return (
    <iframe
      className="wf-html-preview"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title="HTML preview"
    />
  );
}
