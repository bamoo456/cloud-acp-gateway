import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store.ts";
import {
  getCommits, getWorkspaceChanges, getFileDiff, getReviewDraft, saveReviewDraft,
  type ChangedFile, type ChangesResult, type CommitEntry, type FileDiffResult,
  type ReviewComment, type RevSpec,
} from "../lib/api.ts";
import { buildReviewMessage, buildApprovalMessage } from "../lib/reviewPrompt.ts";
import { UnifiedDiff, type DiffAnchor } from "./UnifiedDiff.tsx";
import { basename, dirname, timeAgo, STATUS_MARK, STATUS_LABEL } from "../lib/format.ts";
import { isDesktopPanelWidth } from "../lib/panelWidth.ts";
import { IconBack, IconTrash } from "../lib/icons.tsx";

// Review mode: read a diff, write comments against its lines, send them to the
// agent as one message.
//
// The three scopes are three revisions of the same screen, not three screens.
// "Commits review" is `git show <sha>`; "PR review" is `git diff <base>...HEAD`,
// which is what a pull request IS once the branch is checked out — so neither
// needs a remote API, and both render through the file list and diff viewer the
// panel already had.
//
//   Working  — uncommitted work, the same thing Session mode lists
//   Commits  — pick one from the log, then read what it changed
//   Branch   — everything on HEAD since it left its base
//
// Comments are held here and mirrored to the gateway on every change (see
// src/review.ts): the draft lives in the repo being reviewed, so it survives a
// phone discarding this tab and follows you to another device. Sending clears
// it. Nothing is sent per comment — a review arrives whole or not at all.

type Scope = "working" | "commits" | "branch";

// A comment's identity for the lifetime of the draft — a React key, and what
// Delete names. Random rather than a counter because a draft is shared: two
// devices commenting on the same branch would both start counting at one.
const makeId = () => Math.random().toString(36).slice(2, 10);

const anchorKey = (a: { side: string; line: number }) => a.side + ":" + a.line;
const total = (counts: Record<string, number>) => Object.values(counts).reduce((n, c) => n + c, 0);

