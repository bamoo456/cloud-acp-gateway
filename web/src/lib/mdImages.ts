import { rawFileUrl } from "./api.ts";

// Where a markdown image's `src` actually points.
//
// A previewed file is served as text from /workspace/file, so its images resolve
// against the CONSOLE's origin: `![](docs/shot.png)` in a README asks the gateway
// for /docs/shot.png and gets a 404. What the reader meant is the file next to
// the document, which is what /workspace/raw serves — the same route the image
// preview's own <img> uses, content-type allowlisted, and gated by the gateway's
// own path check (so an `![](/etc/passwd)` is refused there rather than trusted
// here). The HTML preview solves the same problem by inlining assets server-side
// (htmlinline.ts); markdown only needs the URL rewritten.

// Anything with a scheme, or protocol-relative — the browser's business, not
// ours: http(s), data:, mailto:, and any custom scheme a document might use.
export function isExternalSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

// POSIX-ish resolve, enough for a document's own relative links: "." and ".."
// collapse, everything else appends. Paths here come from the gateway, which
// speaks in forward slashes on every platform it runs on.
export function resolvePath(dir: string, rel: string): string {
  const out = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export interface ImageBase {
  // The folder the gateway resolves paths against — the conversation's, or the
  // one being browsed in Project mode.
  cwd: string;
  // The folder the document itself sits in, which is what its relative paths
  // are relative to.
  dir: string;
}

export function workspaceImageSrc(src: string, base: ImageBase): string {
  const raw = src.trim();
  if (!raw || isExternalSrc(raw) || raw.startsWith("#")) return src;
  // A ?v= or #fragment is addressing, not part of the filename — /workspace/raw
  // would look for a file with the query in its name.
  const path = raw.split(/[?#]/)[0];
  if (!path) return src;
  // A root-relative src in a document means the project's root, not the host's:
  // nobody writes `![](/Users/…)` in a README, and reading it as the filesystem
  // root would ask for a file the gateway refuses anyway.
  const abs = path.startsWith("/") ? resolvePath(base.cwd, path) : resolvePath(base.dir, path);
  return rawFileUrl(base.cwd, abs);
}
