import { useEffect, useRef, useState } from "react";
import { useStore, branchGate, type PreviewMode, type ReviewLoc } from "../store/store.ts";
import {
  getCommits, getWorkspaceChanges, getReviewDraft, saveReviewDraft,
  getReviewState, postReviewDiscussion, setFileReviewed,
  type ChangedFile, type ChangesResult, type CommitEntry, type Discussion, type FileDiffResult,
  type OtherDiscussion, type ReviewComment, type ReviewedFile, type ReviewIdentity, type RevSpec,
} from "../lib/api.ts";
import { buildReviewMessage, buildApprovalMessage, buildDiscussionMessage } from "../lib/reviewPrompt.ts";
import { basename, timeAgo, STATUS_MARK, STATUS_LABEL } from "../lib/format.ts";
import { IconArrow, IconBack, IconChevrons, IconRefresh } from "../lib/icons.tsx";
import { PathTree } from "./PathTree.tsx";
import { FileView } from "./FilePanel.tsx";
import { SavedComment, DiscussionCard, anchorKey } from "./ReviewComments.tsx";
import { makeRangeFile } from "../lib/mentions.ts";
import { isDesktopPanelWidth } from "../lib/panelWidth.ts";
import type { DiffAnchor } from "./UnifiedDiff.tsx";

// The review workspace: read a diff, write comments against its lines, send
// them to the agent as one message.
//
// The three scopes are three revisions of the same screen, not three screens.
// "Commits review" is `git show <sha>`; "PR review" is `git diff <base>...HEAD`,
// which is what a pull request IS once the branch is checked out — so neither
// needs a remote API, and both render through the file list and diff viewer the
// console already had.
//
//   Working  — uncommitted work, the same thing Session mode lists
//   Commits  — pick one from the log, then read what it changed
//   Branch   — everything on HEAD since it left its base
//
// Comments are held here and mirrored to the gateway on every change (see
// src/review.ts): the draft lives in the repo being reviewed, so it survives a
// phone discarding this tab and follows you to another device. Sending clears
// it. Nothing is sent per comment — a review arrives whole or not at all.
//
// The state is one hook rather than one component because the two halves of the
// workspace are not nested: the changed files are a column of `.app-row` and
// the canvas is another, with the conversation between them and the row itself
// owned by App. App holds the hook, which is also what keeps a scope, a draft
// and an open file alive while you are away in the Agent workspace.

type Scope = "working" | "commits" | "branch";

// A comment's identity for the lifetime of the draft — a React key, and what
// Delete names. Random rather than a counter because a draft is shared: two
// devices commenting on the same branch would both start counting at one.
const makeId = () => Math.random().toString(36).slice(2, 10);

// One revision, as a string to compare by. Tagged, because a base ref and a
// commit are not the same revision even when they read the same; `null`,
// `undefined` and a spec with neither field all mean the working tree.
const revOf = (s?: RevSpec | null) =>
  s?.commit ? "c:" + s.commit : s?.base ? "b:" + s.base : "working";

export type ReviewSession = ReturnType<typeof useReviewSession>;