// `split` is the panel saying there is room for two panes, so an opened file
// goes BESIDE this list instead of over it — the same layout Session and
// Project get, and for the same reason: a review is read file by file, and
// going Back for every one of them is the walk this saves.
// `onDetail` is how the panel learns a file is open here, which is what widens
// it. Review's open file is this component's own state, and the panel cannot
// see it any other way.
export function ReviewPanel({ cwd, onCount, split, onDetail }: {
  cwd: string; onCount: (n: number) => void;
  split?: boolean; onDetail?: (open: boolean) => void;
}) {
  const sendPrompt = useStore((s) => s.sendPrompt);
  const agentReady = useStore((s) => s.agentReady);
  const closeFiles = useStore((s) => s.closeFiles);
  // The panel has one viewer pane, and the generic preview (a file clicked in
  // the thread, or in another mode) shares it with this one. Whichever was
  // asked for last wins, rather than both claiming the pane.
  const preview = useStore((s) => s.filePreview);
  const clearFilePreview = useStore((s) => s.clearFilePreview);
  // sendPrompt returns without sending while the active session has a turn in
  // flight. Nothing rejects, so a Send pressed mid-turn would resolve, clear the
  // draft, and lose a whole review to a no-op. Disable it instead.
  const activeBusy = useStore((s) => !!(s.activeId && s.busySessionIds[s.activeId]));

  const [scope, setScope] = useState<Scope>("working");
  const [log, setLog] = useState<{ commits: CommitEntry[]; branch?: string; defaultBase?: string } | null>(null);
  // The base a branch review compares against. Seeded from the gateway's answer
  // (origin's default branch, else main/master) and editable, because the base a
  // branch is really off is not always the one a repo defaults to.
  const [baseRef, setBaseRef] = useState("");
  const [editingBase, setEditingBase] = useState(false);
  const [commit, setCommit] = useState<CommitEntry | null>(null);
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [openFile, setOpenFile] = useState<ChangedFile | null>(null);
  // Opening a review file is what the panel widens for; unmounting (a mode
  // switch, a folder change) gives that width straight back.
  useEffect(() => {
    onDetail?.(!!openFile);
    return () => onDetail?.(false);
  }, [openFile, onDetail]);
  // The other half of "one viewer at a time": a file opened from the thread
  // takes the pane, so this one lets go of it.
  useEffect(() => { if (preview) setOpenFile(null); }, [preview]);
  const openReviewFile = (f: ChangedFile) => { clearFilePreview(); setOpenFile(f); };
  const [showDraft, setShowDraft] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  // Every scope's comment count, not just the open one's — this is what the tab
  // badge shows, and a review left on another revision is exactly the thing the
  // badge exists to remember for you.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [draftScope, setDraftScope] = useState("working");
  // False in a folder that isn't a checkout: comments still work, they just
  // won't survive a reload, and saying so beats losing them silently.
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Which revision everything on screen is about. Every read — the file list,
  // each diff, the draft — takes this same value, so they cannot disagree about
  // what is being reviewed.
  const spec: RevSpec | null =
    scope === "commits" ? (commit ? { commit: commit.sha } : null)
    : scope === "branch" ? (baseRef ? { base: baseRef } : null)
    : null;
  // A branch scope with no base yet is not "the working tree" — it is a screen
  // waiting for a base, and asking for the working tree's diff there would show
  // a diff nobody chose.
  const pending = (scope === "commits" && !commit) || (scope === "branch" && !baseRef);
  const specKey = spec ? (spec.commit ? "c:" + spec.commit : "b:" + spec.base) : "working";

  // The log, once per folder. Also supplies the branch name and default base, so
  // the Branch chip works without the Commits chip ever being opened.
  useEffect(() => {
    let alive = true;
    setLog(null);
    setScope("working");
    setCommit(null);
    getCommits(cwd)
      .then((r) => {
        if (!alive) return;
        setLog({ commits: r.commits, branch: r.branch, defaultBase: r.defaultBase });
        setBaseRef(r.defaultBase ?? "");
      })
      .catch(() => { if (alive) setLog({ commits: [] }); });
    return () => { alive = false; };
  }, [cwd]);

  // The file list and the draft for whatever revision is selected. One effect
  // for both: they are two halves of the same question, and a list that arrived
  // without its comments would render every row un-badged for a beat.
  const gen = useRef(0);
  useEffect(() => {
    if (pending) { setChanges(null); setComments([]); return; }
    const mine = ++gen.current;
    setLoading(true);
    setErr(null);
    setOpenFile(null);
    setShowDraft(false);
    getWorkspaceChanges(cwd, spec)
      .then((r) => { if (mine === gen.current) setChanges(r); })
      .catch((e: Error) => { if (mine === gen.current) { setChanges(null); setErr(e.message); } })
      .finally(() => { if (mine === gen.current) setLoading(false); });
    getReviewDraft(cwd, spec)
      .then((d) => {
        if (mine !== gen.current) return;
        setComments(d.comments);
        setPersisted(d.persisted);
        setDraftScope(d.scope);
        setCounts(d.counts);
        onCount(total(d.counts));
      })
      .catch(() => { if (mine === gen.current) setComments([]); });
    return () => { gen.current++; };
  }, [cwd, specKey, pending]);

  // Every change to the draft goes straight to the gateway. Saving on each edit
  // rather than on a timer is what makes "the phone discarded the tab"
  // survivable, and the payload is a handful of comments.
  function commitComments(next: ReviewComment[]) {
    setComments(next);
    // Only this scope's entry moves; the others are what the gateway last said
    // they were, and re-fetching them to learn a number nothing changed would be
    // a round trip per keystroke-worth-of-review.
    const merged = { ...counts, [draftScope]: next.length };
    if (next.length === 0) delete merged[draftScope];
    setCounts(merged);
    onCount(total(merged));
    if (pending) return;
    void saveReviewDraft(cwd, spec, next).then(setPersisted);
  }

  // Comments on the open file, bucketed by the line they hang under, so
  // renderComments is a lookup per row rather than a scan of the whole draft.
  const byLine = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (openFile && c.path !== openFile.path) continue;
    const key = anchorKey(c);
    const bucket = byLine.get(key);
    if (bucket) bucket.push(c);
    else byLine.set(key, [c]);
  }
  const countFor = (path: string) => comments.filter((c) => c.path === path).length;

  async function send(approve: boolean) {
    if (sending) return;
    setSending(true);
    const label = commit ? commit.shortSha + " " + commit.subject : undefined;
    const summary = changes ? {
      files: changes.files.length,
      additions: changes.files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: changes.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    } : {};
    const text = approve
      ? buildApprovalMessage(spec, label)
      : buildReviewMessage(comments, spec, summary, label);
    try {
      await sendPrompt(text);
      // Cleared only after the send resolved: a review that failed to reach the
      // agent must still be on screen to try again.
      commitComments([]);
      // Below the column breakpoint this panel is a sheet ON TOP of the chat, so
      // the message it just sent is behind it — which is where you were going
      // anyway. Same breakpoint the panel's own layout uses, not a second guess
      // at it: the two disagreeing would leave the sheet covering its own result
      // on exactly the widths between them.
      if (!isDesktopPanelWidth()) closeFiles();
    } finally {
      setSending(false);
    }
  }

  const files = changes?.files ?? [];
  const canSend = agentReady && !sending && !activeBusy;

  // ---- the open file ----
  // Beside the list when the panel has room for both, over it when it hasn't —
  // and in the narrow case that is the whole of this component, exactly as
  // before. FileReview's own bar carries the file's name and the way back, so
  // the pane needs no header of its own.
  const detail = openFile && (
    <FileReview cwd={cwd} spec={spec} file={openFile} comments={byLine}
      onBack={() => setOpenFile(null)}
      onAdd={(anchor, body) => commitComments([...comments, {
        id: makeId(), path: openFile.path, side: anchor.side, line: anchor.line,
        code: anchor.code, body,
      }])}
      onDelete={(id) => commitComments(comments.filter((c) => c.id !== id))} />
  );
  if (detail && !split) return detail;

  // ---- the whole draft, to re-read before sending ----
  const list = showDraft
    ? (
      <>
        <div className="rv-bar">
          <button className="icon-btn" title="Back to the file list" onClick={() => setShowDraft(false)}><IconBack /></button>
          <span className="rv-title">Review draft <span className="dim">· {comments.length}</span></span>
        </div>
        <div className="wf-body">
          {[...new Set(comments.map((c) => c.path))].sort().map((path) => (
            <div key={path}>
              <div className="wf-group">{path}</div>
              {comments.filter((c) => c.path === path).sort((a, b) => a.line - b.line).map((c) => (
                <SavedComment key={c.id} comment={c} inList
                  onDelete={() => commitComments(comments.filter((x) => x.id !== c.id))} />
              ))}
            </div>
          ))}
        </div>
        <Footer comments={comments} canSend={canSend} sending={sending}
          persisted={persisted} onSend={() => void send(false)} onShowDraft={undefined} />
      </>
    )
    // ---- scope picker + whatever list it selects ----
    : (
      <>
      <div className="rv-scope" role="tablist" aria-label="What to review">
        {(["working", "commits", "branch"] as Scope[]).map((s) => (
          <button key={s} role="tab" aria-selected={scope === s}
            className={"rv-chip" + (scope === s ? " on" : "")}
            onClick={() => { setScope(s); if (s !== "commits") setCommit(null); }}>
            {s === "working" ? "Working" : s === "commits" ? "Commits" : "Branch"}
          </button>
        ))}
        <span className="sp" />
        {scope === "branch" && !editingBase && (
          <button className="rv-ref" onClick={() => setEditingBase(true)}
            title="Compare against a different base">{baseRef || "set a base…"}</button>
        )}
        {scope === "commits" && commit && (
          <button className="rv-ref" onClick={() => setCommit(null)} title="Back to the commit list">
            <IconBack />{commit.shortSha}
          </button>
        )}
      </div>

      {scope === "branch" && editingBase && (
        <BaseEditor value={baseRef} branch={log?.branch}
          onDone={(v) => { setBaseRef(v.trim()); setEditingBase(false); }} />
      )}

      <div className="wf-body">
        {/* Commits: the log, until one is picked. Picking re-asks every read
            above with ?rev=, which is why there is no separate detail screen. */}
        {scope === "commits" && !commit && (
          log === null
            ? <div className="wf-empty">Reading history…</div>
            : log.commits.length === 0
              ? <div className="wf-empty">No commits in this folder yet.</div>
              : log.commits.map((c) => (
                  <button key={c.sha} className="wf-row rv-commit" onClick={() => setCommit(c)}
                    title={c.subject}>
                    <span className="rv-sha">{c.shortSha}</span>
                    <span className="wf-name">
                      <span className="wf-nm">{c.subject}</span>
                      <span className="wf-dir">{c.author}{c.date ? " · " + timeAgo(c.date) : ""}</span>
                    </span>
                    {c.additions !== undefined && (
                      <span className="wf-counts">
                        {c.additions > 0 && <span className="add">+{c.additions}</span>}
                        {(c.deletions ?? 0) > 0 && <span className="del">−{c.deletions}</span>}
                      </span>
                    )}
                  </button>
                ))
        )}

        {scope === "branch" && !baseRef && !editingBase && (
          <div className="wf-empty">
            This checkout has no default branch to compare against. Set a base to review against.
          </div>
        )}

        {!pending && (
          <>
            {err && <div className="wf-empty">{err}</div>}
            {!err && loading && <div className="wf-empty">Reading changes…</div>}
            {!err && !loading && changes && (
              <EmptyState changes={changes} scope={scope} ref_={spec?.base ?? spec?.commit} />
            )}
            {files.length > 0 && <StatLine files={files} truncated={!!changes?.truncated} />}
            {files.map((f) => (
              <button key={f.abs} className={"wf-row" + (openFile?.abs === f.abs ? " on" : "")}
                onClick={() => openReviewFile(f)} title={f.path}>
                <span className={"wf-mark wf-git " + f.status} title={STATUS_LABEL[f.status]}>
                  {STATUS_MARK[f.status]}
                </span>
                <span className="wf-name">
                  <span className="wf-nm">{basename(f.path)}</span>
                  {dirname(f.path) && <span className="wf-dir">{dirname(f.path)}</span>}
                </span>
                {countFor(f.path) > 0 && <span className="rv-badge">{countFor(f.path)}</span>}
                <span className="wf-counts">
                  {f.binary
                    ? <span className="bin">bin</span>
                    : <>
                        {(f.additions ?? 0) > 0 && <span className="add">+{f.additions}</span>}
                        {(f.deletions ?? 0) > 0 && <span className="del">−{f.deletions}</span>}
                      </>}
                </span>
              </button>
            ))}
          </>
        )}
      </div>

      {/* The footer only exists once there is something to do with it: an empty
          review offers Approve, a written one offers Send. Before either, the
          mode has no chrome at all. */}
      {!pending && changes?.repo && (
        <Footer comments={comments} canSend={canSend} sending={sending} persisted={persisted}
          onSend={() => void send(comments.length === 0)}
          onShowDraft={comments.length > 0 ? () => setShowDraft(true) : undefined} />
      )}
      </>
    );

  return (
    <>
      <div className="wf-list">{list}</div>
      {detail && <div className="wf-view">{detail}</div>}
    </>
  );
}

