import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inlineHtmlAssets, renderHtmlFile, MAX_ASSET_BYTES, MAX_HTML_BYTES,
  type ResolveAsset,
} from "./htmlinline.ts";

// A mockup folder the way an agent leaves one: a page, a stylesheet in its own
// subfolder, and the images both of them reference by relative path.
function makeMockup(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-html-")));
  fs.mkdirSync(path.join(dir, "png"));
  fs.mkdirSync(path.join(dir, "css"));
  fs.writeFileSync(path.join(dir, "png", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, "png", "logo.png"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an asset\n");
  return dir;
}

// The gate the gateway passes in, in miniature: resolve against the referring
// file's folder, then refuse anything that climbed out of the mockup.
function gateFor(root: string): ResolveAsset {
  return async (ref, baseDir) => {
    const abs = path.resolve(baseDir, ref);
    return abs === root || abs.startsWith(root + path.sep) ? abs : null;
  };
}

describe("inlineHtmlAssets", () => {
  test("a relative image becomes a data: URI the sandbox can actually show", async () => {
    const dir = makeMockup();
    const r = await inlineHtmlAssets('<img src="png/shot.png">', dir, gateFor(dir));
    assert.equal(r.html, '<img src="data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") + '">');
    assert.equal(r.inlined, 1);
    assert.equal(r.skipped, 0);
  });

  test("a stylesheet is inlined, and its urls resolve against ITS folder, not the page's", async () => {
    const dir = makeMockup();
    // The bug this is here for: `../png/logo.png` from css/theme.css is
    // `png/logo.png` from the page. Resolving it against the document's folder
    // looks one directory too high and silently inlines nothing.
    fs.writeFileSync(path.join(dir, "css", "theme.css"), "body { background: url(../png/logo.png); }\n");
    const r = await inlineHtmlAssets('<link rel="stylesheet" href="css/theme.css">', dir, gateFor(dir));
    assert.match(r.html, /^<style>\s*body \{ background: url\(data:image\/png;base64,AQID\); \}/);
    assert.ok(!r.html.includes("<link"));
    assert.equal(r.skipped, 0);
  });

  test("a url() in the document's own <style> resolves against the document", async () => {
    const dir = makeMockup();
    const r = await inlineHtmlAssets("<style>.a { background: url('png/logo.png') }</style>", dir, gateFor(dir));
    assert.match(r.html, /url\(data:image\/png;base64,AQID\)/);
    assert.equal(r.inlined, 1);
  });

  test("remote, data: and fragment references are left exactly as they were", async () => {
    const dir = makeMockup();
    const html = '<img src="https://example.com/a.png"><img src="//cdn/b.png">'
      + '<img src="data:image/png;base64,AA=="><img src="#nope"><img src="">';
    const r = await inlineHtmlAssets(html, dir, gateFor(dir));
    assert.equal(r.html, html);
    assert.equal(r.inlined, 0);
    assert.equal(r.skipped, 0);
  });

  test("an external <script src> is counted, never rewritten", async () => {
    const dir = makeMockup();
    fs.writeFileSync(path.join(dir, "app.js"), "console.log(1);\n");
    const r = await inlineHtmlAssets('<script src="app.js"></script>', dir, gateFor(dir));
    // The preview's CSP allows inline script but not `script-src data:`, so a
    // data: URI here would be blocked — a silently broken page instead of a
    // visibly missing script.
    assert.equal(r.html, '<script src="app.js"></script>');
    assert.equal(r.skipped, 1);
  });

  test("a srcset is counted, never rewritten", async () => {
    const dir = makeMockup();
    const html = '<img src="png/logo.png" srcset="png/logo.png 1x, png/shot.png 2x">';
    const r = await inlineHtmlAssets(html, dir, gateFor(dir));
    // Its value is a comma-separated candidate list, so rewriting it risks a
    // WRONG document rather than a missing picture. `src` still gets inlined, so
    // the image shows; the count is what keeps the preview's note honest.
    assert.match(r.html, /srcset="png\/logo\.png 1x, png\/shot\.png 2x"/);
    assert.equal(r.skipped, 1);
    assert.equal(r.inlined, 1);
  });

  test("a reference the gate refuses stays a broken reference, and is counted", async () => {
    const dir = makeMockup();
    const r = await inlineHtmlAssets('<img src="../escape.png">', dir, gateFor(dir));
    assert.equal(r.html, '<img src="../escape.png">');
    assert.equal(r.inlined, 0);
    assert.equal(r.skipped, 1);
  });

  test("a type this doesn't inline is skipped rather than guessed at", async () => {
    const dir = makeMockup();
    const r = await inlineHtmlAssets('<img src="notes.txt">', dir, gateFor(dir));
    assert.equal(r.html, '<img src="notes.txt">');
    assert.equal(r.skipped, 1);
  });

  test("the same asset used many times is read, counted and charged once", async () => {
    const dir = makeMockup();
    const html = '<img src="png/logo.png"><img src="png/logo.png"><img src="png/logo.png">';
    const r = await inlineHtmlAssets(html, dir, gateFor(dir));
    assert.equal(r.inlined, 1);
    assert.equal(r.skipped, 0);
    assert.equal(r.html.match(/data:image\/png/g)?.length, 3);
  });

  test("an asset too large to inline says so rather than reading as a remote URL", async () => {
    const dir = makeMockup();
    fs.writeFileSync(path.join(dir, "png", "huge.png"), Buffer.alloc(MAX_ASSET_BYTES + 1));
    const r = await inlineHtmlAssets('<img src="png/huge.png"><img src="png/logo.png">', dir, gateFor(dir));
    assert.equal(r.truncated, true);
    assert.equal(r.skipped, 1);
    // The rest of the page still gets its images: one oversized asset is not a
    // reason to hand back a document with nothing inlined.
    assert.equal(r.inlined, 1);
  });

  test("a missing file behind a valid-looking reference is skipped, not an error", async () => {
    const dir = makeMockup();
    const r = await inlineHtmlAssets('<img src="png/gone.png">', dir, gateFor(dir));
    assert.equal(r.skipped, 1);
    assert.equal(r.html, '<img src="png/gone.png">');
  });
});

describe("renderHtmlFile", () => {
  test("reads the document and inlines what it references", async () => {
    const dir = makeMockup();
    const file = path.join(dir, "mockup.html");
    fs.writeFileSync(file, '<html><body><img src="png/shot.png"></body></html>');
    const r = await renderHtmlFile(file, gateFor(dir));
    assert.match(r!.html, /<img src="data:image\/png;base64,/);
    assert.equal(r!.inlined, 1);
    assert.equal(r!.htmlTruncated, false);
  });

  test("a document past the read cap is cut, and says which cap cut it", async () => {
    const dir = makeMockup();
    const file = path.join(dir, "big.html");
    fs.writeFileSync(file, "<p>" + "x".repeat(MAX_HTML_BYTES) + "</p>");
    const r = await renderHtmlFile(file, gateFor(dir));
    // htmlTruncated, not truncated: the document was too big to read, which is a
    // different thing to tell the reader than "its images were too big".
    assert.equal(r!.htmlTruncated, true);
    assert.equal(r!.truncated, false);
    assert.equal(r!.html.length, MAX_HTML_BYTES);
  });

  test("a directory or a missing path yields null (the route's 404)", async () => {
    const dir = makeMockup();
    assert.equal(await renderHtmlFile(dir, gateFor(dir)), null);
    assert.equal(await renderHtmlFile(path.join(dir, "nope.html"), gateFor(dir)), null);
  });
});
