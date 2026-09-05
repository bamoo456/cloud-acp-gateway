import { useEffect, useRef, useState } from "react";
import { useStore, useIsOpenFile } from "../store/store.ts";
import type { FilePreviewTarget, PreviewMode } from "../store/store.ts";
import {
  getWorkspaceChanges, getWorkspaceOutputs, getFileDiff, getFilePreview, getHtmlRender,
  getReviewDraft, rawFileUrl, saveFilePreview,
  type ChangesResult, type FileDiffResult, type FilePreviewResult,
  type HtmlRender, type OutputFolder,
} from "../lib/api.ts";
import { touchedFiles } from "../lib/touchedFiles.ts";
import { mergePanelFiles, outputFolderCandidates, type PanelFile } from "../lib/panelFiles.ts";
import { fileKind, extensionOf } from "../lib/fileKind.ts";
import { highlightBlock, highlightLanguageFor } from "../lib/highlight.ts";
import { downloadFile, downloadText } from "../lib/download.ts";
import { FileTree } from "./FileTree.tsx";
import { FileMenu, useRowMenu, type FileMenuTarget } from "./FileMenu.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { makeAbsFile, makeRangeFile } from "../lib/mentions.ts";
import { rangeFromOffsets, sliceLines, formatRange, type LineRange } from "../lib/lineRange.ts";
import { copyText } from "../lib/clipboard.ts";
import type { MessageFile } from "../types.ts";
import { UnifiedDiff } from "./UnifiedDiff.tsx";
import { HtmlPreview } from "./HtmlPreview.tsx";
import { Markdown } from "./Markdown.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { Plan } from "./Plan.tsx";
import { basename, dirname, formatBytes, relativeTo, timeAgo, STATUS_MARK, STATUS_LABEL } from "../lib/format.ts";
import { ReviewPanel } from "./ReviewPanel.tsx";
import {
  clampPanelWidth, readPanelWidth, savePanelWidth, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH,
  DESKTOP_PANEL_QUERY, isDesktopPanelWidth,
} from "../lib/panelWidth.ts";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { PathTree } from "./PathTree.tsx";
import { IconBack, IconX, IconRefresh, IconExpand, IconPanel, IconDownload, IconSpinner, IconChevronDown, IconChevronRight, IconAddToChat, IconSearch, IconFolder, IconCopy, IconPencil, IconCheck, fileIcon } from "../lib/icons.tsx";
import { findRanges, paintHits, clearHits, scrollToHit, MAX_HITS } from "../lib/findInFile.ts";

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
//   Folders — everything in a folder the conversation wrote into that git cannot
//             describe. Also merged into Outputs, and also not optional: a shell
//             writing OUTSIDE the checkout defeats both sources above at once,
//             which is what generating a mockup into /tmp does every time.
//
// PROJECT is the folder itself, browsable. A separate mode rather than a fourth
// section: every list in Session is built FROM the conversation, so none of them
// knows about a file nobody has touched yet — a different question, needing the
// full height of the panel rather than whatever is left under three lists. Which
// folder it browses is the reader's to change, and only the reader's: pointing
// it at another checkout reads that one, without moving the conversation, the
// composer or the next prompt (which is what the picker's setCwd would do).
//
// The two modes are not the tabs this panel deliberately avoids. Those would
// have split the three Session lists, which answer one question between them
// ("what happened to files here") and were unusable when the reader had to guess
// which list knew about a given file. Session and Project answer questions you
// know which of you are asking.
//
// Opening a row shows its diff; a binary, an image, or an unchanged file falls
// through to the contents view on its own. Given room the viewer opens BESIDE
// the list (see `split`), so the next file is one click away rather than one
// Back and one click; in a narrow panel it still takes the whole width, and
// Back returns to the mode you opened the file from.

type Section = "Progress" | "Outputs" | "Context";
type Mode = "session" | "project" | "review";

// The list keeps this much of the panel when the viewer opens beside it, and
// the viewer needs at least this much to be worth splitting for — under that a
// side-by-side diff is two unreadable columns instead of one readable one.
const LIST_WIDTH = 300;
const MIN_VIEW_WIDTH = 340;

