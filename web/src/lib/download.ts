// Saving a file must never become a top-level navigation.
//
// This console is not only a browser tab: it is also loaded inside a native
// WKWebView client. When WebKit is asked to navigate to a response it will not
// render as a page — an attachment, which is exactly what /workspace/raw
// returns for everything that isn't a plain raster image — it cancels the
// provisional load and reports WebKitErrorDomain 102, "frame load interrupted".
// A host app with no download delegate sees only a navigation that failed, and
// swaps the whole console for its own "can't reach gateway" screen. Tapping
// Download threw you out of the UI.
//
// So pull the bytes with fetch and hand them to a synthetic anchor over a
// blob: URL. The same-origin request still carries the console's Basic
// credentials, the top frame is never touched, and in a client that cannot save
// files at all the worst case is that nothing happens — not that the app tears
// the page down.
export async function downloadFile(url: string, filename: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Couldn't download this file.");
  saveBlob(await r.blob(), filename);
}

// Save text the client already holds. The HTML preview's "self-contained" save
// is this: the bytes came back as JSON with every asset inlined, so there is no
// URL to fetch — and going back to /workspace/raw for it would hand over exactly
// the copy whose relative image paths don't resolve anywhere else.
export function downloadText(text: string, type: string, filename: string): void {
  saveBlob(new Blob([text], { type }), filename);
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.rel = "noopener";
  // Anchors must be in the document for a synthetic click to be dispatched in
  // WebKit; Chromium tolerates a detached node, WebKit does not.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking is deferred, not skipped: dropping the object URL synchronously
  // can cancel the very save the click just started, while never revoking
  // pins the blob (up to the route's 25 MB cap) for the life of the page.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