// `active` is the workspace being on screen. Everything here survives leaving
// it — that is the point of holding the state above the columns — but nothing
// here reads the checkout while the Agent workspace is up: the file panel is
// already asking git the same questions over there.
export function useReviewSession(cwd: string, active: boolean) {
  const sendPrompt = useStore((s) => s.sendPrompt);
  const agentReady = useStore((s) => s.agentReady);
  // sendPrompt returns without sending while the active session has a turn in
  // flight. Nothing rejects, so a Send pressed mid-turn would resolve, clear the
  // draft, and lose a whole review to a no-op. Disable it instead.
  const activeBusy = useStore((s) => !!(s.activeId && s.busySessionIds[s.activeId]));
  // Ask/Fix on a diff line is not disabled mid-turn: the composer queues it.
  // Read flat, at click time — the request is bound to the conversation on
  // screen NOW, and must still land there after switching to another one.
  // Not on a saved conversation that has not been resumed: sendPromptTo refuses
  // a view-only session, and a button that only ever bounces is a broken one.
  const activeId = useStore((s) => (s.activeId && !s.sessions[s.activeId]?.viewOnly ? s.activeId : null));
  const agentName = useStore((s) => (s.activeId && s.sessions[s.activeId]?.agentName) || s.agentName);
  const setAskFix = useStore((s) => s.setAskFix);
  // The canvas is the one viewer, and the Review slot is what it reads. The
  // Agent workspace's `filePreview` is deliberately not consulted anywhere in
  // here: the two workspaces keep their place independently.
  const open = useStore((s) => s.reviewPreview);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const clearReviewPreview = useStore((s) => s.clearReviewPreview);
  const clearReviewHistory = useStore((s) => s.clearReviewHistory);
  const working = useStore((s) => !!(s.activeId && s.sessions[s.activeId]?.working));
  const branchSession = useStore((s) => s.branchSession);
  // branchGate builds a fresh object every call, which a selector may not
  // return — the store would see a new value on every change and re-render
  // forever. Three primitives, three comparisons.
  const branchShow = useStore((s) => branchGate(s).show);
  const branchDisabled = useStore((s) => branchGate(s).disabled);
  const branchWhy = useStore((s) => branchGate(s).why);

  const [scope, setScope] = useState<Scope>("working");
  const [log, setLog] = useState<{ commits: CommitEntry[]; branch?: string; defaultBase?: string } | null>(null);
  // The base a branch review compares against. Seeded from the gateway's answer
  // (origin's default branch, else main/master) and editable, because the base a
  // branch is really off is not always the one a repo defaults to.
  const [baseRef, setBaseRef] = useState("");
  const [editingBase, setEditingBase] = useState(false);
  const [commit, setCommit] = useState<CommitEntry | null>(null);
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [showDraft, setShowDraft] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  // Every scope's comment count, not just the open one's — a review left on
  // another revision is exactly the thing the file panel's badge exists to
  // remember for you.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [draftScope, setDraftScope] = useState("working");
  // False in a folder that isn't a checkout: comments still work, they just
  // won't survive a reload, and saying so beats losing them silently.
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Every reason to re-read the checkout — a turn ending, Refresh — against
  // Refresh alone, which also takes the open file's diff with it. A turn ending
  // stops short of that on purpose: redrawing a diff someone is commenting on
  // is the workspace fighting them.
  const [refreshKey, setRefreshKey] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  // The durable half of the review: the discussions on it, the ones sibling
  // reviews of the same repository hold, and the identity they all hang off.
  // `review` is null until something has been written — reading never creates
  // it, which is why an untouched folder shows no state and no error.
  const [review, setReview] = useState<ReviewIdentity | null>(null);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [others, setOthers] = useState<OtherDiscussion[]>([]);
  // Which files have been read, and whether they still say what they said when
  // they were. `changed` is the gateway's comparison, not ours: the hash it
  // holds is the one that was on screen at the moment somebody marked it.
  const [reviewed, setReviewed] = useState<ReviewedFile[]>([]);
  const [tab, setTab] = useState<"changed" | "discussions">("changed");
  // Its own refresh counter. A reply is one row on the gateway; riding
  // refreshKey would re-run git status and the log to learn it.
  const [stateKey, setStateKey] = useState(0);

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
  const specKey = revOf(spec);

  // A folder change is a different review: what was selected there means
  // nothing here. Separate from the fetch below, because a refresh is the SAME
  // review — resetting on one of those would kick you off the commit you are
  // reading every time the agent finished a turn.
  useEffect(() => {
    setLog(null);
    setScope("working");
    setCommit(null);
    setBaseRef("");
    // The canvas's location and the stacks behind it name paths in a checkout,
    // so they go with it. Keyed on this hook's folder rather than the store's:
    // an active session can point at a different one, and Back must not walk
    // into a repo that is no longer on screen.
    clearReviewPreview();
    clearReviewHistory();
    setShowDraft(false);
  }, [cwd, clearReviewPreview, clearReviewHistory]);

  // The log, per folder and again on every refresh. Also supplies the branch
  // name and default base, so the Branch chip works without the Commits chip
  // ever being opened.
  const seededBase = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    getCommits(cwd)
      .then((r) => {
        if (!alive) return;
        // The previous log stays on screen until this one lands: a refresh
        // updates the list, it doesn't blank it.
        setLog({ commits: r.commits, branch: r.branch, defaultBase: r.defaultBase });
        // Once per folder. The base is editable, and re-seeding it on every
        // refresh would overwrite what someone typed with the repo's default.
        if (seededBase.current !== cwd) {
          seededBase.current = cwd;
          setBaseRef(r.defaultBase ?? "");
        }
      })
      .catch(() => { if (alive) setLog((l) => l ?? { commits: [] }); });
    return () => { alive = false; };
  }, [cwd, refreshKey, active]);

  // The file list and the draft for whatever revision is selected. One effect
  // for both: they are two halves of the same question, and a list that arrived
  // without its comments would render every row un-badged for a beat.
  const gen = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (pending) { setChanges(null); setComments([]); return; }
    const mine = ++gen.current;
    setLoading(true);
    setErr(null);
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
      })
      .catch(() => { if (mine === gen.current) setComments([]); });
    return () => { gen.current++; };
  }, [cwd, specKey, pending, refreshKey, active]);

  // Discussions, on the same refresh path as the lists above and on its own key
  // besides. Separate from the draft fetch because the two have different
  // reasons to re-run, not because they answer different questions.
  const stateGen = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (pending) { setReview(null); setDiscussions([]); setOthers([]); setReviewed([]); return; }
    const mine = ++stateGen.current;
    getReviewState(cwd, spec)
      .then((st) => {
        if (mine !== stateGen.current) return;
        setReview(st.review);
        setDiscussions(st.discussions);
        setOthers(st.others);
        setReviewed(st.reviewed);
      })
      .catch(() => { if (mine === stateGen.current) { setDiscussions([]); setOthers([]); setReviewed([]); } });
    return () => { stateGen.current++; };
  }, [cwd, specKey, pending, refreshKey, active, stateKey]);

  // A turn ending is the moment the list is most likely wrong: the agent just
  // finished writing. The lists around the diff only — see reloadKey.
  const wasWorking = useRef(working);
  useEffect(() => {
    const justFinished = wasWorking.current && !working;
    wasWorking.current = working;
    if (justFinished && active) setRefreshKey((k) => k + 1);
  }, [working, active]);

  // Every change to the draft goes straight to the gateway. Saving on each edit
  // rather than on a timer is what makes "the phone discarded the tab"
  // survivable, and the payload is a handful of comments.
  // A new revision is a new thing to read, so choosing one closes the file open
  // against the old one. In the three actions that choose rather than in an
  // effect on the revision: Back/Forward change it too, and a location coming
  // back out of history brings its own revision with it — an effect could not
  // tell the two apart, and would wipe what it had just restored.
  function closeOpen() {
    clearReviewPreview();
    setShowDraft(false);
  }

  // The other direction: a restored location puts the header back on the
  // revision it was read against, so the chips and the diff cannot disagree
  // about what is being reviewed. A commit the log no longer reaches is still
  // named by its sha — that is what identifies the location.
  function restoreSpec(s?: RevSpec | null) {
    if (s?.commit) {
      const sha = s.commit;
      setScope("commits");
      setCommit(log?.commits.find((c) => c.sha === sha)
        ?? { sha, shortSha: sha.slice(0, 7), author: "", date: "", subject: "" });
    } else if (s?.base) {
      setScope("branch");
      setBaseRef(s.base);
    } else {
      setScope("working");
      setCommit(null);
    }
  }

  function commitComments(next: ReviewComment[]) {
    setComments(next);
    // Only this scope's entry moves; the others are what the gateway last said
    // they were, and re-fetching them to learn a number nothing changed would be
    // a round trip per keystroke-worth-of-review.
    const merged = { ...counts, [draftScope]: next.length };
    if (next.length === 0) delete merged[draftScope];
    setCounts(merged);
    if (pending) return;
    void saveReviewDraft(cwd, spec, next).then(setPersisted);
  }

  // ---- discussions ----
  // The session that was open when this review first wrote something, as the
  // gateway records it. Optional on every write: a review can be read and
  // discussed with no conversation on screen at all.
  const companion = () => (activeId ? { agentName, sessionId: activeId } : undefined);

  // A reply or a status change lands in whichever list holds that id — this
  // review's, or the read-only column of a sibling one.
  function patch(id: string, f: (d: Discussion) => Partial<Discussion>) {
    setDiscussions((ds) => ds.map((d) => (d.id === id ? { ...d, ...f(d) } : d)));
    setOthers((ds) => ds.map((d) => (d.id === id ? { ...d, ...f(d) } : d)));
  }

  async function createDiscussion(path: string, a: DiffAnchor, body: string, revision: string, diffHash?: string) {
    // Not optimistic, unlike the two below: a discussion has no id until the
    // gateway gives it one, and a refusal (the worktree is gone, the folder is
    // not a checkout) has to leave the composer and its text exactly where they
    // are rather than flash a card that never existed.
    const r = await postReviewDiscussion(cwd, spec, {
      op: "create",
      anchor: { path, side: a.side, line: a.line, code: a.code },
      body, revision, diffHash, companion: companion(),
    });
    if (!r.ok || !r.discussion) return false;
    setDiscussions((ds) => [...ds, r.discussion!]);
    setStateKey((k) => k + 1);
    return true;
  }

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
    } finally {
      setSending(false);
    }
  }

  return {
    cwd, scope, log, baseRef, editingBase, commit, changes, comments, persisted,
    loading, err, sending, showDraft, spec, pending, open, reloadKey,
    activeId, agentName, setAskFix,
    canSend: agentReady && !sending && !activeBusy,
    setShowDraft, setEditingBase,
    restoreSpec,
    pick: (s: Scope) => {
      if (s === scope) return;
      setScope(s);
      if (s !== "commits") setCommit(null);
      closeOpen();
    },
    pickCommit: (c: CommitEntry | null) => { setCommit(c); closeOpen(); },
    setBase: (v: string) => { setBaseRef(v.trim()); setEditingBase(false); closeOpen(); },
    openFile: (f: ChangedFile) =>
      openFilePreview({ abs: f.abs, path: f.path, mode: "diff", cwd, spec }),
    refresh: () => { setRefreshKey((k) => k + 1); setReloadKey((k) => k + 1); },
    // The diff on screen and nothing else. What "changed since you reviewed it"
    // offers is a re-read of this one file — re-running the lists around it
    // would move the reader off it to answer a question about it.
    reload: () => setReloadKey((k) => k + 1),
    addComment: (path: string, anchor: DiffAnchor, body: string) => commitComments([
      ...comments, { id: makeId(), path, side: anchor.side, line: anchor.line, code: anchor.code, body },
    ]),
    deleteComment: (id: string) => commitComments(comments.filter((c) => c.id !== id)),
    send,

    // ---- durable state ----
    review, discussions, others, reviewed, tab, setTab,
    // Every count the tab shows is of THIS review's open threads: a resolved one
    // is done, and a sibling worktree's is not this reviewer's to clear.
    openCount: discussions.filter((d) => d.status === "open").length,
    createDiscussion,
    discussionActs: {
      onReply: (id: string, body: string) => {
        const at = new Date().toISOString();
        patch(id, (d) => ({ replies: [...d.replies, { id: "pending:" + at, body, createdAt: at }] }));
        // The refetch is also the undo: a write that failed comes back absent.
        void postReviewDiscussion(cwd, spec, { op: "reply", id, body })
          .then(() => setStateKey((k) => k + 1));
      },
      onStatus: (id: string, op: "resolve" | "reopen") => {
        patch(id, () => ({ status: op === "resolve" ? "resolved" : "open" }));
        void postReviewDiscussion(cwd, spec, { op, id }).then(() => setStateKey((k) => k + 1));
      },
      onBranch: branchShow ? (d: Discussion) => { void branchSession({ text: buildDiscussionMessage(d) }); } : undefined,
      branchDisabled, branchWhy,
    },
    // `hash` and `revision` are the diff that was RENDERED, handed straight
    // through. Not optimistic, unlike a reply: a tick that appears before the
    // gateway has it is a claim that a file was read, which is the one thing
    // this is here to keep honest.
    markReviewed: (path: string, hash: string, revision: string, next: boolean) => {
      void setFileReviewed(cwd, spec, { path, hash, revision, reviewed: next, companion: companion() })
        .then(() => setStateKey((k) => k + 1));
    },
    // The same slot a CodeRef opens, so the canvas history works the same way.
    // Rooted at the review's worktree rather than at `cwd`: a discussion's path
    // is repo-root-relative, and `cwd` may be a folder inside the checkout. The
    // revision rides along, or the canvas would read the file as a CodeRef's —
    // and drop the comment layer the discussion is drawn in.
    openDiscussion: (d: Discussion) => openFilePreview({
      abs: (review?.worktree ?? cwd) + "/" + d.path, path: d.path, mode: "diff", cwd, spec, line: d.line,
    }),
  };
}

