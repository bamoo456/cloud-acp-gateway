import { useState } from "react";
import type { ThreadItem } from "../types.ts";
import { useStore } from "../store/store.ts";
import { toLocalPath, isWritingKind } from "../lib/touchedFiles.ts";
import { Markdown } from "./Markdown.tsx";
import { Diff } from "./Diff.tsx";
import { FileCard } from "./FileCard.tsx";
import { IconX, IconSpinner } from "../lib/icons.tsx";

type Tool = Extract<ThreadItem, { kind: "tool" }>;
// A completed call is silent (§1.1): no tick, no badge, no colour — the card
// itself is the record that the agent did this. Only "still running" and
// "failed" have anything left to say.
function statusIcon(status: string) {
  if (status === "failed") return <IconX />;
  if (status === "in_progress" || status === "pending") return <IconSpinner />;
  return null;
}
export function ToolCall({ item }: { item: Tool }) {
  const [open, setOpen] = useState(item.content.length > 0);
  const openFilePreview = useStore((s) => s.openFilePreview);
  // A file the agent WROTE gets a card — the produced thing, with its type and
  // a way to save it. A file it merely read stays one line of path: turning a
  // turn's twenty reads into twenty cards would bury the one file it wrote.
  const produced = isWritingKind(item.toolKind);
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
  // A tool that edits reports the SAME file twice: claude-agent-acp's Edit and
  // Write each send `locations: [{path}]` and a diff block carrying that path.
  // Rendering both would put a card above a diff header pointing at the same
  // file, so the diff block wins — it gets the card as its own header — and the
  // location that duplicates it is dropped.
  const diffPaths = new Set(
    item.content.flatMap((c) => (c.type === "diff" ? [toLocalPath(c.path ?? "")] : [])).filter(Boolean),
  );
  // A location renders as a card when the tool wrote it and it is a real local
  // path; otherwise it falls back to the openable (or plain) path row.
  const renderLocation = (raw: string) => {
    const local = produced ? toLocalPath(raw) : null;
    return local ? <FileCard path={local} /> : fileLink(raw, "loc", raw);
  };
  const icon = statusIcon(item.status);
  return (
    <details className="tool" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        {icon && <span className="ticon">{icon}</span>}
        <span className="tkind">{item.toolKind || "tool"}</span>
        <span className="ttitle">{item.title}</span>
        <span className={"tstatus " + item.status}>{item.status.replace(/_/g, " ")}</span>
      </summary>
      <div className="tbody">
        {item.locations
          .filter((l) => !diffPaths.has(toLocalPath(l)))
          .map((l, k) => <div key={"l" + k}>{renderLocation(l)}</div>)}
        {item.content.map((c, k) => {
          if (c.type === "diff") {
            // A diff block is the tool showing its own before/after, so the file
            // was written whatever `kind` claims — the same rule the panel's
            // Outputs list uses. The card replaces the path header rather than
            // sitting above it.
            const local = toLocalPath(c.path ?? "");
            return (
              <div className="tc-item" key={k}>
                {local && <FileCard path={local} />}
                <Diff path={c.path} oldText={c.oldText} newText={c.newText}
                  renderPath={local ? () => null : (p) => fileLink(p, "path", p)} />
              </div>
            );
          }
          if (c.type === "terminal") return <div className="tc-item" key={k}><div className="loc">{"terminal " + (c.terminalId || "")}</div></div>;
          const inner = c.content || (c as any);
          if (inner && inner.type === "text") return <div className="tc-item" key={k}><Markdown text={inner.text || ""} /></div>;
          return <div className="tc-item" key={k}><div className="loc">{"[" + ((inner && inner.type) || "content") + "]"}</div></div>;
        })}
      </div>
    </details>
  );
}
