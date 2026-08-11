import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store.ts";
import type { FilePreviewTarget, PreviewMode } from "../store/store.ts";
import {
  getWorkspaceChanges, getFileDiff, getFilePreview, rawFileUrl,
  type ChangeStatus, type ChangesResult, type FileDiffResult, type FilePreviewResult,
} from "../lib/api.ts";
import { touchedFiles } from "../lib/touchedFiles.ts";
import { mergePanelFiles, type PanelFile } from "../lib/panelFiles.ts";
import { fileKind } from "../lib/fileKind.ts";
import { highlightBlock, highlightLanguageFor } from "../lib/highlight.ts";
import { downloadFile } from "../lib/download.ts";
import { UnifiedDiff } from "./UnifiedDiff.tsx";
import { Plan } from "./Plan.tsx";
import { basename, dirname, formatBytes, relativeTo, timeAgo } from "../lib/format.ts";
import { clampPanelWidth, readPanelWidth, savePanelWidth, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH } from "../lib/panelWidth.ts";
import { IconBack, IconX, IconRefresh, IconDownload, IconSpinner, IconChevronDown, IconChevronRight, fileIcon } from "../lib/icons.tsx";

// The file preview panel: what the agent actually produced, rather than what it
// said about it. Three lists and one viewer.
//
//   Outputs — files this conversation WROTE, read back out of the thread's own
//             tool calls. The default: "show me what it made" is the question
//             the panel exists to answer.
//   Context — files it only consulted. Same source, other half of the split.
//   Changes — git's view of the conversation's folder. Last, because it answers
//             a different question ("what is dirty in my checkout"), but not
//             optional: an agent that writes through a shell names no path in
//             any tool call, so for those turns — and for every codex and
//             opencode conversation, whose transcripts record no paths at all —
//             this is the ONLY list that shows the work.
//
// Opening a row shows its diff; a binary, an image, or an unchanged file falls
// through to the contents view on its own.

type Section = "Progress" | "Outputs" | "Context";

// The width below which the panel is an overlay sheet rather than a column —
// the same 1100px the stylesheet uses. Resizing only means anything in column
// mode, and an inline width would fight the sheet's own layout.
const DESKTOP = "(min-width: 1100px)";

// Drag the panel's left edge to set its width. A separator rather than a bare
// div: it is focusable and answers the arrow keys, so the panel is resizable
// without a pointer.
function ResizeHandle({ width, onWidth, onCommit }: {
  width: number; onWidth: (px: number) => void; onCommit: (px: number) => void;
}) {
  const latest = useRef(width);
  latest.current = width;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    // Dragging over the chat would otherwise select its text, and the cursor
    // would flicker back to a caret the moment it left the 6px handle.
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const next = clampPanelWidth(startW + (startX - ev.clientX));
      latest.current = next;
      onWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      onCommit(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 12;
    // Left widens: the panel is anchored to the right edge, so its border moving
    // left is the panel growing.
    const delta = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = clampPanelWidth(width + delta);
    onWidth(next);
    onCommit(next);
  };

  return (
    <div className="wf-resize" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="Resize the files panel" aria-valuenow={width}
      aria-valuemin={MIN_PANEL_WIDTH} aria-valuemax={MAX_PANEL_WIDTH}
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
  );
}

const STATUS_MARK: Record<ChangeStatus, string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U",
};
const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", untracked: "New file",
};

function FileRow({ lead, leadClass, leadTitle, name, dir, right, onClick }: {
  lead: React.ReactNode; leadClass: string; leadTitle: string;
  name: string; dir: string; right?: React.ReactNode; onClick: () => void;
}) {
  return (
    <button className="wf-row" onClick={onClick} title={dir ? dir + "/" + name : name}>
      <span className={"wf-mark " + leadClass} title={leadTitle}>{lead}</span>
      <span className="wf-name">
        <span className="wf-nm">{name}</span>
        {dir && <span className="wf-dir">{dir}</span>}
      </span>
      {right}
    </button>
  );
}