// ---- the changed files, and the draft written against them ----

export function ReviewLeft({ rv }: { rv: ReviewSession }) {
  const sheet = useStore((s) => s.reviewSheet === "files");
  const { changes, comments, scope, pending, loading, err, spec } = rv;
  const files = changes?.files ?? [];
  const countFor = (path: string) => comments.filter((c) => c.path === path).length;
  // Read, and still what was read. A muted tick rather than a green one: green
  // means a diff `+`, and a column of green ticks buries the files nobody has
  // opened yet. The changed mark says the opposite — this row is work again.
  const markFor = (path: string) => {
    const r = rv.reviewed.find((f) => f.path === path);
    if (!r) return null;
    if (!r.changed) return <span className="wf-reviewed" title="You marked this reviewed">✓</span>;
    return (
      <span className="wf-reviewed changed" title={r.reason === "unhashable"
        ? "Changed after you reviewed it — this diff can no longer be read whole"
        : "Changed after you reviewed it"}>●</span>
    );
  };
  return (
    <aside className={"rv-left" + (sheet ? " open" : "")} aria-label="Changed files">
      {rv.showDraft ? (
        // ---- the whole draft, to re-read before sending ----
        <>
          <div className="rv-bar">
            <button className="icon-btn" title="Back to the file list"
              onClick={() => rv.setShowDraft(false)}><IconBack /></button>
            <span className="rv-title">Review draft <span className="dim">· {comments.length}</span></span>
          </div>
          <div className="wf-body">
            {[...new Set(comments.map((c) => c.path))].sort().map((path) => (
              <div key={path}>
                <div className="wf-group">{path}</div>
                {comments.filter((c) => c.path === path).sort((a, b) => a.line - b.line).map((c) => (
                  <SavedComment key={c.id} comment={c} inList onDelete={() => rv.deleteComment(c.id!)} />
                ))}
              </div>
            ))}
          </div>
          <Footer rv={rv} onShowDraft={undefined} />
        </>
      ) : (
        <>
          {/* Two readings of the same review: the change, and what has been said
              about it. A tab rather than a section under the files, because a
              discussion is cross-file and the tree is not. */}
          <div className="rv-tabs" role="tablist" aria-label="Review">
            <button role="tab" aria-selected={rv.tab === "changed"}
              className={"rv-tab" + (rv.tab === "changed" ? " on" : "")}
              onClick={() => rv.setTab("changed")}>Changed</button>
            <button role="tab" aria-selected={rv.tab === "discussions"}
              className={"rv-tab" + (rv.tab === "discussions" ? " on" : "")}
              onClick={() => rv.setTab("discussions")}>
              Discussions
              {rv.openCount > 0 && <span className="rv-tab-n">{rv.openCount}</span>}
            </button>
          </div>
          {rv.tab === "discussions" ? <DiscussionIndex rv={rv} /> : (
          <div className="wf-body">
            {/* The canvas is where a commit is picked and a base is typed, so
                this column says what it is waiting for rather than repeating
                the controls. */}
            {scope === "commits" && !rv.commit && (
              <div className="wf-empty">Pick a commit in the canvas to see what it changed.</div>
            )}
            {scope === "branch" && !rv.baseRef && (
              <div className="wf-empty">
                This checkout has no default branch to compare against. Set a base to review against.
              </div>
            )}

            {!pending && (
              <>
                {err && <div className="wf-empty">{err}</div>}
                {/* Only while there is nothing to show. On a refresh the last list
                    stays up rather than flashing to a placeholder and back. */}
                {!err && loading && !changes && <div className="wf-empty">Reading changes…</div>}
                {!err && changes && (
                  <EmptyState changes={changes} scope={scope} ref_={spec?.base ?? spec?.commit} />
                )}
                {files.length > 0 && <StatLine files={files} truncated={!!changes?.truncated} />}
                {/* Grouped by folder rather than one flat list: a review of more
                    than a handful of files is read a folder at a time, and the
                    path each row used to carry on its second line is the folder
                    row's job now. Keyed on the revision — a different diff is a
                    different tree. */}
                <PathTree items={files} pathOf={(f) => f.path} resetKey={rv.cwd + ":" + revOf(spec)}
                  renderFile={(f, indent) => (
                    <button className={"wf-row wf-tree-row" + (rv.open?.abs === f.abs ? " on" : "")}
                      style={{ paddingLeft: indent }}
                      onClick={() => rv.openFile(f)} title={f.path}>
                      <span className="wf-twist" />
                      <span className={"wf-mark wf-git " + f.status} title={STATUS_LABEL[f.status]}>
                        {STATUS_MARK[f.status]}
                      </span>
                      <span className="wf-name">
                        <span className="wf-nm">{basename(f.path)}</span>
                      </span>
                      {markFor(f.path)}
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
                  )} />
              </>
            )}
          </div>
          )}

          {/* The footer only exists once there is something to do with it: an empty
              review offers Approve, a written one offers Send. Before either, the
              column has no chrome at all. */}
          {!pending && changes?.repo && (
            <Footer rv={rv} onShowDraft={comments.length > 0 ? () => rv.setShowDraft(true) : undefined} />
          )}
        </>
      )}
    </aside>
  );
}

