import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store.ts";
import type { FilePreviewTarget, PreviewMode } from "../store/store.ts";
import {
  getWorkspaceChanges, getFileDiff, getFilePreview, rawFileUrl,
  type ChangeStatus, type ChangedFile, type ChangesResult, type FileDiffResult, type FilePreviewResult,
} from "../lib/api.ts";
import { touchedFiles } from "../lib/touchedFiles.ts";
import { downloadFile } from "../lib/download.ts";
import { UnifiedDiff } from "./UnifiedDiff.tsx";
import { basename, dirname, formatBytes, timeAgo } from "../lib/format.ts";
import { IconBack, IconX, IconRefresh, IconDownload, IconSpinner } from "../lib/icons.tsx";

// The file preview panel: what the agent actually produced, rather than what it
// said about it. Two lists and one viewer.
//
//   Changes — git's view of the conversation's folder. Answers "what is
//             different in my checkout now", including files the agent created
//             (untracked) and ones it deleted.
//   Session — files this conversation touched, read back out of the thread's
//             own tool calls. Includes files only *read*, and files changed and
//             then reverted, which git can no longer see.
//
// Opening a row shows its diff; a binary, an image, or an unchanged file falls
// through to the contents view on its own.

const STATUS_MARK: Record<ChangeStatus, string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U",
};
const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", untracked: "New file",
};

function FileRow({ mark, markClass, markTitle, name, dir, right, onClick }: {
  mark: string; markClass: string; markTitle: string;
  name: string; dir: string; right?: React.ReactNode; onClick: () => void;
}) {
  return (
    <button className="wf-row" onClick={onClick} title={dir ? dir + "/" + name : name}>
      <span className={"wf-mark " + markClass} title={markTitle}>{mark}</span>
      <span className="wf-name">
        <span className="wf-nm">{name}</span>
        {dir && <span className="wf-dir">{dir}</span>}
      </span>
      {right}
    </button>
  );
}

