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
