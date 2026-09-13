import { useEffect, useRef, useState } from "react";
import type { Discussion, ReviewComment } from "../lib/api.ts";
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

export function CommentComposer({ anchor, path, onAdd, onCancel, onAskFix, onDiscuss }: {
  anchor: DiffAnchor; path: string; onAdd: (body: string) => void; onCancel: () => void;
  onAskFix?: (intent: "ask" | "fix") => void;
  // Absent in the file view and on unchanged lines: a discussion is a record
  // against a line of the change being reviewed. Resolves false when the
  // gateway refused it, which leaves this composer — and the text in it — up.
  onDiscuss?: (body: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [refused, setRefused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { if (text.trim()) onAdd(text.trim()); };
  return (
    <div className="rv-cmt">
      <div className="rv-anchor">
        {path.split("/").pop()}:{anchor.line}{anchor.side === "old" && " · removed"}
        {refused && <span className="rv-warn"> · couldn't start a discussion here</span>}
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
        {/* The other half of "Add comment": one goes out with the review and is
            gone, this one stays on the gateway until somebody resolves it. */}
        {onDiscuss && (
          <button className="btn-sm" disabled={!text.trim()}
            onClick={() => { setRefused(false); void onDiscuss(text.trim()).then((ok) => setRefused(!ok)); }}>
            Discuss
          </button>
        )}
        <button className="btn-sm primary" disabled={!text.trim()} onClick={submit}>
          Add comment
        </button>
      </div>
    </div>
  );
}

// What can be done to a discussion, wherever it is drawn. One object because
// the card appears twice — under its diff line and in the cross-file index —
// and the two must not drift into offering different buttons.
export interface DiscussionActs {
  onReply: (id: string, body: string) => void;
  onStatus: (id: string, op: "resolve" | "reopen") => void;
  // Absent when the agent never advertised session/fork (branchGate's `show`).
  onBranch?: (d: Discussion) => void;
  branchDisabled?: boolean;
  branchWhy?: string;
}

// A durable discussion. Collapsed to its anchor by default: a file with six of
// them open is a wall of prose where a diff should be, and the one line that
// says where it is anchored is what the reader is scanning for.
//
// `acts` absent is the read-only case — a sibling review whose worktree has
// been deleted. The record still reads; there is nothing left to act on.
export function DiscussionCard({ d, acts, onOpen, note, inList }: {
  d: Discussion; acts?: DiscussionActs; onOpen?: () => void; note?: string; inList?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const label = d.path.split("/").pop() + ":" + d.line;
  const send = () => {
    if (!text.trim() || !acts) return;
    acts.onReply(d.id, text.trim());
    setText("");
    setReplying(false);
  };
  return (
    <details className={"rv-cmt discussion" + (d.status === "resolved" ? " resolved" : "") + (inList ? " in-list" : "")}>
      <summary className="rv-anchor">
        <span className="rv-diamond" aria-hidden="true">◆</span>
        {/* A button inside the summary, so opening the file and expanding the
            card are two different clicks rather than one that guesses. */}
        {onOpen
          ? <button className="rv-open" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(); }}>{label}</button>
          : label}
        {d.side === "old" && " · removed"}
        {d.replies.length > 0 && ` · ${d.replies.length} ${d.replies.length === 1 ? "reply" : "replies"}`}
        {d.status === "resolved" && " · resolved"}
      </summary>
      {/* The code as it read when the discussion was written, never as it reads
          now: that is the whole of what makes an outdated anchor honest. */}
      {d.code.trim() && <div className="rv-quote">{d.code}</div>}
      <div className="rv-body">{d.body}</div>
      {d.replies.map((r) => <div key={r.id} className="rv-body rv-reply">{r.body}</div>)}
      {note && <div className="rv-body rv-gone">{note}</div>}
      {replying && (
        <textarea autoFocus value={text} rows={2} placeholder="Reply…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setReplying(false); setText(""); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
          }} />
      )}
      {acts && (
        <div className="rv-acts">
          <span className="sp" />
          {replying
            ? <button className="btn-sm primary" disabled={!text.trim()} onClick={send}>Send reply</button>
            : <button className="btn-sm" onClick={() => setReplying(true)}>Reply</button>}
          <button className="btn-sm" onClick={() => acts.onStatus(d.id, d.status === "open" ? "resolve" : "reopen")}>
            {d.status === "open" ? "Resolve" : "Reopen"}
          </button>
          {acts.onBranch && (
            <button className="btn-sm" disabled={acts.branchDisabled} title={acts.branchWhy}
              onClick={() => acts.onBranch!(d)}>Branch</button>
          )}
        </div>
      )}
    </details>
  );
}