// A collapsible band in the panel. Vertical sections rather than tabs because
// the three lists answer one question between them — "what happened to files
// here" — and tabs made the reader guess which of them knew about a given file
// before they could look for it.
function Section({ title, count, open, onToggle, children }: {
  title: string; count?: number; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <section className={"wf-sec" + (open ? " open" : "")}>
      <button className="wf-sec-head" onClick={onToggle} aria-expanded={open} data-section={title.toLowerCase()}>
        <span className="wf-chev">{open ? <IconChevronDown /> : <IconChevronRight />}</span>
        <span className="wf-sec-title">{title}</span>
        {count !== undefined && count > 0 && <span className="wf-sec-count">{count}</span>}
      </button>
      {open && <div className="wf-sec-body">{children}</div>}
    </section>
  );
}

// One file row. Its lead glyph is the whole answer to "does git know about
// this": a tracked-and-changed file gets git's own status letter, in git's own
// colours, and everything else — a file outside the repo, one written and
// reverted, one already committed — falls back to its type icon.
//
// Tool calls report absolute paths, and in a column this narrow the folder
// prefix every row shares would push the part that distinguishes them off the
// end. Show the path as it reads from the conversation's own folder.
function PanelRow({ file, cwd, onOpen }: { file: PanelFile; cwd: string; onOpen: () => void }) {
  const kind = fileKind(file.label);
  const git = file.git;
  const counts = git && ((git.additions ?? 0) + (git.deletions ?? 0) > 0 || git.binary);
  return (
    <FileRow
      lead={git ? STATUS_MARK[git.status] : fileIcon(kind.icon)}
      leadClass={git ? "wf-git " + git.status : "wf-kind"}
      leadTitle={git ? STATUS_LABEL[git.status] + (git.staged ? " (staged)" : "") : kind.category}
      name={file.label}
      dir={dirname(relativeTo(file.abs, cwd))}
      onClick={onOpen}
      right={counts ? (
        <span className="wf-counts">
          {git!.binary
            ? <span className="bin">bin</span>
            : <>
                {(git!.additions ?? 0) > 0 && <span className="add">+{git!.additions}</span>}
                {(git!.deletions ?? 0) > 0 && <span className="del">−{git!.deletions}</span>}
              </>}
        </span>
      ) : undefined}
    />
  );
}