// Every discussion of this review, grouped by file, and below them the ones
// sibling reviews of the same repository hold. Cross-file because a discussion
// reachable only from its own line is one you cannot find.
function DiscussionIndex({ rv }: { rv: ReviewSession }) {
  const { discussions, others } = rv;
  const paths = [...new Set(discussions.map((d) => d.path))].sort();
  return (
    <div className="wf-body">
      {discussions.length === 0 && others.length === 0 && (
        <div className="wf-empty">
          No discussions yet. Pick a changed line in the diff and press Discuss to start one.
        </div>
      )}
      {paths.map((path) => (
        <div key={path}>
          <div className="wf-group">{path}</div>
          {discussions.filter((d) => d.path === path).sort((a, b) => a.line - b.line).map((d) => (
            <DiscussionCard key={d.id} d={d} inList acts={rv.discussionActs}
              onOpen={() => rv.openDiscussion(d)} />
          ))}
        </div>
      ))}
      {others.length > 0 && (
        <>
          {/* Another worktree, or another revision of this one. No Open: the
              path they name is in a checkout this canvas is not reading. */}
          <div className="wf-group rv-other">Other reviews of this repository</div>
          {others.map((d) => (
            <DiscussionCard key={d.id} d={d} inList
              acts={d.live ? rv.discussionActs : undefined}
              note={d.live ? undefined
                : "That worktree is gone — this is the record of it, and there is no code left to act on."} />
          ))}
        </>
      )}
    </div>
  );
}