// Exactly one empty state, ever. These used to be three independent `&&`
// blocks, which meant a failed diff (repo non-null, no files, reason set)
// rendered its own message *and* "nothing changed here" underneath it — the
// second one flatly contradicting the first. Diagnosis order: couldn't run
// git, not a checkout, git refused this revision, git failed some other way,
// and only then a genuinely empty diff.
function EmptyState({ changes, scope, ref_ }: {
  changes: ChangesResult; scope: Scope; ref_?: string;
}) {
  const msg = (): React.ReactNode => {
    if (changes.reason === "git-missing")
      return "git isn't installed on the gateway host, so there's nothing to review here.";
    if (changes.repo === null)
      return "This folder isn't a git checkout, so there's nothing to review here.";
    if (changes.reason === "no-merge-base")
      return <>
        This checkout's history is too shallow to share a common ancestor with <code>{ref_}</code>.
        Deepen the fetch (<code>git fetch --unshallow</code>) to compare against it.
      </>;
    if (changes.reason === "bad-revision")
      return <>
        git doesn't know <code>{ref_}</code> in this checkout — it may never have been fetched.
      </>;
    // status-failed, and whatever else git might refuse later: still better
    // than reporting a diff that never ran as an empty one.
    if (changes.reason) return "git couldn't read this checkout's changes.";
    if (changes.files.length > 0) return null;
    return scope === "working"
      ? "Nothing uncommitted in this checkout."
      : "Nothing changed here — this revision is already in its base.";
  };
  const m = msg();
  return m === null ? null : <div className="wf-empty">{m}</div>;
}