// Context rows never carry git status — the question there is "what did the
// agent read", and whether that file also happens to be dirty is someone else's
// business.
function ContextRow({ path, label, cwd, onOpen }: {
  path: string; label: string; cwd: string; onOpen: () => void;
}) {
  const kind = fileKind(label);
  return (
    <FileRow lead={fileIcon(kind.icon)} leadClass="wf-kind" leadTitle={kind.category}
      name={label} dir={dirname(relativeTo(path, cwd))} onClick={onOpen} />
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

  // Sections, not tabs — all three are on screen at once, and each remembers
  // whether it is folded. Progress leads because it is the answer to "where is
  // the agent up to", which is the question you open this panel mid-turn to ask.
  const [folded, setFolded] = useState<Partial<Record<Section, boolean>>>({});
  const toggle = (name: Section) => setFolded((f) => ({ ...f, [name]: !f[name] }));
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

  // Fetched whenever the panel is open, because Outputs now depends on it: git
  // is what supplies a row's status letter and line counts, and what surfaces
  // the files an agent wrote through a shell (which name no path in any tool
  // call). Still gated on `open` — with the panel shut, nobody is looking.
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

  // Width is applied inline, so it must only exist in column mode — below the
  // breakpoint the panel is a right-anchored sheet whose width the stylesheet
  // owns, and an inline value would override it.
  const [width, setWidth] = useState(readPanelWidth);
  const [desktop, setDesktop] = useState(() => window.matchMedia?.(DESKTOP).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP);
    if (!mq) return;
    // Re-clamp on resize too: a width chosen on a wide window would otherwise
    // leave no room for the chat after the window shrinks.
    const sync = () => { setDesktop(mq.matches); setWidth((w) => clampPanelWidth(w)); };
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => { mq.removeEventListener("change", sync); window.removeEventListener("resize", sync); };
  }, []);

  const touched = touchedFiles(session?.items ?? []);
  const context = touched.filter((f) => f.role === "context");
  const outputs = mergePanelFiles(touched.filter((f) => f.role === "output"), changes?.files ?? []);
  // The agent's current plan, if it has published one. The last plan update wins
  // — ACP re-sends the whole list every time an entry changes.
  const plan = [...(session?.items ?? [])].reverse().find((it) => it.kind === "plan");

  return (
    <>
      {/* Mobile only (CSS): on desktop the panel is a column and dimming the
          chat behind it would be wrong. */}
      <div id="files-scrim" className={open ? "open" : ""} onClick={closeFiles} />
      <aside id="files" className={open ? "open" : ""} aria-hidden={!open}
        style={desktop ? { width, maxWidth: width } : undefined}>
        {desktop && <ResizeHandle width={width} onWidth={setWidth} onCommit={savePanelWidth} />}
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
          <div className="wf-body">
            {plan && plan.kind === "plan" && plan.entries.length > 0 && (
              <Section title="Progress" open={!folded.Progress} onToggle={() => toggle("Progress")}>
                <Plan entries={plan.entries} heading={false} />
              </Section>
            )}

            <Section title="Outputs" count={outputs.length}
              open={!folded.Outputs} onToggle={() => toggle("Outputs")}>
              {err && <div className="wf-empty">{err}</div>}
              {!err && loading && !changes && outputs.length === 0 && (
                <div className="wf-empty">Reading changes…</div>
              )}
              {!err && outputs.length === 0 && !loading && (
                <div className="wf-empty">Nothing written in this conversation yet.</div>
              )}
              {outputs.map((f) => (
                <PanelRow key={f.abs} file={f} cwd={cwd}
                  onOpen={() => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "diff" })} />
              ))}
              {/* Without git the list is only what tool calls named — no
                  shell-written file, nothing another conversation changed. Say
                  so rather than letting a short list read as a quiet turn. */}
              {!err && changes?.repo === null && (
                <div className="wf-note">
                  {changes.reason === "git-missing"
                    ? "git isn't installed on the gateway host, so only files this conversation named are listed."
                    : "This folder isn't a git checkout, so only files this conversation named are listed."}
                </div>
              )}
              {changes?.truncated && (
                <div className="wf-note">Showing the first {changes.files.length} changed files.</div>
              )}
            </Section>

            <Section title="Context" count={context.length}
              open={!folded.Context} onToggle={() => toggle("Context")}>
              {context.length === 0 && (
                <div className="wf-empty">No files consulted in this conversation yet.</div>
              )}
              {context.map((f) => (
                <ContextRow key={f.path} path={f.path} label={f.label} cwd={cwd}
                  onOpen={() => openFilePreview({ abs: f.path, path: relativeTo(f.path, cwd), mode: "file" })} />
              ))}
            </Section>
          </div>
        )}
      </aside>
    </>
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
            : <UnifiedDiff diff={diff.diff} path={target.path} truncated={diff.truncated} />
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
    <button type="button" className={"icon-btn wf-dl" + (failed ? " failed" : "")} onClick={save} disabled={busy}
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
  // One text node for the whole file when it isn't coloured: a per-line
  // element turns a 5,000-line file into tens of thousands of DOM nodes, and
  // every later layout pass in this tab pays for them — the same cost that
  // forced Markdown's highlight cap. highlightBlock enforces the same budget
  // here (see its own cap), so a large file still falls back to this.
  const lang = highlightLanguageFor(file.path);
  const html = lang && file.text ? highlightBlock(file.text, lang) : null;
  return (
    <>
      <pre className="wf-text">
        {html != null
          ? <code className="wf-hl" dangerouslySetInnerHTML={{ __html: html }} />
          : <code>{file.text}</code>}
      </pre>
      {file.truncated && <div className="wf-note">File truncated at {formatBytes(file.text?.length ?? 0)}.</div>}
    </>
  );
}