// ---- the canvas: what is being reviewed, and the one file being read ----

export function ReviewCanvas({ rv }: { rv: ReviewSession }) {
  const setWorkspace = useStore((s) => s.setWorkspace);
  const sheet = useStore((s) => s.reviewSheet);
  const toggleReviewSheet = useStore((s) => s.toggleReviewSheet);
  const companionCollapsed = useStore((s) => s.companionCollapsed);
  const toggleCompanion = useStore((s) => s.toggleCompanion);
  const history = useStore((s) => s.reviewHistory);
  const pushReviewHistory = useStore((s) => s.pushReviewHistory);
  const reviewBack = useStore((s) => s.reviewBack);
  const reviewForward = useStore((s) => s.reviewForward);
  // The same capability the composer's "@" button is gated on: file references
  // ride on embeddedContext, and an agent without it drops them on send.
  const canAttach = useStore((s) => !!s.promptCapabilities.embeddedContext);
  const attachFiles = useStore((s) => s.attachFiles);
  const { open: loc, spec, scope, commit, log } = rv;
  // A location carries the revision it was opened against, and a CodeRef from
  // the conversation carries none — it names a line in the working file. Only a
  // location that IS what is being reviewed gets the draft's comment layer: a
  // comment written on a working-tree line would otherwise be saved against the
  // commit's draft, anchored to a line that commit never had.
  const onScope = revOf(loc?.spec) === revOf(spec);

  // Where the reader had got to in the file they are leaving, and in which
  // view. Refs, not state: both change on every scroll and every mode click,
  // neither is rendered, and only the moment a location is left behind reads
  // them.
  const scrollTop = useRef(0);
  const viewMode = useRef<PreviewMode>("diff");
  // The FileDiffResult the viewer has on screen, reported up as it lands. The
  // header's Reviewed toggle marks THAT — re-fetching the diff at click time is
  // how a checkout that moved on gets recorded as read.
  const [diff, setDiff] = useState<FileDiffResult | null>(null);
  const canvasRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    // Capture phase: scroll does not bubble, so React's onScroll would never
    // see the viewer's own scroller from out here.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.classList.contains("wf-body")) scrollTop.current = t.scrollTop;
    };
    el.addEventListener("scroll", onScroll, true);
    return () => el.removeEventListener("scroll", onScroll, true);
  }, []);

  // The canvas is unmounted while the Agent workspace is up, and the viewer's
  // scroller goes with it. The location carries the offset out so returning
  // lands where the reading was left, not at the top of the file.
  useEffect(() => () => {
    const { reviewPreview } = useStore.getState();
    if (reviewPreview) {
      useStore.setState({ reviewPreview: { ...reviewPreview, scrollTop: scrollTop.current, mode: viewMode.current } });
    }
  }, []);

  // Every arrival records the departure. Here rather than in each of the things
  // that navigate — a changed-file row, a CodeRef from the conversation, a
  // scope change that closes the file — because they all land in the same slot,
  // and only this component can measure where the reader had got to.
  const last = useRef<ReviewLoc | null>(null);
  const restoring = useRef(false);
  useEffect(() => {
    const prev = last.current;
    const leftAt = { scrollTop: scrollTop.current, mode: viewMode.current };
    last.current = loc;
    scrollTop.current = loc?.scrollTop ?? 0;
    viewMode.current = loc?.mode ?? "diff";
    // Walking the stacks is not a new navigation; pushing here would make Back
    // its own history.
    if (restoring.current) { restoring.current = false; return; }
    if (!prev) return;
    if (loc && prev.abs === loc.abs && revOf(prev.spec) === revOf(loc.spec) && prev.line === loc.line) return;
    pushReviewHistory({ ...prev, ...leftAt });
  }, [loc, pushReviewHistory]);

  const go = (back: boolean) => {
    if (!(back ? history.past.length : history.future.length)) return;
    restoring.current = true;
    const here = loc ? { ...loc, scrollTop: scrollTop.current, mode: viewMode.current } : null;
    const target = back ? history.past[history.past.length - 1] : history.future[0];
    // Only a location that named its revision re-selects one. A CodeRef named
    // none — opening it didn't change what is being reviewed, so retracing it
    // must not either.
    // The scope first, so React commits both in one render and the header never
    // draws a revision the canvas isn't reading.
    if (target.spec !== undefined) rv.restoreSpec(target.spec);
    if (back) reviewBack(here); else reviewForward(here);
  };

  // The button that opened the sheet, so Escape can hand focus back to it.
  const opener = useRef<HTMLButtonElement | null>(null);
  const compBtn = useRef<HTMLButtonElement>(null);
  const openSheet = (which: "files" | "companion") => (e: React.MouseEvent<HTMLButtonElement>) => {
    opener.current = e.currentTarget;
    toggleReviewSheet(which);
  };
  useEffect(() => {
    if (sheet === "none") return;
    // Same handoff as the floating conversation windows: the companion's own
    // composer consumes Escape to dismiss its slash/file menu, and says so by
    // preventing the default.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      toggleReviewSheet(sheet);
      opener.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet, toggleReviewSheet]);

  // An Ask or a Fix becomes a chip on the companion's composer, which is a
  // sheet over the canvas below 1100px and foldable away above it: without
  // this the reader is told to look at something they cannot see. Both are
  // cleared whichever width this is, so widening the window later cannot
  // uncover a companion that is still folded shut.
  const revealCompanion = () => {
    const st = useStore.getState();
    if (st.companionCollapsed) toggleCompanion();
    if (!isDesktopPanelWidth() && st.reviewSheet !== "companion") {
      // Nothing was clicked to raise this sheet, so Escape has no button to
      // hand focus back to — the one that would have raised it is the closest
      // thing, and it is on screen at every width this branch runs at.
      opener.current = compBtn.current;
      toggleReviewSheet("companion");
    }
  };

  // Comments on the open file, bucketed by the line they hang under, so the
  // viewer's lookup is per row rather than a scan of the whole draft.
  const byLine = new Map<string, ReviewComment[]>();
  if (loc) {
    for (const c of rv.comments) {
      if (c.path !== loc.path) continue;
      const key = anchorKey(c);
      const bucket = byLine.get(key);
      if (bucket) bucket.push(c);
      else byLine.set(key, [c]);
    }
  }

  // Three states from one row: unread, read, and read-then-changed. The last
  // reads as unpressed on purpose — the next click re-marks it against the diff
  // now on screen rather than dropping the mark.
  const readEntry = loc ? rv.reviewed.find((f) => f.path === loc.path) : undefined;
  const markedRead = !!readEntry && !readEntry.changed;

  const askFix = (intent: "ask" | "fix", anchor: DiffAnchor) => {
    if (!loc || !rv.activeId) return;
    revealCompanion();
    rv.setAskFix({
      intent, agentName: rv.agentName, sessionId: rv.activeId, cwd: rv.cwd, spec,
      path: loc.path, label: commit ? commit.shortSha + " " + commit.subject : undefined,
      side: anchor.side, line: anchor.line, code: anchor.code,
    });
  };

  return (
    <main className="canvas" ref={canvasRef}>
      <div className="rv-bar">
        <button className="icon-btn" title="Back to conversation" aria-label="Back to conversation"
          onClick={() => setWorkspace("agent")}><IconBack /></button>
        {/* The canvas's own history, not the browser's: every reference opened
            in here lands in one viewer, so retracing is this bar's job. */}
        <button className="icon-btn" title="Back" aria-label="Back" disabled={!history.past.length}
          onClick={() => go(true)}><IconArrow /></button>
        <button className="icon-btn" title="Forward" aria-label="Forward" disabled={!history.future.length}
          onClick={() => go(false)}><IconArrow right /></button>
        {/* The path, even for a location that no longer resolves: the body says
            what became of it, and swapping in a file that does resolve would
            quietly move the reader somewhere they never asked to be. */}
        <span className="rv-title" title={loc?.abs}>{loc ? loc.path : "Review"}</span>
        {/* Only below 1100px, where the two side columns overlay the canvas one
            at a time (see the stylesheet) — above it they are columns, and a
            button to reveal what is already on screen is noise. */}
        <button className="btn-sm rv-sheet" aria-pressed={sheet === "files"}
          onClick={openSheet("files")}>Files</button>
        <button className="btn-sm rv-sheet" ref={compBtn} aria-pressed={sheet === "companion"}
          onClick={openSheet("companion")}>Companion</button>
        {companionCollapsed && (
          <button className="icon-btn rv-uncollapse" title="Show companion" aria-label="Show companion"
            onClick={toggleCompanion}><IconChevrons left /></button>
        )}
        {/* Only for a diff of the revision being reviewed: a CodeRef opened at
            another one is not part of this review, and a file whose diff has no
            digest has nothing to identify what was read. */}
        {loc && onScope && diff && (
          <button className="btn-sm" aria-pressed={markedRead} disabled={!diff.hash}
            title={diff.hash ? undefined : diff.binary
              ? "A binary file has no diff to have read."
              : "This diff was too large to send whole, so there's nothing to mark."}
            onClick={() => rv.markReviewed(loc.path, diff.hash!, diff.revision, !markedRead)}>
            {markedRead ? "Reviewed" : "Mark reviewed"}
          </button>
        )}
        {/* Explicit, because nothing else here re-reads a diff: a turn ending
            refreshes the lists around it, and stops there. */}
        <button className="icon-btn" title="Refresh" onClick={rv.refresh}><IconRefresh /></button>
      </div>

      {/* What is being reviewed lives in the canvas header — it is a property of
          the whole workspace, not of the column that lists its files. */}
      <div className="rv-scope" role="tablist" aria-label="What to review">
        {(["working", "commits", "branch"] as Scope[]).map((s) => (
          <button key={s} role="tab" aria-selected={scope === s}
            className={"rv-chip" + (scope === s ? " on" : "")}
            onClick={() => rv.pick(s)}>
            {s === "working" ? "Working" : s === "commits" ? "Commits" : "Branch"}
          </button>
        ))}
        <span className="sp" />
        {scope === "branch" && !rv.editingBase && (
          <button className="rv-ref" onClick={() => rv.setEditingBase(true)}
            title="Compare against a different base">{rv.baseRef || "set a base…"}</button>
        )}
        {scope === "commits" && commit && (
          <button className="rv-ref" onClick={() => rv.pickCommit(null)} title="Back to the commit list">
            <IconBack />{commit.shortSha}
          </button>
        )}
      </div>

      {scope === "branch" && rv.editingBase && (
        <BaseEditor value={rv.baseRef} branch={log?.branch} onDone={rv.setBase} />
      )}

      {/* What the reviewer read is no longer what the file says. It flags and
          reoffers the diff; it clears nothing, because only a reader can say
          they have read something. */}
      {loc && onScope && readEntry?.changed && (
        <div className="rv-warn rv-changed">
          <span>Changed since you reviewed it</span>
          <button className="btn-sm" onClick={rv.reload}>Review new changes</button>
        </div>
      )}

      {/* Commits: the log, until one is picked. Picking re-asks every read above
          with ?rev=, which is why there is no separate detail screen. */}
      {scope === "commits" && !commit ? (
        <div className="wf-body">
          {log === null
            ? <div className="wf-empty">Reading history…</div>
            : log.commits.length === 0
              ? <div className="wf-empty">No commits in this folder yet.</div>
              : log.commits.map((c) => (
                  <button key={c.sha} className="wf-row rv-commit" onClick={() => rv.pickCommit(c)}
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
                ))}
        </div>
      ) : loc ? (
        // Keyed on the reload: "re-read everything now" includes this diff, and
        // a fresh viewer is the whole of what that means.
        <FileView key={rv.reloadKey} cwd={loc.cwd ?? rv.cwd} target={loc} spec={loc.spec ?? null}
          scrollTop={loc.scrollTop} onMode={(m) => { viewMode.current = m; }} onDiff={setDiff}
          review={onScope ? {
            comments: byLine,
            onAdd: (anchor, body) => rv.addComment(loc.path, anchor, body),
            onDelete: rv.deleteComment,
            onAskFix: rv.activeId ? askFix : undefined,
            discussion: {
              items: rv.discussions.filter((d) => d.path === loc.path),
              onCreate: (anchor, body, revision, diffHash) =>
                rv.createDiscussion(loc.path, anchor, body, revision, diffHash),
              acts: rv.discussionActs,
            },
          } : undefined}
          canAttach={canAttach}
          onAttach={(range, text) => attachFiles([makeRangeFile(loc.abs, basename(loc.path), range, text)])}
          // The selection is read out of the file as it is on disk, so it is
          // not the revision's — `spec: null` says so.
          onAskFix={rv.activeId ? (intent, range, text) => { revealCompanion(); rv.setAskFix({
            intent, agentName: rv.agentName, sessionId: rv.activeId!, cwd: rv.cwd, spec: null,
            path: loc.path, line: range.start, endLine: range.end, code: text,
          }); } : undefined} />
      ) : (
        <div className="wf-empty">Pick a changed file to read it here.</div>
      )}
    </main>
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

function Footer({ rv, onShowDraft }: { rv: ReviewSession; onShowDraft?: () => void }) {
  const n = rv.comments.length;
  return (
    <div className="rv-foot">
      <span className="rv-n">
        {n === 0 ? "No comments yet" : <><b>{n}</b> {n === 1 ? "comment" : "comments"}</>}
        {/* Said once, in the only place that can act on it: a draft that isn't
            being stored is a draft you should send before closing the tab. */}
        {!rv.persisted && n > 0 && <span className="rv-warn"> · not saved on the gateway</span>}
      </span>
      {onShowDraft && <button className="btn-sm" onClick={onShowDraft}>Review draft</button>}
      <button className="btn-sm primary" disabled={!rv.canSend} onClick={() => void rv.send(n === 0)}>
        {rv.sending ? "Sending…" : n === 0 ? "Approve" : "Send review"}
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