function StatLine({ files, truncated }: { files: ChangedFile[]; truncated: boolean }) {
  const add = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="wf-group">
      {files.length} {files.length === 1 ? "file" : "files"}
      {(add > 0 || del > 0) && <> · <span className="add">+{add}</span> <span className="del">−{del}</span></>}
      {truncated && " (first " + files.length + ")"}
    </div>
  );
}

function Footer({ comments, canSend, sending, persisted, onSend, onShowDraft }: {
  comments: ReviewComment[]; canSend: boolean; sending: boolean; persisted: boolean;
  onSend: () => void; onShowDraft?: () => void;
}) {
  const n = comments.length;
  return (
    <div className="rv-foot">
      <span className="rv-n">
        {n === 0 ? "No comments yet" : <><b>{n}</b> {n === 1 ? "comment" : "comments"}</>}
        {/* Said once, in the only place that can act on it: a draft that isn't
            being stored is a draft you should send before closing the tab. */}
        {!persisted && n > 0 && <span className="rv-warn"> · not saved on the gateway</span>}
      </span>
      {onShowDraft && <button className="btn-sm" onClick={onShowDraft}>Review draft</button>}
      <button className="btn-sm primary" disabled={!canSend} onClick={onSend}>
        {sending ? "Sending…" : n === 0 ? "Approve" : "Send review"}
      </button>
    </div>
  );
}

