import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store.ts";
import type { FilePreviewTarget, PreviewMode } from "../store/store.ts";
import {
  getWorkspaceChanges, getFileDiff, getFilePreview, rawFileUrl,
  type ChangeStatus, type ChangesResult, type FileDiffResult, type FilePreviewResult,
} from "../lib/api.ts";
import { touchedFiles } from "../lib/touchedFiles.ts";
import { mergePanelFiles, type PanelFile } from "../lib/panelFiles.ts";
import { fileKind, extensionOf } from "../lib/fileKind.ts";
import { highlightBlock, highlightLanguageFor } from "../lib/highlight.ts";
import { downloadFile } from "../lib/download.ts";
import { FileTree } from "./FileTree.tsx";
import { FileMenu, useRowMenu, type FileMenuTarget } from "./FileMenu.tsx";
import { makeAbsFile, makeRangeFile } from "../lib/mentions.ts";
import { rangeFromOffsets, sliceLines, formatRange, type LineRange } from "../lib/lineRange.ts";
import { copyText } from "../lib/clipboard.ts";
import type { MessageFile } from "../types.ts";
import { UnifiedDiff } from "./UnifiedDiff.tsx";
import { HtmlPreview } from "./HtmlPreview.tsx";
import { Markdown } from "./Markdown.tsx";
import { Plan } from "./Plan.tsx";
import { basename, dirname, formatBytes, relativeTo, timeAgo } from "../lib/format.ts";
import {
  clampPanelWidth, readPanelWidth, savePanelWidth, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH,
  DESKTOP_PANEL_QUERY, isDesktopPanelWidth,
} from "../lib/panelWidth.ts";
import { IconBack, IconX, IconRefresh, IconDownload, IconSpinner, IconChevronDown, IconChevronRight, IconAddToChat, fileIcon } from "../lib/icons.tsx";

// The file preview panel: what the agent actually produced, rather than what it
// said about it. Two modes, three lists and one viewer.
//
// SESSION is what this conversation did — the default, and the reason the panel
// exists:
//
//   Outputs — files this conversation WROTE, read back out of the thread's own
//             tool calls. "Show me what it made" is the question the panel is
//             opened to answer.
//   Context — files it only consulted. Same source, other half of the split.
//   Changes — git's view of the conversation's folder. Merged into Outputs, but
//             not optional: an agent that writes through a shell names no path
//             in any tool call, so for those turns — and for every codex and
//             opencode conversation, whose transcripts record no paths at all —
//             this is the ONLY source that shows the work.
//
// PROJECT is the folder itself, browsable. A separate mode rather than a fourth
// section: every list in Session is built FROM the conversation, so none of them
// knows about a file nobody has touched yet — a different question, needing the
// full height of the panel rather than whatever is left under three lists.
//
// The two modes are not the tabs this panel deliberately avoids. Those would
// have split the three Session lists, which answer one question between them
// ("what happened to files here") and were unusable when the reader had to guess
// which list knew about a given file. Session and Project answer questions you
// know which of you are asking.
//
// Opening a row shows its diff; a binary, an image, or an unchanged file falls
// through to the contents view on its own. The viewer takes over the whole
// panel, and Back returns to the mode you opened the file from.

type Section = "Progress" | "Outputs" | "Context";
type Mode = "session" | "project";

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