// `indent` is where the row sits in its folder tree (see PathTree). The folder
// itself is a row of its own now, so the name is all this one carries — the
// path stays on the title, which is what a truncated deep name is hovered for.
function FileRow({ abs, lead, leadClass, leadTitle, name, dir, indent, right, onClick, onMenu }: {
  abs: string; lead: React.ReactNode; leadClass: string; leadTitle: string;
  name: string; dir: string; indent: number; right?: React.ReactNode; onClick: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const menu = useRowMenu(onMenu);
  // Which row the viewer is showing. Only visible while both are on screen —
  // in the takeover layout the list is behind the file it would be marking.
  const open = useIsOpenFile(abs);
  return (
    <button className={"wf-row wf-tree-row" + (open ? " on" : "")} onClick={onClick} {...menu}
      style={{ paddingLeft: indent }} title={dir ? dir + "/" + name : name}>
      {/* Where a folder row's twisty is, so names line up down the tree. */}
      <span className="wf-twist" />
      <span className={"wf-mark " + leadClass} title={leadTitle}>{lead}</span>
      <span className="wf-name">
        <span className="wf-nm">{name}</span>
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

// The one-line summary of the same read the panel does — null when the folder
// is clean, so the status bar and the tab badge can drop out entirely rather
// than saying "0 files".
function diffstat(r: ChangesResult) {
  if (!r.files.length) return null;
  return {
    files: r.files.length,
    additions: r.files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: r.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

// One file row. Its lead glyph is the whole answer to "does git know about
// this": a tracked-and-changed file gets git's own status letter, in git's own
// colours, and everything else — a file outside the repo, one written and
// reverted, one already committed — falls back to its type icon.
//
// Tool calls report absolute paths, and in a column this narrow the folder
// prefix every row shares would push the part that distinguishes them off the
// end. Show the path as it reads from the conversation's own folder.
function PanelRow({ file, cwd, indent, onOpen, onMenu }: {
  file: PanelFile; cwd: string; indent: number;
  onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const kind = fileKind(file.label);
  const git = file.git;
  const counts = git && ((git.additions ?? 0) + (git.deletions ?? 0) > 0 || git.binary);
  return (
    <FileRow
      abs={file.abs}
      lead={git ? STATUS_MARK[git.status] : fileIcon(kind.icon)}
      leadClass={git ? "wf-git " + git.status : "wf-kind"}
      leadTitle={git ? STATUS_LABEL[git.status] + (git.staged ? " (staged)" : "") : kind.category}
      name={file.label}
      dir={dirname(relativeTo(file.abs, cwd))}
      indent={indent}
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
function ContextRow({ path, label, cwd, indent, onOpen, onMenu }: {
  path: string; label: string; cwd: string; indent: number; onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const kind = fileKind(label);
  return (
    <FileRow abs={path} lead={fileIcon(kind.icon)} leadClass="wf-kind" leadTitle={kind.category}
      name={label} dir={dirname(relativeTo(path, cwd))} indent={indent}
      onClick={onOpen} onMenu={onMenu} />
  );
}

export function FilePanel() {
  const open = useStore((s) => s.filesOpen);
  const target = useStore((s) => s.filePreview);
  const closeFiles = useStore((s) => s.closeFiles);
  const clearFilePreview = useStore((s) => s.clearFilePreview);
  const openFilePreview = useStore((s) => s.openFilePreview);
  const attachFiles = useStore((s) => s.attachFiles);
  const setChangeStat = useStore((s) => s.setChangeStat);
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
  const [folders, setFolders] = useState<OutputFolder[]>([]);
  // Unsent review comments across every revision of this checkout. Loaded with
  // the change list, so the badge on the Review tab is right before that mode
  // has ever been opened — which is the only moment it is useful.
  const [reviewCount, setReviewCount] = useState(0);
  // The panel is closed and reopened rather than unmounted, so the mode
  // survives — someone browsing a folder and glancing away should come back to
  // where they were. A new folder is a different project, so that resets.
  const [mode, setMode] = useState<Mode>("session");
  // Which folder the Project tab is browsing, when that isn't the
  // conversation's own. Panel state rather than the store's cwd: switching the
  // picker would point the composer, the status bar and the next prompt at
  // another checkout, where all this wants is to READ one — which is the whole
  // of the cross-project case (a file over there, opened while working here).
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => { setMode("session"); setProjectRoot(null); }, [cwd]);
  const root = projectRoot ?? cwd;
  // Refresh re-lists the tree too, but nothing else does — see FileTree.
  const [treeKey, setTreeKey] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest request may write state: switching folders or hammering
  // refresh must not let a slow earlier `git status` land on top of a later one.
  const gen = useRef(0);
  // Review mode keeps its own reads (a revision this panel knows nothing about),
  // so it cannot ride on `changes`. Every reason to re-read the checkout goes
  // through the two loaders below, so bumping there is what reaches it — turn
  // end, Refresh, opening the panel.
  const [refreshKey, setRefreshKey] = useState(0);
  // The Refresh button only. Pressing it says "re-read everything now", which
  // includes the file open in Review — where a turn ending stops short, because
  // redrawing a diff someone is commenting on is the panel fighting them.
  const [reloadKey, setReloadKey] = useState(0);

  // What the conversation wrote, as the thread itself recorded it. Also the
  // source of the folder candidates below, so it is computed before the loader
  // that needs them rather than alongside the lists it feeds.
  const touched = touchedFiles(session?.items ?? []);

  function loadChanges() {
    const mine = ++gen.current;
    setRefreshKey((k) => k + 1);
    setLoading(true);
    getWorkspaceChanges(cwd)
      .then((r) => {
        if (mine !== gen.current) return;
        setChanges(r); setErr(null);
        // The status bar reports the same diffstat (§1.4) and has no reader of
        // its own, so publish the total here rather than fetching it twice.
        setChangeStat(diffstat(r));
      })
      .catch((e: Error) => { if (mine === gen.current) { setChanges(null); setChangeStat(null); setErr(e.message || "Couldn't read this folder's changes."); } })
      .finally(() => { if (mine === gen.current) setLoading(false); });
    // A separate request with a separate failure: a gateway too old to know the
    // route, or a folder that has since been deleted, must leave the git half of
    // Outputs alone rather than replacing the whole list with an error.
    getWorkspaceOutputs(cwd, outputFolderCandidates(touched.filter((f) => f.role === "output")))
      .then((r) => { if (mine === gen.current) setFolders(r); })
      .catch(() => { if (mine === gen.current) setFolders([]); });
    // Its own request and its own failure, for the same reason: a gateway too
    // old to know the route must leave the rest of the panel alone, and no badge
    // is the right answer there.
    getReviewDraft(cwd)
      .then((d) => {
        if (mine === gen.current) setReviewCount(Object.values(d.counts).reduce((n, c) => n + c, 0));
      })
      .catch(() => { if (mine === gen.current) setReviewCount(0); });
  }

  // With the panel shut, the count is still on screen — in the status bar, and
  // on a phone as the Changes tab's badge (§3 P5) — so the checkout is still
  // read, but only for that: no Outputs, no review draft, no file lists to
  // build for a panel nobody is looking at.
  function loadStat() {
    const mine = ++gen.current;
    // Bumped here too: the mode survives the panel being closed, so a Review
    // left open behind a shut panel must not come back showing the checkout as
    // it was before the last three turns.
    setRefreshKey((k) => k + 1);
    getWorkspaceChanges(cwd)
      .then((r) => { if (mine === gen.current) setChangeStat(diffstat(r)); })
      .catch(() => { if (mine === gen.current) setChangeStat(null); });
  }

  // The open panel reads the checkout because Outputs is built from it: git is
  // what supplies a row's status letter and line counts, and what surfaces the
  // files an agent wrote through a shell (which name no path in any tool call).
  useEffect(() => {
    if (open) loadChanges(); else loadStat();
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
    if (justFinished) { if (open) loadChanges(); else loadStat(); }
  }, [working, open]);

  // Width is applied inline, so it must only exist in column mode — below the
  // breakpoint the panel is a right-anchored sheet whose width the stylesheet
  // owns, and an inline value would override it.
  const [width, setWidth] = useState(readPanelWidth);
  const [desktop, setDesktop] = useState(isDesktopPanelWidth);
  // The window itself, which is all the expanded panel has to divide.
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP_PANEL_QUERY);
    if (!mq) return;
    // Re-clamp on resize too: a width chosen on a wide window would otherwise
    // leave no room for the chat after the window shrinks.
    const sync = () => { setDesktop(mq.matches); setWinWidth(window.innerWidth); setWidth((w) => clampPanelWidth(w)); };
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => { mq.removeEventListener("change", sync); window.removeEventListener("resize", sync); };
  }, []);

  // Expanded takes the whole window (see the stylesheet), for a wide diff or a
  // mockup that a 440px column cuts in half. Not persisted, and deliberately
  // separate from the dragged width: it is a look at one thing, not a new
  // shape for the panel to keep.
  const [expanded, setExpanded] = useState(false);

  // Opening a file EXTENDS the panel rather than replacing what is in it: the
  // list keeps its width and the viewer is added beside it, so the next file is
  // one click away instead of Back-then-click. Derived, never stored — the
  // dragged width stays the list's width, so closing the file gives the panel
  // back its own size with nothing to restore.
  //
  // Only where the result is readable. clampPanelWidth caps against the chat
  // column, so near the breakpoint the extra 300px simply isn't there; the
  // takeover layout is still the right answer for a sheet, a phone, and a
  // column too narrow to hold two panes.
  const extended = desktop && !expanded ? clampPanelWidth(width + LIST_WIDTH) : 0;
  const canSplit = expanded
    ? winWidth >= LIST_WIDTH + MIN_VIEW_WIDTH
    : extended - LIST_WIDTH >= MIN_VIEW_WIDTH;
  // Review's open file is its own state and it draws its own viewer pane (the
  // diff has comments written on it), so it reports up rather than going
  // through `filePreview` — but it widens the panel exactly the same way.
  const [reviewOpen, setReviewOpen] = useState(false);
  const split = canSplit && (!!target || reviewOpen);
  const panelWidth = split ? extended : width;
  // Folding the list away gives the whole extended panel to one diff — which is
  // what a wide file wants, and what the extra 300px was for. Hidden in CSS
  // rather than unmounted: the list keeps its scroll, its folded sections and a
  // browsed tree's open folders, and Review's list is inside Review's own pane
  // where no prop of ours reaches it. Sticky on purpose — someone who wants the
  // room wants it for the next file too.
  const [listFolded, setListFolded] = useState(false);

  // Which row was right-clicked / long-pressed, and where the menu goes. Null
  // is the ordinary state: no menu. `base` is the folder its path reads
  // against — the Project tab can be browsing another checkout entirely.
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  const openMenu = (abs: string, isDir: boolean, x: number, y: number, base = cwd) =>
    setMenu({ abs, name: basename(abs), dir: dirname(relativeTo(abs, base)), base, isDir, x, y });

  // Attaching is the one action here that has its result somewhere else — on the
  // composer. Below the desktop breakpoint this panel is a sheet ON TOP of the
  // chat, so the chip it just added would be behind it: get out of the way,
  // which is where you were going anyway.
  function attach(files: MessageFile[]) {
    attachFiles(files);
    if (!desktop) closeFiles();
  }

  const context = touched.filter((f) => f.role === "context");
  const outputs = mergePanelFiles(
    touched.filter((f) => f.role === "output"),
    changes?.files ?? [],
    folders.flatMap((f) => f.files),
  );
  // The three parts of Outputs, labelled rather than blended, because they are
  // three different strengths of claim. `git status` runs at the repo root, so
  // its part carries work from other conversations, from your own editor, from a
  // reverted branch; a folder listing is weaker still — it only says the file
  // sits next to something this conversation wrote. A row that reads as "this
  // conversation produced it" when nothing here wrote it is the panel lying.
  // mergePanelFiles already emits them in this order, so this only names the
  // boundaries that were there.
  const written = outputs.filter((f) => f.fromThread);
  const alsoChanged = outputs.filter((f) => !f.fromThread && !f.inWrittenFolder);
  const alsoInFolder = outputs.filter((f) => f.inWrittenFolder);
  // Only the thread's own heading is conditional. "Outputs" already reads as
  // "what this conversation produced", so naming that group when it is the only
  // one says nothing — while the weaker two must label themselves even alone,
  // or a row nothing here wrote inherits the section title's claim.
  const labelWritten = written.length > 0 && (alsoChanged.length > 0 || alsoInFolder.length > 0);
  // The agent's current plan, if it has published one. The last plan update wins
  // — ACP re-sends the whole list every time an entry changes.
  const plan = [...(session?.items ?? [])].reverse().find((it) => it.kind === "plan");
  // Read off `changes` rather than the store field: the store carries whichever
  // folder the panel last read, and in Review mode this panel is looking at a
  // revision the status bar knows nothing about.
  const stat = changes?.files.length
    ? {
      files: changes.files.length,
      additions: changes.files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: changes.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    }
    : null;

  return (
    <>
      {/* Mobile only (CSS): on desktop the panel is a column and dimming the
          chat behind it would be wrong. */}
      <div id="files-scrim" className={open ? "open" : ""} onClick={closeFiles} />
      <aside id="files" className={(open ? "open" : "") + (expanded ? " expanded" : "")} aria-hidden={!open}
        // No inline width while expanded: it would beat the stylesheet's
        // full-window rule, leaving a 440px panel pinned to the left edge.
        style={desktop && !expanded ? { width: panelWidth, maxWidth: panelWidth } : undefined}>
        {/* While split, the handle drags the whole panel and the list keeps
            what is left — anything else makes the edge jump by LIST_WIDTH the
            moment it is grabbed. */}
        {desktop && !expanded && <ResizeHandle className="wf-resize" label="Resize the files panel" edge="left" axis="x"
          size={panelWidth} min={MIN_PANEL_WIDTH} max={MAX_PANEL_WIDTH} clamp={clampPanelWidth}
          onSize={(px) => setWidth(clampPanelWidth(split ? px - LIST_WIDTH : px))}
          onCommit={(px) => savePanelWidth(clampPanelWidth(split ? px - LIST_WIDTH : px))} />}
        <div className="wf-head">
          {target && !split && (
            <button className="icon-btn" title="Back to file list" onClick={clearFilePreview}><IconBack /></button>
          )}
          {/* Naming the folder is half of what the Project mode is for, and it
              is the only thing here that says WHICH checkout the lists describe
              when a session's cwd differs from the picker's. */}
          {/* The summary folds into the header rather than taking a row of its
              own (§1.3): "Files repo · 7 files +128 −35". */}
          <span className="wf-title" title={target && !split ? target.abs : cwd}>
            {target && !split ? target.path : (
              <>
                Files <span className="wf-cwd">{basename(cwd)}</span>
                {stat && <span className="wf-stat">
                  {stat.files} file{stat.files === 1 ? "" : "s"}
                  {stat.additions > 0 && <b className="add">+{stat.additions}</b>}
                  {stat.deletions > 0 && <b className="del">−{stat.deletions}</b>}
                </span>}
              </>
            )}
          </span>
          {(!target || split) && (
            <button className="icon-btn" title="Refresh" disabled={loading}
              onClick={() => { loadChanges(); setTreeKey((k) => k + 1); setReloadKey((k) => k + 1); }}><IconRefresh /></button>
          )}
          {/* Only while there are two panes — with one, folding it away would
              leave the panel showing nothing. */}
          {split && (
            <button className="icon-btn" aria-pressed={!listFolded}
              title={listFolded ? "Show the file list" : "Hide the file list"}
              onClick={() => setListFolded((v) => !v)}><IconPanel left /></button>
          )}
          <button className="icon-btn" aria-pressed={expanded} title={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((v) => !v)}><IconExpand collapse={expanded} /></button>
          <button className="icon-btn" title="Close" onClick={closeFiles}><IconX /></button>
        </div>

        {/* Hidden behind the viewer while it has the panel to itself: a file's
            Back button already says where it returns to, and the switch would
            be a second, competing way out. Beside the viewer it is the list's
            own control again — and it spans both panes, because which mode the
            panel is in is the panel's question, not the list's. Folded away
            with the list it belongs to: "just the file, please" means the
            vertical room too, and the header's toggle brings both back. */}
        {(!target || (split && !listFolded)) && (
          <div className="wf-switch" role="tablist" aria-label="What to show">
            <button role="tab" aria-selected={mode === "session"} className={mode === "session" ? "active" : ""}
              onClick={() => setMode("session")}>Session</button>
            <button role="tab" aria-selected={mode === "project"} className={mode === "project" ? "active" : ""}
              onClick={() => setMode("project")}>Project</button>
            {/* The badge is the only thing that says an unsent review exists
                while you are looking at something else. It counts every scope's
                draft, not the open one's: "you have comments waiting" is the
                claim, and which revision they are on is the mode's own business. */}
            <button role="tab" aria-selected={mode === "review"} className={mode === "review" ? "active" : ""}
              onClick={() => setMode("review")}>
              Review{reviewCount > 0 && <span className="wf-badge">{reviewCount}</span>}
            </button>
          </div>
        )}

        {/* One row of panes: the list, the viewer, or — given the room — both.
            `.split` is what lays them side by side; without it whichever one is
            rendered has the panel to itself, which is the narrow layout. */}
        <div className={"wf-panes" + (split ? " split" : "") + (split && listFolded ? " folded" : "")}>
          {(!target || split) && mode !== "review" && (
            <div className="wf-list">

              {mode === "project" && (
                <>
                  {/* Which folder the tree is reading. The session's own is the
                      default and needs no bar of its own — this only earns its row
                      once the panel can point somewhere else, which is the whole
                      point of it: reading a file in the other checkout you are
                      porting a change to, without moving this conversation. */}
                  <div className="wf-root">
                    <button className="wf-root-pick" onClick={() => setBrowsing(true)} title={root}>
                      <IconFolder /><span className="nm">{basename(root)}</span><IconChevronDown />
                    </button>
                    {projectRoot && (
                      <button className="linkish" onClick={() => setProjectRoot(null)}>
                        Back to {basename(cwd)}
                      </button>
                    )}
                  </div>
                  {/* Keyed on the root: a different project is a different tree, and
                      its expansions and search are not this one's. */}
                  <FileTree key={root} cwd={root} reloadKey={treeKey}
                    onOpenFile={(f) => openFilePreview({
                      abs: f.abs, path: relativeTo(f.abs, root), mode: "file",
                      // Only when it isn't the conversation's folder: the gateway
                      // resolves the path against whatever cwd it is sent.
                      cwd: projectRoot ?? undefined,
                    })}
                    onMenu={(f, x, y) => openMenu(f.abs, !!f.isDir, x, y, root)} />
                </>
              )}

              {mode === "session" && (
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
                    {labelWritten && (
                      <div className="wf-group">Written in this conversation</div>
                    )}
                    {/* Each half of Outputs is its own tree: the group headings
                        are the split that matters here, and one tree across
                        them would fold a written file in beside a stranger's
                        change. */}
                    <PathTree items={written} pathOf={(f) => relativeTo(f.abs, cwd)} resetKey={cwd}
                      renderFile={(f, indent) => (
                        <PanelRow file={f} cwd={cwd} indent={indent}
                          onOpen={() => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "diff" })}
                          onMenu={(x, y) => openMenu(f.abs, false, x, y)} />
                      )} />
                    {alsoChanged.length > 0 && (
                      <div className="wf-group">Other changes in this folder</div>
                    )}
                    <PathTree items={alsoChanged} pathOf={(f) => relativeTo(f.abs, cwd)} resetKey={cwd}
                      renderFile={(f, indent) => (
                        <PanelRow file={f} cwd={cwd} indent={indent}
                          onOpen={() => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "diff" })}
                          onMenu={(x, y) => openMenu(f.abs, false, x, y)} />
                      )} />
                    {alsoInFolder.length > 0 && (
                      <div className="wf-group">Also in folders this conversation wrote to</div>
                    )}
                    {/* Opens on the file, not on a diff: these rows exist precisely
                        because git cannot describe them, so there is no diff to show
                        and the viewer would only bounce itself to the contents view. */}
                    <PathTree items={alsoInFolder} pathOf={(f) => relativeTo(f.abs, cwd)} resetKey={cwd}
                      renderFile={(f, indent) => (
                        <PanelRow file={f} cwd={cwd} indent={indent}
                          onOpen={() => openFilePreview({ abs: f.abs, path: relativeTo(f.abs, cwd), mode: "file" })}
                          onMenu={(x, y) => openMenu(f.abs, false, x, y)} />
                      )} />
                    {folders.some((f) => f.truncated) && (
                      <div className="wf-note">Those folders hold more than this list shows.</div>
                    )}
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
                    <PathTree items={context} pathOf={(f) => relativeTo(f.path, cwd)} resetKey={cwd}
                      renderFile={(f, indent) => (
                        <ContextRow path={f.path} label={f.label} cwd={cwd} indent={indent}
                          onOpen={() => openFilePreview({ abs: f.path, path: relativeTo(f.path, cwd), mode: "file" })}
                          onMenu={(x, y) => openMenu(f.path, false, x, y)} />
                      )} />
                  </Section>
                </div>
              )}
            </div>
          )}

          {/* Its own two panes, not a list inside ours: a review's detail is
              its diff WITH the comments written on it, which only this
              component can draw. Keyed on cwd so a folder change restarts the
              review rather than leaving one checkout's draft over another's. */}
          {(!target || split) && mode === "review" && (
            <ReviewPanel key={cwd} cwd={cwd} refreshKey={refreshKey} reloadKey={reloadKey} onCount={setReviewCount}
              split={canSplit} onDetail={setReviewOpen} />
          )}

          {target && (
            <div className="wf-view">
              {/* The header's title is the folder's again while the list is on
                  screen, so the file names itself here — and closes here, since
                  Back is gone with it. */}
              {split && (
                <div className="wf-view-head" title={target.abs}>
                  {/* Which checkout, which folder, which file — the three
                      questions the old bare filename left open. Not links:
                      there is nothing for a click on a folder to DO from here
                      (the tree owns its own expansion), and a link that does
                      nothing is worse than plain text. Only the middle shrinks
                      — the root and the filename are the two parts you always
                      need, and they are the two a narrow panel would cut. */}
                  {/* Only a file the gateway gave a relative path for is
                      actually under this checkout — an absolute one came from a
                      preview root or a sibling folder, and naming the checkout
                      in front of it would claim a home it doesn't have. */}
                  <span className="wf-crumb">
                    {!target.path.startsWith("/") && (
                      <><span className="root">{basename(target.cwd ?? cwd)}</span><span className="sl">/</span></>
                    )}
                    {dirname(target.path) !== "." && (
                      <><span className="mid">{dirname(target.path)}</span><span className="sl">/</span></>
                    )}
                    <span className="leaf">{basename(target.path)}</span>
                  </span>
                  <button className="icon-btn" title="Copy path"
                    onClick={() => void copyText(target.abs)}><IconCopy /></button>
                  <button className="icon-btn" title="Close file" onClick={clearFilePreview}><IconX /></button>
                </div>
              )}
              <FileView cwd={target.cwd ?? cwd} target={target} canAttach={canAttach}
                onAttach={(range, text) => attach([
                  makeRangeFile(target.abs, basename(target.path), range, text),
                ])} />
            </div>
          )}
        </div>
      </aside>
      {/* Rendered outside the panel for the same reason the menu is: it is a
          fixed-position modal, and the panel is a transformed ancestor. */}
      {browsing && (
        <FolderBrowser
          onUse={(p) => { setProjectRoot(p === cwd ? null : p); setBrowsing(false); }}
          onBack={() => setBrowsing(false)} onClose={() => setBrowsing(false)} />
      )}
      {/* Outside the panel, not inside it: the menu is positioned against the
          viewport, and the panel is the one element here that animates in on a
          transform (which would re-anchor a fixed child to it). */}
      {menu && (
        <FileMenu target={menu} canAttach={canAttach}
          onAttach={() => attach([makeAbsFile(menu.abs, relativeTo(menu.abs, menu.base ?? cwd))])}
          onOpen={menu.isDir ? undefined : () =>
            openFilePreview({
              abs: menu.abs, path: relativeTo(menu.abs, menu.base ?? cwd), mode: "file",
              cwd: menu.base === cwd ? undefined : menu.base,
            })}
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
  const [render, setRender] = useState<HtmlRender | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // ---- editing ----
  // `edit` is both the flag and the buffer: null is "not editing", and the
  // string is what will be saved. `conflict` holds a refused save's answer —
  // the file as it is now — which is the only state where two versions of the
  // same file exist at once and the reader has to pick.
  const [edit, setEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ text: string; hash: string } | null>(null);
  // Somebody else writing this checkout right now. Scoped to sessions whose cwd
  // IS this folder, not the store's global `busy`: that one is true while any
  // conversation anywhere works, and a save here has nothing to do with a turn
  // running in another project.
  // The folder this file is READ AND SAVED against, which is not always the
  // panel's own: Project mode can point at a second checkout. Everything that
  // has to agree with the save — the warning below, the guard the gateway will
  // apply — is keyed off this one value rather than three copies of it.
  const fileCwd = target.cwd ?? cwd;
  const agentWorkingHere = useStore((s) =>
    Object.keys(s.busySessionIds).some((id) => s.sessions[id]?.cwd === fileCwd));
  // Which file we've already redirected away from the diff view for. Without
  // it, a manual click back onto "Diff" for a file that has no diff would be
  // bounced straight back to "File" — the redirect is a first-open default,
  // not a rule.
  const autoSwitched = useRef<string | null>(null);

  useEffect(() => { setMode(target.mode); }, [target.abs, target.mode]);
  // A different file is a different edit. Dropping the buffer silently is safe
  // only because opening another file takes a click on the list, which is not
  // something you do mid-sentence — and the alternative, blocking navigation on
  // a confirm, makes the panel modal over a textarea nobody asked to keep.
  useEffect(() => { setEdit(null); setConflict(null); setSaveErr(null); }, [target.abs]);

  // The rendered code element, and which lines are selected inside it. Watched
  // through selectionchange rather than a mouseup: a selection is also made by
  // keyboard, by double-click, and by the touch handles, and only this event
  // sees all of them.
  const codeRef = useRef<HTMLElement>(null);
  const [range, setRange] = useState<LineRange | null>(null);
  useEffect(() => {
    setRange(null);
    // Not while editing: the rendered <code> the selection is measured against
    // isn't on screen, and "add these lines to the chat" is not an offer to
    // make about text that hasn't been saved yet.
    if (mode !== "file" || edit !== null) return;
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
  }, [mode, target.abs, edit]);

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

  // ---- find in file ----
  // The search surface is the whole body, so one implementation covers the
  // diff, the file and the rendered markdown. Not the HTML preview: that is an
  // iframe, and no highlight of ours reaches inside it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [hits, setHits] = useState<Range[]>([]);
  const [hit, setHit] = useState(0);

  // Anything that re-renders the body is a new document to search: a mode
  // switch, a finished load, a different file.
  useEffect(() => {
    setHits(findOpen ? findRanges(bodyRef.current, find.trim()) : []);
    setHit(0);
  }, [findOpen, find, mode, loading, file, diff, render]);

  useEffect(() => {
    paintHits(hits, hit);
    scrollToHit(bodyRef.current, hits[hit]);
  }, [hits, hit]);

  // Highlights outlive the component that registered them (see clearHits).
  useEffect(() => clearHits, []);

  // Wraps at both ends — a search that stops dead at the last match sends you
  // back to the box to retype what you already typed.
  const step = (d: number) => { if (hits.length) setHit((i) => (i + d + hits.length) % hits.length); };
  const closeFind = () => { setFindOpen(false); setFind(""); };

  // Two conditions, and between them they are the whole of what a save needs.
  //
  // The digest is the gateway's own answer to "could this file be written" — it
  // issues one for a whole text read inside the write cap and for nothing else,
  // so binary, images, truncated previews and oversized files are all covered
  // without restating any of them here.
  //
  // Containment it cannot answer, because the read guard is deliberately wider
  // than the write guard: the viewer opens files from the preview roots and from
  // sibling folders in the repo, and a save to any of those will be refused. The
  // display path is what says which side of that line a file is on — the gateway
  // sends a cwd-relative path when it can and falls back to the absolute one
  // when it can't, so an absolute path here IS "outside the folder we would
  // write to". Better a pencil that is dim than one that fails after you type.
  const insideCwd = !target.path.startsWith("/");
  const canEdit = mode === "file" && file?.kind === "text"
    && !!file.hash && file.text !== undefined && insideCwd;

  function startEdit() {
    if (!canEdit || file?.text === undefined) return;
    // The find bar searches the rendered body, and the textarea is not in it —
    // left open it would sit there reporting 0/0 over text it cannot see.
    closeFind();
    setSaveErr(null);
    setConflict(null);
    setEdit(file.text);
  }

  async function save() {
    if (edit === null || !file?.hash) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await saveFilePreview(fileCwd, target.abs, restoreEol(edit, file.text ?? ""), file.hash);
      if (!r.ok) { setConflict({ text: r.text, hash: r.hash }); return; }
      // Straight back to reading, with the file the save produced. Not a
      // re-fetch: the response already says what is on disk, and the digest it
      // carries is what a second edit would need anyway.
      setFile({ ...file, text: edit, size: r.size, modifiedAt: r.modifiedAt, hash: r.hash });
      setEdit(null);
    } catch (e) {
      setSaveErr((e as Error).message || "Couldn't save this file.");
    } finally {
      setSaving(false);
    }
  }

  const raw = rawFileUrl(cwd, target.abs);
  const ext = extensionOf(target.path);
  const isHtml = ext === "html" || ext === "htm";
  const isMarkdown = ext === "md" || ext === "markdown" || ext === "mdx";
  const canPreview = isHtml || isMarkdown;

  // An HTML preview needs the document with its assets inlined — see
  // getHtmlRender. Its own request, alongside the plain text one above rather
  // than instead of it: the text is what the File tab shows and what this falls
  // back to while the render is in flight or if the gateway has no such route.
  useEffect(() => {
    if (mode !== "render" || !isHtml) return;
    let alive = true;
    setRender(null);
    getHtmlRender(cwd, target.abs)
      .then((r) => { if (alive) setRender(r); })
      .catch(() => { /* the un-inlined text still renders, broken images and all */ });
    return () => { alive = false; };
  }, [cwd, target.abs, mode, isHtml]);
  return (
    <>
      {/* The toolbar is the card's header rather than a bar floating over the
          content: with the body edge-to-edge there was nothing to say the two
          belonged together. The card continues the flex column so .wf-body is
          still the thing that scrolls. */}
      <div className="wf-card">
      <div className="wf-modes">
        {/* Locked while editing: every one of them replaces the body the
            textarea is in, and none of them has anything to say about text that
            is only in the browser. */}
        <button className={mode === "diff" ? "active" : ""} disabled={edit !== null}
          onClick={() => setMode("diff")}>Diff</button>
        <button className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>File</button>
        {canPreview && <button className={mode === "render" ? "active" : ""} disabled={edit !== null}
          // An HTML preview is an iframe, which no search of ours reaches into
          // — leaving the bar open there would only ever report 0/0.
          onClick={() => { setMode("render"); if (isHtml) closeFind(); }}>Preview</button>}
        {/* Beside the tabs, not across the toolbar from them: what it describes
            is the file those tabs are showing, and pinned to the far edge it
            read as a third, unrelated thing. Yields the room to the range while
            there is one — both at once overflow a phone-width panel.
            No line count for a truncated file: the number would be the
            preview's, and the preview is not the file. */}
        {file && !range && (
          <span className="wf-meta">
            {file.kind === "text" && !file.truncated && file.text !== undefined
              && countLines(file.text) + " lines · "}
            {formatBytes(file.size)}{file.modifiedAt ? " · " + timeAgo(file.modifiedAt) : ""}
          </span>
        )}
        <span className="sp" />
        {/* One bordered cluster rather than three loose glyphs: they are the
            file's actions, and grouped they also cost less width than spaced. */}
        <span className="wf-acts">
          {/* Small fixes from wherever you are, which is the whole scope: a flag
              in a config, a line in a prompt. Anything bigger is what the agent
              in the next pane is for. Shown greyed rather than hidden on a file
              it can't touch — "why can't I edit this" is answerable, "where did
              the pencil go" is not. */}
          {mode === "file" && file && file.kind === "text" && (
            <button type="button" className={"icon-btn wf-edit" + (edit !== null ? " on" : "")}
              disabled={!canEdit || edit !== null}
              onClick={startEdit}
              title={canEdit ? "Edit this file"
                : !insideCwd ? "This file is outside " + basename(fileCwd) + ", so it can only be read here"
                : file.truncated || !file.hash ? "This file is too big to edit here"
                : "This file can't be edited here"}>
              <IconPencil />
            </button>
          )}
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
          {!(mode === "render" && isHtml) && (
            // Off while editing for the same reason it is closed on the way in:
            // the search reads the rendered body, and a textarea's value is not
            // in it — the bar would sit there reporting 0/0 over your own text.
            <button type="button" className={"icon-btn wf-search-btn" + (findOpen ? " on" : "")}
              disabled={edit !== null}
              onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
              title={edit !== null ? "Finish editing to search this file"
                : findOpen ? "Close search" : "Find in this file"}>
              <IconSearch />
            </button>
          )}
          <DownloadButton raw={raw} name={basename(target.path)}
            selfContained={mode === "render" && isHtml && render && render.inlined > 0 ? render.html : undefined} />
        </span>
      </div>
      {/* Its own row rather than a field in the toolbar: at 390px that bar
          already carries three mode buttons and two icons. */}
      {findOpen && (
        <div className="wf-search">
          <input autoFocus value={find} placeholder="Find in file" aria-label="Find in file"
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { closeFind(); return; }
              if (e.key !== "Enter") return;
              // Enter would otherwise submit nothing and dismiss the phone's
              // keyboard, which is the opposite of stepping through matches.
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }} />
          <span className="n">
            {find.trim() === "" ? "" : hits.length === 0 ? "0/0"
              : `${hit + 1}/${hits.length}${hits.length === MAX_HITS ? "+" : ""}`}
          </span>
          <button type="button" className="icon-btn prev" disabled={!hits.length}
            onClick={() => step(-1)} title="Previous match"><IconChevronDown /></button>
          <button type="button" className="icon-btn" disabled={!hits.length}
            onClick={() => step(1)} title="Next match"><IconChevronDown /></button>
          <button type="button" className="icon-btn" onClick={closeFind} title="Close search"><IconX /></button>
        </div>
      )}
      {/* The editor REPLACES the body rather than sitting inside it: .wf-body is
          a block scroller for rendered content, so a textarea in there gets no
          flex context and collapses to its default two rows. Out here the card's
          own column gives it the height, and it does its own scrolling. */}
      {edit !== null && (
        <textarea className="wf-edit-area" value={edit} spellCheck={false} autoFocus
          aria-label={"Edit " + target.path}
          onChange={(e) => setEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setEdit(null); setConflict(null); setSaveErr(null); return; }
            // The footer's button is the discoverable way; this is the one you
            // reach for once you have used it twice.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }} />
      )}
      <div className="wf-body" ref={bodyRef} hidden={edit !== null}>
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
                    {/* Which is also why the assets had to be inlined, so say what
                        that did. A skipped reference is the one thing a reader
                        would otherwise blame on the document. */}
                    {render && render.inlined > 0 &&
                      ` ${render.inlined} ${render.inlined === 1 ? "asset" : "assets"} inlined from the file's own folder.`}
                    {render && render.skipped > 0 &&
                      ` ${render.skipped} couldn't be — remote URLs, external scripts, and types or paths this preview won't inline.`}
                    {render?.truncated && " Some were too large to inline."}
                    {(render?.htmlTruncated || (!render && file.truncated)) &&
                      " The file was cut short, so this preview may be incomplete."}
                  </div>
                  <HtmlPreview html={render?.html ?? file.text ?? ""} />
                </>
              : <div className="wf-md-preview">
                  {file.truncated && <div className="wf-note">The file was cut short, so this preview may be incomplete.</div>}
                  {/* The document's own folder, so `![](docs/shot.png)` next to
                      it resolves to the file rather than to the console's origin. */}
                  <Markdown text={file.text ?? ""} diagrams
                    images={{ cwd, dir: dirname(target.abs) }} />
                </div>
        )}
      </div>
      {edit !== null && (
        <>
          {/* A warning, never a lock. A turn can run for minutes, and refusing
              to save for its duration costs more than the occasional refused
              save — which the digest catches anyway, with both versions in hand. */}
          {agentWorkingHere && !conflict && (
            <div className="wf-strip warn">
              A conversation is working in this folder. If it writes this file first, your save will be
              refused rather than overwrite it.
            </div>
          )}
          {conflict && (
            <div className="wf-strip err">
              This file changed after you opened it, so nothing was saved — your edit is still above.
            </div>
          )}
          {saveErr && <div className="wf-strip err">{saveErr}</div>}
          <div className="wf-edit-foot">
            {/* No automatic merge: the two versions were written by different
                authors minutes apart, and guessing which lines survive is the
                one thing a panel this size should not do. Copy, look, decide. */}
            {conflict
              ? <>
                  <span className="hint">Copy yours, then reload to see theirs.</span>
                  <span className="sp" />
                  <button className="wf-btn" onClick={() => void copyText(edit)}>Copy mine</button>
                  <button className="wf-btn danger" onClick={() => {
                    setFile((f) => (f ? { ...f, text: conflict.text, hash: conflict.hash } : f));
                    setEdit(null);
                    setConflict(null);
                  }}>Discard mine, load theirs</button>
                </>
              : <>
                  <span className="hint">⌘↵ to save · Esc to cancel</span>
                  <span className="sp" />
                  <button className="wf-btn" disabled={saving}
                    onClick={() => { setEdit(null); setSaveErr(null); }}>Cancel</button>
                  <button className="wf-btn primary" disabled={saving || edit === file?.text}
                    onClick={() => void save()}>
                    {saving ? <IconSpinner /> : <IconCheck />}{saving ? "Saving…" : "Save"}
                  </button>
                </>}
          </div>
        </>
      )}
      </div>
    </>
  );
}

