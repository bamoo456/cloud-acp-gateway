import { useEffect, useRef, useState } from "react";
import type { ReviewComment } from "../lib/api.ts";
import type { DiffAnchor } from "./UnifiedDiff.tsx";
import { IconTrash } from "../lib/icons.tsx";

// A review comment as it reads on a diff line and in the draft list. Its own
// module because two unrelated screens draw it: the viewer, which writes
// comments onto a diff (FileView), and the workspace's draft list, which reads
// the whole draft back before sending it.

// Which line a comment hangs under. The side matters: the two numbering schemes
// are not interchangeable, and an old-side line has no new-side twin.
export const anchorKey = (a: { side: string; line: number }) => a.side + ":" + a.line;

export function SavedComment({ comment, inList, onDelete }: {
  comment: ReviewComment; inList?: boolean; onDelete: () => void;
}) {
  return (
    <div className={"rv-cmt saved" + (inList ? " in-list" : "")}>
      <div className="rv-anchor">
        {inList ? ":" + comment.line : comment.path.split("/").pop() + ":" + comment.line}
        {comment.side === "old" && " · removed"}
        {inList && comment.code.trim() && <span className="rv-quote">{comment.code}</span>}
      </div>
      <div className="rv-body">{comment.body}</div>
      <div className="rv-acts">
        <button className="btn-ghost" onClick={onDelete}><IconTrash />Delete</button>
      </div>
    </div>
  );
}

export function CommentComposer({ anchor, path, onAdd, onCancel, onAskFix }: {
  anchor: DiffAnchor; path: string; onAdd: (body: string) => void; onCancel: () => void;
  onAskFix?: (intent: "ask" | "fix") => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { if (text.trim()) onAdd(text.trim()); };
  return (
    <div className="rv-cmt">
      <div className="rv-anchor">
        {path.split("/").pop()}:{anchor.line}{anchor.side === "old" && " · removed"}
      </div>
      <textarea ref={ref} value={text} rows={3} placeholder="What's wrong with this line?"
        onChange={(e) => setText(e.target.value)}
        // Enter sends on a keyboard the way it does in the composer; a phone's
        // return key inserts a newline, which is why the button is always there.
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }} />
      <div className="rv-acts">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <span className="sp" />
        {/* Not a comment for later — a question or a fix for now, typed in the
            composer, which is where these two take you. */}
        {onAskFix && <>
          <button className="btn-sm" onClick={() => onAskFix("ask")}>Ask</button>
          <button className="btn-sm" onClick={() => onAskFix("fix")}>Fix</button>
        </>}
        <button className="btn-sm primary" disabled={!text.trim()} onClick={submit}>
          Add comment
        </button>
      </div>
    </div>
  );
}