function FileRow({ lead, leadClass, leadTitle, name, dir, right, onClick, onMenu }: {
  lead: React.ReactNode; leadClass: string; leadTitle: string;
  name: string; dir: string; right?: React.ReactNode; onClick: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const menu = useRowMenu(onMenu);
  return (
    <button className="wf-row" onClick={onClick} {...menu} title={dir ? dir + "/" + name : name}>
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
function PanelRow({ file, cwd, onOpen, onMenu }: {
  file: PanelFile; cwd: string; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
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
      onMenu={onMenu}
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
function ContextRow({ path, label, cwd, onOpen, onMenu }: {
  path: string; label: string; cwd: string; onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const kind = fileKind(label);
  return (
    <FileRow lead={fileIcon(kind.icon)} leadClass="wf-kind" leadTitle={kind.category}
      name={label} dir={dirname(relativeTo(path, cwd))} onClick={onOpen} onMenu={onMenu} />
  );
}

export function FilePanel() {
  const open = useStore((s) => s.filesOpen);
  const target = useStore((s) => s.filePreview);
  const closeFiles = useStore((s) => s.closeFiles);
  const clearFilePreview = useStore((s) => s.clearFilePreview);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const attachFiles = useStore((s) => s.attachFiles);
  // The same capability the composer's "@" button is gated on: file references
  // ride on embeddedContext, and an agent without it drops them on send.
  const canAttach = useStore((s) => !!s.promptCapabilities.embeddedContext);
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const storeCwd = useStore((s) => s.cwd);
  // The folder to inspect is the one the *conversation* runs in. It can differ
  // from the store's current cwd: opening a session from another folder in the
  // sidebar leaves the picker where it was, and diffing the wrong checkout
  // would silently show an unrelated repo's changes.
  const cwd = session?.cwd || storeCwd;

  // Within Session: sections, not tabs — all three are on screen at once, and
  // each remembers whether it is folded. Progress leads because it is the answer
  // to "where is the agent up to", which is the question you open this panel
  // mid-turn to ask.
  const [folded, setFolded] = useState<Partial<Record<Section, boolean>>>({});
  const toggle = (name: Section) => setFolded((f) => ({ ...f, [name]: !f[name] }));
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  // The panel is closed and reopened rather than unmounted, so the mode
  // survives — someone browsing a folder and glancing away should come back to
  // where they were. A new folder is a different project, so that resets.
  const [mode, setMode] = useState<Mode>("session");
  useEffect(() => { setMode("session"); }, [cwd]);
  // Refresh re-lists the tree too, but nothing else does — see FileTree.
  const [treeKey, setTreeKey] = useState(0);
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
  const [desktop, setDesktop] = useState(isDesktopPanelWidth);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP_PANEL_QUERY);
    if (!mq) return;
    // Re-clamp on resize too: a width chosen on a wide window would otherwise
    // leave no room for the chat after the window shrinks.
    const sync = () => { setDesktop(mq.matches); setWidth((w) => clampPanelWidth(w)); };
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => { mq.removeEventListener("change", sync); window.removeEventListener("resize", sync); };
  }, []);

  // Which row was right-clicked / long-pressed, and where the menu goes. Null
  // is the ordinary state: no menu.
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  const openMenu = (abs: string, isDir: boolean, x: number, y: number) =>
    setMenu({ abs, name: basename(abs), dir: dirname(relativeTo(abs, cwd)), isDir, x, y });

  // Attaching is the one action here that has its result somewhere else — on the
  // composer. Below the desktop breakpoint this panel is a sheet ON TOP of the
  // chat, so the chip it just added would be behind it: get out of the way,
  // which is where you were going anyway.
  function attach(files: MessageFile[]) {
    attachFiles(files);
    if (!desktop) closeFiles();
  }

  const touched = touchedFiles(session?.items ?? []);
  const context = touched.filter((f) => f.role === "context");
  const outputs = mergePanelFiles(touched.filter((f) => f.role === "output"), changes?.files ?? []);
  // The two halves of Outputs, labelled rather than blended. `git status` runs
  // at the repo root, so its half carries work from other conversations, from
  // your own editor, from a reverted branch — and a row that reads as "this
  // conversation produced it" when nothing here wrote it is the panel lying.
  // mergePanelFiles already emits the thread's files first, so this only names
  // the boundary that was there.
  const written = outputs.filter((f) => f.fromThread);
  const alsoChanged = outputs.filter((f) => !f.fromThread);
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
          {/* Naming the folder is half of what the Project mode is for, and it
              is the only thing here that says WHICH checkout the lists describe
              when a session's cwd differs from the picker's. */}
          <span className="wf-title" title={target ? target.abs : cwd}>
            {target ? target.path : <>Files <span className="wf-cwd">{basename(cwd)}</span></>}
          </span>
          {!target && (
            <button className="icon-btn" title="Refresh" disabled={loading}
              onClick={() => { loadChanges(); setTreeKey((k) => k + 1); }}><IconRefresh /></button>
          )}
          <button className="icon-btn" title="Close" onClick={closeFiles}><IconX /></button>
        </div>

        {/* Hidden behind the viewer: a file's Back button already says where it
            returns to, and the switch would be a second, competing way out. */}
        {!target && (
          <div className="wf-switch" role="tablist" aria-label="What to show">
            <button role="tab" aria-selected={mode === "session"} className={mode === "session" ? "active" : ""}
              onClick={() => setMode("session")}>Session</button>
            <button role="tab" aria-selected={mode === "project"} className={mode === "project" ? "active" : ""}
              onClick={() => setMode("project")}>Project</button>
          </div>
        )}

        {target && (
          <FileView cwd={cwd} target={target} canAttach={canAttach}
            onAttach={(range, text) => attach([
              makeRangeFile(target.abs, basename(target.path), range, text),
            ])} />
        )}

        {!target && mode === "project" && (
          <FileTree cwd={cwd} reloadKey={treeKey}
            onOpenFile={(f) => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "file" })}
            onMenu={(f, x, y) => openMenu(f.abs, !!f.isDir, x, y)} />
        )}

        {!target && mode === "session" && (
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
              {/* Only worth a heading when there is something to tell it apart
                  from; on its own, the section title already says it. */}
              {written.length > 0 && alsoChanged.length > 0 && (
                <div className="wf-group">Written in this conversation</div>
              )}
              {written.map((f) => (
                <PanelRow key={f.abs} file={f} cwd={cwd}
                  onOpen={() => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "diff" })}
                  onMenu={(x, y) => openMenu(f.abs, false, x, y)} />
              ))}
              {alsoChanged.length > 0 && (
                <div className="wf-group">Other changes in this folder</div>
              )}
              {alsoChanged.map((f) => (
                <PanelRow key={f.abs} file={f} cwd={cwd}
                  onOpen={() => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "diff" })}
                  onMenu={(x, y) => openMenu(f.abs, false, x, y)} />
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
                  onOpen={() => openFilePreview({ abs: f.path, path: relativeTo(f.path, cwd), mode: "file" })}
                  onMenu={(x, y) => openMenu(f.path, false, x, y)} />
              ))}
            </Section>
          </div>
        )}
      </aside>
      {/* Outside the panel, not inside it: the menu is positioned against the
          viewport, and the panel is the one element here that animates in on a
          transform (which would re-anchor a fixed child to it). */}
      {menu && (
        <FileMenu target={menu} canAttach={canAttach}
          onAttach={() => attach([makeAbsFile(menu.abs, relativeTo(menu.abs, cwd))])}
          onOpen={menu.isDir ? undefined : () =>
            openFilePreview({ abs: menu.abs, path: relativeTo(menu.abs, cwd), mode: "file" })}
          onCopyPath={() => void copyText(menu.abs)}
          onClose={() => setMenu(null)} />
      )}
    </>
  );
}