// Line endings as the file had them. A textarea normalises every \r\n in its
// value to \n, so saving one straight back rewrites the ending of every line in
// a CRLF file — a whole-file diff nobody asked for, and the kind that is only
// noticed by whoever reviews it. Mixed endings are unified to whatever the file
// had more of a claim to: if it contained a \r\n at all, it gets \r\n.
function restoreEol(next: string, original: string): string {
  return original.includes("\r\n") ? next.replace(/\r?\n/g, "\r\n") : next;
}

// Lines as a reader counts them: a file ending in a newline has not got an
// extra empty last line, which is what a bare split would claim.
function countLines(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

// Saves through a blob rather than linking straight at /workspace/raw. An
// <a href download> is a top-level navigation, and the native client hosts this
// console in a WKWebView that answers an attachment response by killing the
// frame (WebKitErrorDomain 102) and showing "Can't reach gateway" — so the
// Download button used to throw you out of the UI. See lib/download.ts.
// `selfContained`, when set, is the document to save INSTEAD of the bytes on
// disk: an HTML preview whose assets have been inlined. Saving the file itself
// there would hand over the copy whose relative image paths resolve nowhere else
// — which is the thing someone downloading a mockup is trying to avoid.
function DownloadButton({ raw, name, selfContained }: {
  raw: string; name: string; selfContained?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    Promise.resolve()
      .then(() => (selfContained !== undefined
        ? downloadText(selfContained, "text/html", name)
        : downloadFile(raw, name)))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" className={"icon-btn wf-dl" + (failed ? " failed" : "")} onClick={save} disabled={busy}
      title={failed ? "Couldn't download this file — tap to retry"
        : selfContained !== undefined ? "Download this page with its images included"
        : "Download this file"}>
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
  // Full size opens in an overlay rather than a new tab — see Lightbox, which
  // the markdown preview's own images share.
  const [zoom, setZoom] = useState(false);
  if (file.kind === "image") {
    return (
      <>
        <div className="wf-image">
          <button type="button" onClick={() => setZoom(true)} title="View full size">
            <img src={raw} alt={file.path} />
          </button>
        </div>
        {zoom && <Lightbox src={raw} alt={file.path} onClose={() => setZoom(false)} />}
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
      {/* No byte count: the only one to hand was the decoded string's length,
          which is UTF-16 units and reads about half the truth for CJK text.
          The toolbar already carries the file's real size — what this row has
          to say is that the text above isn't all of it. */}
      {file.truncated && (
        <div className="wf-note">Showing the start of this file — the rest was too large to preview.</div>
      )}
    </>
  );
}
