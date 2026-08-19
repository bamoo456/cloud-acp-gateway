import { describe, test, expect } from "vitest";
import { isExternalSrc, resolvePath, workspaceImageSrc } from "./mdImages.ts";
import { renderMarkdown } from "./markdown.ts";

const BASE = { cwd: "/repo", dir: "/repo/docs" };
const src = (s: string) => workspaceImageSrc(s, BASE);
// What rawFileUrl builds: the path it was handed, encoded.
const path = (url: string) => decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
const cwd = (url: string) => decodeURIComponent(new URL(url, "http://x").searchParams.get("cwd") ?? "");

describe("markdown image sources", () => {
  test("a path beside the document points at the file, not at the console", () => {
    const url = src("shot.png");
    expect(url).toContain("/workspace/raw");
    expect(path(url)).toBe("/repo/docs/shot.png");
    expect(cwd(url)).toBe("/repo");
  });

  test("climbs out of the document's folder", () => {
    expect(path(src("../assets/logo.svg"))).toBe("/repo/assets/logo.svg");
    expect(path(src("./sub/./a.png"))).toBe("/repo/docs/sub/a.png");
  });

  test("a root-relative path means the project, not the host", () => {
    // Nobody writes ![](/Users/…) in a README; they mean the repo's root.
    expect(path(src("/img/banner.png"))).toBe("/repo/img/banner.png");
  });

  test("the query and the fragment are addressing, not filename", () => {
    expect(path(src("shot.png?v=2"))).toBe("/repo/docs/shot.png");
    expect(path(src("shot.png#fig1"))).toBe("/repo/docs/shot.png");
  });

  test("anything with a scheme is left to the browser", () => {
    for (const external of [
      "https://example.com/a.png",
      "http://example.com/a.png",
      "//example.com/a.png",
      "data:image/png;base64,AAAA",
      "#anchor",
    ]) {
      expect(src(external)).toBe(external);
      if (external !== "#anchor") expect(isExternalSrc(external)).toBe(true);
    }
  });

  test("resolvePath keeps its answers absolute", () => {
    expect(resolvePath("/a/b", "../../c")).toBe("/c");
    // Climbing past the root stops there rather than producing "//" or "".
    expect(resolvePath("/a", "../../../x")).toBe("/x");
  });

  test("the renderer rewrites images and leaves links alone", () => {
    const html = renderMarkdown(
      "![shot](shot.png)\n\n[docs](guide.md)\n",
      { resolveSrc: (s) => workspaceImageSrc(s, BASE) },
    );
    expect(html).toContain("/workspace/raw");
    expect(html).toContain("path=%2Frepo%2Fdocs%2Fshot.png");
    // A link is where the reader goes, not something we serve bytes for.
    expect(html).toContain('href="guide.md"');
  });

  test("without a base, markdown renders exactly as it did before", () => {
    expect(renderMarkdown("![shot](shot.png)\n")).toContain('src="shot.png"');
  });
});