export function FilePanel() {
  const open = useStore((s) => s.filesOpen);
  const target = useStore((s) => s.filePreview);
  const closeFiles = useStore((s) => s.closeFiles);
  const clearFilePreview = useStore((s) => s.clearFilePreview);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const storeCwd = useStore((s) => s.cwd);
  // The folder to inspect is the one the *conversation* runs in. It can differ
  // from the store's current cwd: opening a session from another folder in the
  // sidebar leaves the picker where it was, and diffing the wrong checkout
  // would silently show an unrelated repo's changes.
  const cwd = session?.cwd || storeCwd;

  const [tab, setTab] = useState<"changes" | "session">("changes");
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest request may write state: switching folders or hammering
  // refresh must not let a slow earlier `git status` land on top of a later one.
  const gen = useRef(0);

  function loadChanges() {
    const mine = ++gen.current;
    setLoading(true);
    getWorkspaceChanges(cwd)
      .then((r) => { if (mine === gen.current) { setChanges(r); setErr(null); } })
      .catch((e: Error) => { if (mine === gen.current) { setChanges(null); setErr(e.message || "Couldn't read this folder's changes."); } })
      .finally(() => { if (mine === gen.current) setLoading(false); });
  }

  // Fetch when the panel opens and whenever the folder changes. Gated on `open`
  // on purpose: unlike the sessions sidebar this panel is never a persistent
  // column, and a `git status` on every folder switch with the panel shut would
  // be a cold walk of the whole tree for something nobody is looking at.
  useEffect(() => {
    if (!open) return;
    loadChanges();
    // The panel is closed and reopened, not unmounted, so retire any in-flight
    // request on the way out rather than letting it repaint a stale list later.
    return () => { gen.current++; };
  }, [open, cwd]);

  // A turn ending is the moment the list is most likely wrong: the agent just
  // finished writing. Refresh then, so the panel doesn't need a manual poke
  // after every prompt.
  const working = !!session?.working;
  const wasWorking = useRef(working);
  useEffect(() => {
    const justFinished = wasWorking.current && !working;
    wasWorking.current = working;
    if (justFinished && open) loadChanges();
  }, [working, open]);

  const touched = touchedFiles(session?.items ?? []);
  const files = changes?.files ?? [];

  return (
    <>
      {/* Mobile only (CSS): on desktop the panel is a column and dimming the
          chat behind it would be wrong. */}
      <div id="files-scrim" className={open ? "open" : ""} onClick={closeFiles} />
      <aside id="files" className={open ? "open" : ""} aria-hidden={!open}>
        <div className="wf-head">
          {target && (
            <button className="icon-btn" title="Back to file list" onClick={clearFilePreview}><IconBack /></button>
          )}
          <span className="wf-title" title={target ? target.abs : cwd}>
            {target ? target.path : "Files"}
          </span>
          {!target && (
            <button className="icon-btn" title="Refresh" onClick={loadChanges} disabled={loading}><IconRefresh /></button>
          )}
          <button className="icon-btn" title="Close" onClick={closeFiles}><IconX /></button>
        </div>

        {target && <FileView cwd={cwd} target={target} />}

        {!target && (
          <>
            <div className="wf-tabs" role="tablist">
              <button className={"wf-tab" + (tab === "changes" ? " active" : "")} data-tab="changes"
                role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
                Changes{files.length > 0 ? ` (${files.length})` : ""}
              </button>
              <button className={"wf-tab" + (tab === "session" ? " active" : "")} data-tab="session"
                role="tab" aria-selected={tab === "session"} onClick={() => setTab("session")}>
                Session{touched.length > 0 ? ` (${touched.length})` : ""}
              </button>
            </div>
            <div className="wf-body">
              {tab === "changes" && (
                <>
                  {err && <div className="wf-empty">{err}</div>}
                  {!err && loading && !changes && <div className="wf-empty">Reading changes…</div>}
                  {!err && changes?.repo === null && (
                    <div className="wf-empty">
                      {changes.reason === "git-missing"
                        ? "git isn't installed on the gateway host, so file changes can't be listed."
                        : "This folder isn't a git repository, so there's nothing to compare against."}
                    </div>
                  )}
                  {!err && changes?.repo && files.length === 0 && (
                    <div className="wf-empty">No changes in this folder.</div>
                  )}
                  {files.map((f) => (
                    <ChangeRow key={f.path} file={f} onOpen={() => openFilePreview({ abs: f.abs, path: f.path, mode: "diff" })} />
                  ))}
                  {changes?.truncated && <div className="wf-note">Showing the first {files.length} changed files.</div>}
                </>
              )}
              {tab === "session" && (
                <>
                  {touched.length === 0 && (
                    <div className="wf-empty">No files touched in this conversation yet.</div>
                  )}
                  {touched.map((f) => (
                    <FileRow key={f.path} mark="" markClass="file" markTitle="File"
                      name={f.label} dir={dirname(f.path)}
                      onClick={() => openFilePreview({ abs: f.path, path: f.label, mode: "diff" })} />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function ChangeRow({ file, onOpen }: { file: ChangedFile; onOpen: () => void }) {
  const counts = (file.additions ?? 0) + (file.deletions ?? 0) > 0 || file.binary;
  return (
    <FileRow
      mark={STATUS_MARK[file.status]}
      markClass={file.status}
      markTitle={STATUS_LABEL[file.status] + (file.staged ? " (staged)" : "")}
      name={basename(file.path)}
      dir={dirname(file.path)}
      onClick={onOpen}
      right={counts ? (
        <span className="wf-counts">
          {file.binary
            ? <span className="bin">bin</span>
            : <>
                {(file.additions ?? 0) > 0 && <span className="add">+{file.additions}</span>}
                {(file.deletions ?? 0) > 0 && <span className="del">−{file.deletions}</span>}
              </>}
        </span>
      ) : undefined}
    />
  );
}

function FileView({ cwd, target }: { cwd: string; target: FilePreviewTarget }) {
  const [mode, setMode] = useState<PreviewMode>(target.mode);
  const [diff, setDiff] = useState<FileDiffResult | null>(null);
  const [file, setFile] = useState<FilePreviewResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Which file we've already redirected away from the diff view for. Without
  // it, a manual click back onto "Diff" for a file that has no diff would be
  // bounced straight back to "File" — the redirect is a first-open default,
  // not a rule.
  const autoSwitched = useRef<string | null>(null);

  useEffect(() => { setMode(target.mode); }, [target.abs, target.mode]);

  useEffect(() => {
    let alive = true;
    setErr(null);
    setLoading(true);
    const done = () => { if (alive) setLoading(false); };
    if (mode === "diff") {
      getFileDiff(cwd, target.abs)
        .then((d) => {
          if (!alive) return;
          setDiff(d);
          // Nothing to render as a diff — a binary blob, an image, or a file
          // the agent only read. Show the file itself instead of an empty pane.
          if ((d.binary || !d.diff.trim()) && autoSwitched.current !== target.abs) {
            autoSwitched.current = target.abs;
            setMode("file");
          }
        })
        .catch((e: Error) => { if (alive) setErr(e.message || "Couldn't read this file's diff."); })
        .finally(done);
    } else {
      getFilePreview(cwd, target.abs)
        .then((f) => { if (alive) setFile(f); })
        .catch((e: Error) => { if (alive) setErr(e.message || "Couldn't open this file."); })
        .finally(done);
    }
    return () => { alive = false; };
  }, [cwd, target.abs, mode]);

  const raw = rawFileUrl(cwd, target.abs);
  return (
    <>
      <div className="wf-modes">
        <button className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")}>Diff</button>
        <button className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>File</button>
        <span className="sp" />
        {file && <span className="wf-meta">{formatBytes(file.size)}{file.modifiedAt ? " · " + timeAgo(file.modifiedAt) : ""}</span>}
        <DownloadButton raw={raw} name={basename(target.path)} />
      </div>
      <div className="wf-body">
        {err && <div className="wf-empty">{err}</div>}
        {!err && loading && <div className="wf-empty">Loading…</div>}
        {!err && !loading && mode === "diff" && diff && (
          diff.binary
            ? <div className="wf-empty">Binary file — there's nothing to diff. Switch to File to preview or download it.</div>
            : <UnifiedDiff diff={diff.diff} truncated={diff.truncated} />
        )}
        {!err && !loading && mode === "file" && file && <FileContents file={file} raw={raw} />}
      </div>
    </>
  );
}

// Saves through a blob rather than linking straight at /workspace/raw. An
// <a href download> is a top-level navigation, and the native client hosts this
// console in a WKWebView that answers an attachment response by killing the
// frame (WebKitErrorDomain 102) and showing "Can't reach gateway" — so the
// Download button used to throw you out of the UI. See lib/download.ts.
function DownloadButton({ raw, name }: { raw: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    downloadFile(raw, name)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" className="icon-btn wf-dl" onClick={save} disabled={busy}
      title={failed ? "Couldn't download this file — tap to retry" : "Download this file"}>
      {busy ? <IconSpinner /> : <IconDownload />}
    </button>
  );
}

function FileContents({ file, raw }: { file: FilePreviewResult; raw: string }) {
  // Full-size viewing is an overlay inside the app, not target="_blank". The
  // panel is narrow and a screenshot is the thing you most want to zoom into,
  // but a new-window request in the native client's WKWebView has nowhere to go
  // — it is silently dropped when the host app implements no UI delegate, and
  // navigates away from the console when it does.
  const [zoom, setZoom] = useState(false);
  if (file.kind === "image") {
    return (
      <>
        <div className="wf-image">
          <button type="button" onClick={() => setZoom(true)} title="View full size">
            <img src={raw} alt={file.path} />
          </button>
        </div>
        {zoom && (
          <div className="wf-lightbox" role="dialog" aria-label={file.path} onClick={() => setZoom(false)}>
            <img src={raw} alt={file.path} />
            <button type="button" className="icon-btn" title="Close" onClick={() => setZoom(false)}><IconX /></button>
          </div>
        )}
      </>
    );
  }
  if (file.kind === "binary") {
    return (
      <div className="wf-empty">
        Binary file ({formatBytes(file.size)}). Use the download button above to open it locally.
      </div>
    );
  }
  return (
    <>
      {/* One text node for the whole file, deliberately: a per-line element (or
          a syntax-highlighted span per token) turns a 5,000-line file into tens
          of thousands of DOM nodes, and every later layout pass in this tab pays
          for them — the same cost that forced Markdown's highlight cap. */}
      <pre className="wf-text"><code>{file.text}</code></pre>
      {file.truncated && <div className="wf-note">File truncated at {formatBytes(file.text?.length ?? 0)}.</div>}
    </>
  );
}