// The base a branch is compared against. A text field rather than a picker: the
// answer is a git revision, and every shape of one — a remote branch, a tag, a
// sha, `HEAD~5` — is valid here. The gateway refuses anything that would reach
// git as a flag.
function BaseEditor({ value, branch, onDone }: {
  value: string; branch?: string; onDone: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <form className="rv-base" onSubmit={(e) => { e.preventDefault(); onDone(text); }}>
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
        placeholder="origin/main" aria-label="Base revision"
        onKeyDown={(e) => { if (e.key === "Escape") onDone(value); }} />
      <span className="rv-base-hint">…{branch ? "" + branch : "HEAD"}</span>
      <button type="submit" className="btn-sm primary">Compare</button>
    </form>
  );
}

// ---- one file's diff, with its comments ----

function FileReview({ cwd, spec, file, comments, onBack, onAdd, onDelete }: {
  cwd: string; spec: RevSpec | null; file: ChangedFile;
  comments: Map<string, ReviewComment[]>;
  onBack: () => void;
  onAdd: (anchor: DiffAnchor, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [diff, setDiff] = useState<FileDiffResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The line a comment is being written against. Null is the ordinary state.
  const [picked, setPicked] = useState<DiffAnchor | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    setPicked(null);
    getFileDiff(cwd, file.abs, spec)
      .then((d) => { if (alive) setDiff(d); })
      .catch((e: Error) => { if (alive) setErr(e.message || "Couldn't read this file's diff."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cwd, file.abs, spec?.commit, spec?.base]);

  return (
    <>
      <div className="rv-bar">
        <button className="icon-btn" title="Back to the file list" onClick={onBack}><IconBack /></button>
        <span className="rv-title" title={file.path}>{file.path}</span>
      </div>
      <div className="wf-body">
        {err && <div className="wf-empty">{err}</div>}
        {!err && loading && <div className="wf-empty">Loading…</div>}
        {!err && !loading && diff && (
          diff.binary
            ? <div className="wf-empty">Binary file — there's nothing to review here.</div>
            : !diff.diff.trim()
              ? <div className="wf-empty">This revision didn't change this file.</div>
              : <UnifiedDiff diff={diff.diff} path={file.path} truncated={diff.truncated}
                  picked={picked}
                  onPick={(a) => setPicked((p) => (p && p.side === a.side && p.line === a.line ? null : a))}
                  renderComments={(a) => {
                    const saved = comments.get(anchorKey(a)) ?? [];
                    const writing = picked && picked.side === a.side && picked.line === a.line;
                    if (!saved.length && !writing) return null;
                    return (
                      <>
                        {saved.map((c) => (
                          <SavedComment key={c.id} comment={c} onDelete={() => onDelete(c.id!)} />
                        ))}
                        {writing && (
                          <CommentComposer anchor={a} path={file.path}
                            onCancel={() => setPicked(null)}
                            onAdd={(body) => { onAdd(a, body); setPicked(null); }} />
                        )}
                      </>
                    );
                  }} />
        )}
      </div>
    </>
  );
}

function SavedComment({ comment, inList, onDelete }: {
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

function CommentComposer({ anchor, path, onAdd, onCancel }: {
  anchor: DiffAnchor; path: string; onAdd: (body: string) => void; onCancel: () => void;
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
        <button className="btn-sm primary" disabled={!text.trim()} onClick={submit}>
          Add comment
        </button>
      </div>
    </div>
  );
}