// What is selected inside the rendered code, as whole lines. The offsets are
// walked out of the DOM rather than taken from the fetched text: a highlighted
// file is a tree of <span>s, and only a Range walk gives coordinates in the same
// string the element's own textContent is counted in.
function selectedRange(code: HTMLElement | null): LineRange | null {
  if (!code) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const picked = sel.getRangeAt(0);
  if (!code.contains(picked.startContainer) || !code.contains(picked.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(code);
  before.setEnd(picked.startContainer, picked.startOffset);
  const from = before.toString().length;
  return rangeFromOffsets(code.textContent ?? "", from, from + picked.toString().length);
}

function FileView({ cwd, target, canAttach, onAttach }: {
  cwd: string; target: FilePreviewTarget; canAttach: boolean;
  onAttach: (range: LineRange, text: string) => void;
}) {
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

  // The rendered code element, and which lines are selected inside it. Watched
  // through selectionchange rather than a mouseup: a selection is also made by
  // keyboard, by double-click, and by the touch handles, and only this event
  // sees all of them.
  const codeRef = useRef<HTMLElement>(null);
  const [range, setRange] = useState<LineRange | null>(null);
  useEffect(() => {
    setRange(null);
    if (mode !== "file") return;
    // Deliberately only ever arms the button, never disarms it. Pressing a
    // button IS what clears a selection on most platforms — the tap collapses
    // it before the click lands — so a handler that mirrored every collapse
    // would disable the button in the instant between pressing it and it
    // firing. What is armed stays armed until the lines are attached or the
    // file changes, and the button prints the range it holds, so it cannot
    // quietly attach something other than what it says.
    const sync = () => {
      const picked = selectedRange(codeRef.current);
      if (picked) setRange(picked);
    };
    document.addEventListener("selectionchange", sync);
    return () => document.removeEventListener("selectionchange", sync);
  }, [mode, target.abs]);

  function addSelection() {
    const text = codeRef.current?.textContent;
    if (!range || !text) return;
    onAttach(range, sliceLines(text, range));
    // Dropping the selection is the acknowledgement: on a phone the panel is
    // about to close over the chip, and on a desktop it stops the same lines
    // being added twice by a second click.
    window.getSelection()?.removeAllRanges();
    setRange(null);
  }

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
          //
          // Except a deleted one, which has nothing to fall through TO:
          // /workspace/file must 404 for a path that is no longer on disk, so
          // the switch turned "the agent removed this" into a red error. The
          // diff pane says so itself now.
          if (d.status !== "deleted" && (d.binary || !d.diff.trim()) && autoSwitched.current !== target.abs) {
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
  const ext = extensionOf(target.path);
  const isHtml = ext === "html" || ext === "htm";
  const isMarkdown = ext === "md" || ext === "markdown" || ext === "mdx";
  const canPreview = isHtml || isMarkdown;
  return (
    <>
      <div className="wf-modes">
        <button className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")}>Diff</button>
        <button className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>File</button>
        {canPreview && <button className={mode === "render" ? "active" : ""} onClick={() => setMode("render")}>Preview</button>}
        <span className="sp" />
        {/* Yields the room to the range while there is one: both at once
            overflow the toolbar on a phone-width panel. */}
        {file && !range && <span className="wf-meta">{formatBytes(file.size)}{file.modifiedAt ? " · " + timeAgo(file.modifiedAt) : ""}</span>}
        {/* Select lines in the file and they can go to the composer as an
            attachment. Present but dim with nothing selected — an action that
            only exists once you have already done the thing that enables it is
            an action nobody finds. */}
        {canAttach && mode === "file" && file?.kind === "text" && (
          <button type="button" className={"icon-btn wf-add" + (range ? " on" : "")} disabled={!range}
            onClick={addSelection}
            // Keeps the lines visibly selected while the button is pressed —
            // the default action of a mousedown is to collapse the selection.
            onMouseDown={(e) => e.preventDefault()}
            title={range
              ? "Add lines " + formatRange(range) + " to the chat"
              : "Select lines in the file to add them to the chat"}>
            <IconAddToChat />{range && <span className="lines">{formatRange(range)}</span>}
          </button>
        )}
        <DownloadButton raw={raw} name={basename(target.path)} />
      </div>
      <div className="wf-body">
        {err && <div className="wf-empty">{err}</div>}
        {!err && loading && <div className="wf-empty">Loading…</div>}
        {!err && !loading && mode === "diff" && diff && (
          // A deletion git can still describe — a tracked file removed from the
          // worktree — keeps its diff, and showing the lines that went is the
          // most useful thing the panel can do. It is the deletion git has NO
          // record of (a file the agent wrote and later removed through a
          // shell, or a staged `git rm`) that arrives with an empty diff, and
          // for that the honest answer is a sentence, not a blank pane.
          diff.status === "deleted" && !diff.diff.trim()
            ? <div className="wf-empty">This file has been deleted — there's nothing left on disk to show.</div>
            : diff.binary
              ? <div className="wf-empty">Binary file — there's nothing to diff. Switch to File to preview or download it.</div>
              : <UnifiedDiff diff={diff.diff} path={target.path} truncated={diff.truncated} />
        )}
        {!err && !loading && mode === "file" && file && <FileContents file={file} raw={raw} codeRef={codeRef} />}
        {!err && !loading && mode === "render" && file && (
          file.kind !== "text"
            ? <div className="wf-empty">Binary file — there's nothing to render. Switch to File to preview or download it.</div>
            : isHtml
              ? <>
                  <div className="wf-note">
                    Sandboxed preview — scripts can run, but the sandbox blocks it from reaching the
                    network, reading your session, or navigating away from this panel.
                    {file.truncated && " The file was cut short, so this preview may be incomplete."}
                  </div>
                  <HtmlPreview html={file.text ?? ""} />
                </>
              : <div className="wf-md-preview">
                  {file.truncated && <div className="wf-note">The file was cut short, so this preview may be incomplete.</div>}
                  <Markdown text={file.text ?? ""} />
                </div>
        )}
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

function FileContents({ file, raw, codeRef }: {
  file: FilePreviewResult; raw: string;
  // The element a selection is measured against — held by FileView, which owns
  // the toolbar button that acts on it.
  codeRef: React.RefObject<HTMLElement>;
}) {
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
          ? <code ref={codeRef} className="wf-hl" dangerouslySetInnerHTML={{ __html: html }} />
          : <code ref={codeRef}>{file.text}</code>}
      </pre>
      {file.truncated && <div className="wf-note">File truncated at {formatBytes(file.text?.length ?? 0)}.</div>}
    </>
  );
}
