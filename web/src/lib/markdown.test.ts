import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown", () => {
  it("gives every code block a copy button", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```\n\n    indented\n");
    expect(html.match(/class="msg-copy md-copy"/g)).toHaveLength(2);
    expect(html).toContain('<div class="md-pre">');
  });

  // lib/mermaid.ts matches "pre > code.language-mermaid" and replaces the <pre>
  // with the rendered figure — a wrapper would strand the button behind it.
  it("leaves mermaid fences bare", () => {
    const html = renderMarkdown("```mermaid\ngraph TD;\n```");
    expect(html).toContain('<pre><code class="language-mermaid">');
    expect(html).not.toContain("md-copy");
  });
});

// Code references are marked at the token level (see the coderef rule): an
// inert span carrying the parsed location, and nothing that reads as a link
// until Markdown.tsx has had the gateway place it.
describe("renderMarkdown code references", () => {
  it("marks a path in prose with its location, and nothing else", () => {
    const html = renderMarkdown("see src/app.ts:12-14 and store.ts:41 and ./x/y.md, ../up.ts:3:7, /usr/lib/z.");
    expect(html).toContain('<span class="md-ref" data-path="src/app.ts" data-line="12" data-end="14">src/app.ts:12-14</span>');
    expect(html).toContain('<span class="md-ref" data-path="store.ts" data-line="41">store.ts:41</span>');
    expect(html).toContain('data-path="./x/y.md"');
    expect(html).toContain('data-path="../up.ts" data-line="3" data-col="7"');
    expect(html).toContain('data-path="/usr/lib/z"');
    expect(html).not.toMatch(/role=|tabindex=|href=|title=/);
  });

  // With a ccTLD on the end (.md is Moldova, .rs Serbia) linkify would read
  // the filename as a URL, which is why the rule runs ahead of it.
  it("claims a filename before linkify turns it into a URL, and leaves real URLs alone", () => {
    const html = renderMarkdown("README.md:12 and app.rs, then https://ex.com/a/b.ts:9");
    expect(html).toContain('data-path="README.md" data-line="12"');
    expect(html).toContain('data-path="app.rs"');
    expect(html).toContain('<a href="https://ex.com/a/b.ts:9">https://ex.com/a/b.ts:9</a>');
    expect(html.match(/md-ref/g)).toHaveLength(2);
  });

  // A bare domain is shaped like a bare filename; the rule gives linkify the
  // ones no source file could be named (see NAMED in lib/codeRef.ts).
  it("leaves e-mail addresses and domains to linkify", () => {
    const html = renderMarkdown("mail me@x.com, see github.com, socket.io, www.x.com/y.git and docs.example.com, then README.md");
    expect(html).toContain('<a href="mailto:me@x.com">me@x.com</a>');
    expect(html).toContain('<a href="http://github.com">github.com</a>');
    expect(html).toContain('<a href="http://socket.io">socket.io</a>');
    expect(html).toContain('<a href="http://www.x.com/y.git">www.x.com/y.git</a>');
    expect(html).toContain('<a href="http://docs.example.com">docs.example.com</a>');
    expect(html).toContain('<span class="md-ref" data-path="README.md">README.md</span>');
    expect(html.match(/md-ref/g)).toHaveLength(1);
  });

  it("marks inline code that is wholly a path, and a link to a line, but not a link to a document", () => {
    const html = renderMarkdown("`src/app.ts:3` `x = a.b` [label](src/app.ts:12) [l](app.ts:12) [docs](guide.md) [m](mailto:a@b.co) [ln](web/a.ts#L3-L5)");
    expect(html).toContain('<code class="md-ref" data-path="src/app.ts" data-line="3">src/app.ts:3</code>');
    expect(html).toContain("<code>x = a.b</code>");
    expect(html).toContain('<span class="md-ref" data-path="src/app.ts" data-line="12">label</span>');
    expect(html).toContain('<span class="md-ref" data-path="app.ts" data-line="12">l</span>');
    expect(html).toContain('<a href="guide.md">docs</a>');
    expect(html).toContain('<a href="mailto:a@b.co">m</a>');
    expect(html).toContain('<span class="md-ref" data-path="web/a.ts" data-line="3" data-end="5">ln</span>');
  });

  it("never reaches into fences, indented code or the text of a link", () => {
    const html = renderMarkdown("```\nsrc/app.ts:1\n```\n\n    src/app.ts:2\n\n[src/app.ts:3](https://ex.com)");
    expect(html).not.toContain("md-ref");
    expect(html).toContain('<a href="https://ex.com">src/app.ts:3</a>');
  });

  // Escapes are still separate tokens when the rule runs, so an escaped path
  // is left whole and the fragment beside the escape is not a filename.
  it("preserves markdown escaping around and inside a path", () => {
    const html = renderMarkdown("C:\\path and \\*no\\* and src/foo\\_bar.ts and a \\`x.ts\\` <b>tag</b>");
    expect(html).toContain("C:\\path and *no* and src/foo_bar.ts and a `x.ts` &lt;b&gt;tag&lt;/b&gt;");
    expect(html).not.toContain("md-ref");
  });
});
