import { useEffect, useRef } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import { renderMermaid } from "../lib/mermaid.ts";

// `diagrams` draws ```mermaid fences as diagrams. Opt-in, and only the file
// panel's Preview asks for it: a reply is rendered while it STREAMS, so half a
// diagram's source would arrive as a parse error every few tokens — the file
// being previewed is whole by the time anyone opens it.
export function Markdown({ text, diagrams }: { text: string; diagrams?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!diagrams || !ref.current) return;
    let alive = true;
    void renderMermaid(ref.current, () => alive);
    return () => { alive = false; };
  }, [text, diagrams]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
