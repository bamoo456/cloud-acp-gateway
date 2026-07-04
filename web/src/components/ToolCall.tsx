import { useState } from "react";
import type { ThreadItem } from "../types.ts";
import { Markdown } from "./Markdown.tsx";
import { Diff } from "./Diff.tsx";
import { toolIcon, IconCheck, IconX, IconSpinner } from "../lib/icons.tsx";

type Tool = Extract<ThreadItem, { kind: "tool" }>;
function statusIcon(status: string, kind: string) {
  if (status === "completed") return <IconCheck />;
  if (status === "failed") return <IconX />;
  if (status === "in_progress" || status === "pending") return <IconSpinner />;
  return toolIcon(kind);
}
export function ToolCall({ item }: { item: Tool }) {
  const [open, setOpen] = useState(item.content.length > 0);
  return (
    <details className="tool" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="ticon">{statusIcon(item.status, item.toolKind)}</span>
        <span className="ttitle">{item.title}</span>
        <span className={"tstatus " + item.status}>{item.status.replace(/_/g, " ")}</span>
      </summary>
      <div className="tbody">
        {item.locations.map((l, k) => <div className="loc" key={"l" + k}>{l}</div>)}
        {item.content.map((c, k) => {
          if (c.type === "diff") return <div className="tc-item" key={k}><Diff path={c.path} oldText={c.oldText} newText={c.newText} /></div>;
          if (c.type === "terminal") return <div className="tc-item" key={k}><div className="loc">{"terminal " + (c.terminalId || "")}</div></div>;
          const inner = c.content || (c as any);
          if (inner && inner.type === "text") return <div className="tc-item" key={k}><Markdown text={inner.text || ""} /></div>;
          return <div className="tc-item" key={k}><div className="loc">{"[" + ((inner && inner.type) || "content") + "]"}</div></div>;
        })}
      </div>
    </details>
  );
}
