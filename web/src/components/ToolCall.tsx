import { useState } from "react";
import type { ThreadItem } from "../types.ts";
import { useStore } from "../store/store.ts";
import { toLocalPath } from "../lib/touchedFiles.ts";
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
  const openFilePreview = useStore((s) => s.openFilePreview);
  // A path a tool reported is the most direct handle the thread has on a real
  // file, so make it the way into the preview panel: the card already says
  // "wrote src/x.ts", and this turns that into "show me src/x.ts". Remote URIs
  // (toLocalPath returns null) stay plain text — there is nothing to open.
  const fileLink = (raw: string, className: string, children: React.ReactNode) => {
    const local = toLocalPath(raw);
    if (!local) return <span className={className}>{children}</span>;
    return (
      <button type="button" className={className + " openable"} title={"Preview " + local}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openFilePreview({ abs: local }); }}>
        {children}
      </button>
    );
  };
  return (
    <details className="tool" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="ticon">{statusIcon(item.status, item.toolKind)}</span>
        <span className="ttitle">{item.title}</span>
        <span className={"tstatus " + item.status}>{item.status.replace(/_/g, " ")}</span>
      </summary>
      <div className="tbody">
        {item.locations.map((l, k) => <div key={"l" + k}>{fileLink(l, "loc", l)}</div>)}
        {item.content.map((c, k) => {
          if (c.type === "diff") return (
            <div className="tc-item" key={k}>
              <Diff path={c.path} oldText={c.oldText} newText={c.newText}
                renderPath={(p) => fileLink(p, "path", p)} />
            </div>
          );
          if (c.type === "terminal") return <div className="tc-item" key={k}><div className="loc">{"terminal " + (c.terminalId || "")}</div></div>;
          const inner = c.content || (c as any);
          if (inner && inner.type === "text") return <div className="tc-item" key={k}><Markdown text={inner.text || ""} /></div>;
          return <div className="tc-item" key={k}><div className="loc">{"[" + ((inner && inner.type) || "content") + "]"}</div></div>;
        })}
      </div>
    </details>
  );
}
