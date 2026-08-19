import { useEffect, useRef, useState } from "react";
import { getWorkspaceTree, findWorkspaceFiles, grepWorkspace, type TreeEntry, type FoundFile, type GrepFile } from "../lib/api.ts";
import { fileKind } from "../lib/fileKind.ts";
import { formatBytes } from "../lib/format.ts";
import { IconFolder, IconChevronDown, IconChevronRight, fileIcon } from "../lib/icons.tsx";
import { useRowMenu } from "./FileMenu.tsx";
import { useIsOpenFile } from "../store/store.ts";

// Browsing the project, rather than only the files this conversation happened
// to name. Outputs and Context are built from the thread, so they are blind to
// everything the agent never touched — including the file you want to read
// *before* asking for a change.
//
// Lazy by construction: a folder is listed when it is opened and not before, so
// the cost of a large tree is paid only by whoever walks into it. What a
// listing shows is git's answer, not a hardcoded ignore list — an ignored entry
// is dimmed rather than hidden, because "why isn't dist here" is a worse
// question than "why is dist grey".

// Depth is indentation only; the fetch cares about the path.
const INDENT_PX = 12;
// Which of the two searches the box is running. Names answers from a cached
// index; Contents runs `git grep` on the gateway, so it waits for the typing to
// settle and refuses a term short enough to match every file in the project.
type Scope = "name" | "text";
const GREP_DEBOUNCE_MS = 300;
const MIN_GREP_LEN = 2;

function Row({ entry, depth, open, onClick, onMenu }: {
  entry: TreeEntry; depth: number; open?: boolean; onClick: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const kind = fileKind(entry.name);
  const menu = useRowMenu(onMenu);
  // Marks the row the viewer is showing — the point of keeping the tree on
  // screen beside it.
  const showing = useIsOpenFile(entry.abs);
  return (
    <button
      className={"wf-row wf-tree-row" + (entry.ignored ? " ignored" : "") + (showing ? " on" : "")}
      style={{ paddingLeft: 10 + depth * INDENT_PX }}
      onClick={onClick}
      {...menu}
      title={entry.ignored ? entry.abs + " — git ignores this" : entry.abs}
    >
      <span className="wf-twist">
        {entry.dir ? (open ? <IconChevronDown /> : <IconChevronRight />) : null}
      </span>
      <span className={"wf-mark wf-kind"}>{entry.dir ? <IconFolder /> : fileIcon(kind.icon)}</span>
      <span className="wf-name"><span className="wf-nm">{entry.name}</span></span>
      {!entry.dir && entry.size !== undefined && (
        <span className="wf-size">{formatBytes(entry.size)}</span>
      )}
    </button>
  );
}

// One expanded directory's children, fetched on mount. A component per level
// rather than one flattened list, so opening a folder deep in the tree doesn't
// re-fetch — or re-render — anything above it.
function Level({ cwd, dir, depth, onOpenFile, onMenu }: {
  cwd: string; dir?: string; depth: number; onOpenFile: (e: TreeEntry) => void;
  onMenu: (e: TreeEntry, x: number, y: number) => void;
}) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setErr(null);
    getWorkspaceTree(cwd, dir)
      .then((r) => { if (alive) { setEntries(r.entries); setTruncated(r.truncated); } })
      .catch((e: Error) => { if (alive) setErr(e.message || "Couldn't list this folder."); });
    return () => { alive = false; };
  }, [cwd, dir]);

  const toggle = (abs: string) => setOpen((s) => {
    const next = new Set(s);
    // Closing a folder drops its Level, and with it every expansion inside —
    // which is the behaviour a tree is expected to have.
    if (!next.delete(abs)) next.add(abs);
    return next;
  });

  if (err) return <div className="wf-empty">{err}</div>;
  if (!entries) return <div className="wf-empty">Loading…</div>;
  if (entries.length === 0) return <div className="wf-empty">This folder is empty.</div>;

  return (
    <>
      {entries.map((e) => (
        <div key={e.abs}>
          <Row entry={e} depth={depth} open={open.has(e.abs)}
            onClick={() => (e.dir ? toggle(e.abs) : onOpenFile(e))}
            onMenu={(x, y) => onMenu(e, x, y)} />
          {e.dir && open.has(e.abs) && (
            <Level cwd={cwd} dir={e.abs} depth={depth + 1} onOpenFile={onOpenFile} onMenu={onMenu} />
          )}
        </div>
      ))}
      {truncated && <div className="wf-note">Showing the first {entries.length} entries in this folder.</div>}
    </>
  );
}

// A find hit. Its own component rather than a row inside the map below, because
// the menu gestures are a hook and a hook cannot be called per iteration.
function ResultRow({ file, onOpen, onMenu }: {
  file: FoundFile; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const dir = file.path.slice(0, file.path.length - name.length - 1);
  const menu = useRowMenu(onMenu);
  const showing = useIsOpenFile(file.abs);
  return (
    <button className={"wf-row" + (showing ? " on" : "")} onClick={onOpen} {...menu} title={file.path}>
      <span className="wf-mark wf-kind">{fileIcon(fileKind(name).icon)}</span>
      <span className="wf-name">
        <span className="wf-nm">{name}</span>
        {dir && <span className="wf-dir">{dir}</span>}
      </span>
    </button>
  );
}

function Results({ cwd, query, onOpenFile, onMenu }: {
  cwd: string; query: string; onOpenFile: (e: { abs: string; name: string }) => void;
  onMenu: (e: { abs: string; name: string }, x: number, y: number) => void;
}) {
  const [files, setFiles] = useState<FoundFile[] | null>(null);
  const [meta, setMeta] = useState<{ truncated: boolean; fromGit: boolean; total: number; pending?: boolean; limited?: boolean }>(
    { truncated: false, fromGit: false, total: 0 });
  const [err, setErr] = useState<string | null>(null);
  // Only the newest query may paint: typing "app" fires three requests and the
  // first one must not land on top of the last.
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    // The server answers from an in-memory index now, not a git run per
    // keystroke, so the debounce is only here to coalesce a fast typist's
    // keystrokes into one request rather than to hide a slow call.
    const t = window.setTimeout(() => {
      findWorkspaceFiles(cwd, query)
        .then((r) => { if (mine === gen.current) { setFiles(r.files); setMeta(r); setErr(null); } })
        .catch((e: Error) => { if (mine === gen.current) { setFiles([]); setErr(e.message || "Couldn't search this folder."); } });
    }, 60);
    return () => { window.clearTimeout(t); gen.current++; };
  }, [cwd, query]);

  if (err) return <div className="wf-empty">{err}</div>;
  if (!files) return <div className="wf-empty">Searching…</div>;
  if (files.length === 0) {
    return (
      <div className="wf-empty">
        No file names match.
        {meta.fromGit && <div className="wf-sub">Files git ignores aren't searched — open them from the tree instead.</div>}
      </div>
    );
  }
  return (
    <>
      {files.map((f) => {
        const found = { abs: f.abs, name: f.path.slice(f.path.lastIndexOf("/") + 1) };
        return (
          <ResultRow key={f.abs} file={f}
            onOpen={() => onOpenFile(found)}
            onMenu={(x, y) => onMenu(found, x, y)} />
        );
      })}
      {meta.pending && (
        <div className="wf-note">Files that aren't in git yet are missing from this search — Refresh to include them.</div>
      )}
      {meta.limited && (
        <div className="wf-note">
          {meta.fromGit
            ? "This project is too large to index whole, so part of it wasn't searched."
            : "This folder isn't a git checkout, so only part of it could be indexed."}
        </div>
      )}
      {/* Ranked before it was cut, so this really is the best slice and not the
          first one git happened to list — worth saying on a query that matches
          tens of thousands of files. */}
      {meta.truncated && <div className="wf-note">Showing the best {files.length} of {meta.total} matches.</div>}
    </>
  );
}

// One file's matching lines. The whole block is the button — a header row plus
// its hits — so a match is as easy to hit with a thumb as a file row is, and so
// the long-press menu covers the lines too. Opening lands at the top of the
// file: the preview is one <pre>, with no per-line anchor to scroll to yet.
function HitRow({ file, onOpen, onMenu }: {
  file: GrepFile; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const dir = file.path.slice(0, file.path.length - name.length - 1);
  const menu = useRowMenu(onMenu);
  const showing = useIsOpenFile(file.abs);
  return (
    <button className={"wf-row wf-hit" + (showing ? " on" : "")} onClick={onOpen} {...menu} title={file.path}>
      <span className="wf-hit-head">
        <span className="wf-mark wf-kind">{fileIcon(fileKind(name).icon)}</span>
        <span className="wf-name">
          <span className="wf-nm">{name}</span>
          {dir && <span className="wf-dir">{dir}</span>}
        </span>
      </span>
      {file.matches.map((m) => (
        <span className="wf-hit-line" key={m.line}>
          <span className="ln">{m.line}</span>
          <span className="tx">{m.text}</span>
        </span>
      ))}
      {file.more > 0 && <span className="wf-hit-more">+{file.more} more in this file</span>}
    </button>
  );
}

// Content search. Its own component (and its own debounce) rather than a branch
// inside Results: this one costs a git process per query, where the name search
// answers from an in-memory index.
function TextResults({ cwd, query, onOpenFile, onMenu }: {
  cwd: string; query: string; onOpenFile: (e: { abs: string; name: string }) => void;
  onMenu: (e: { abs: string; name: string }, x: number, y: number) => void;
}) {
  const [res, setRes] = useState<GrepFile[] | null>(null);
  const [meta, setMeta] = useState<{ truncated: boolean; fromGit: boolean; total: number }>(
    { truncated: false, fromGit: true, total: 0 });
  const [err, setErr] = useState<string | null>(null);
  // Same guard as Results: only the newest query may paint.
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setRes(null);
    const t = window.setTimeout(() => {
      grepWorkspace(cwd, query)
        .then((r) => { if (mine === gen.current) { setRes(r.files); setMeta(r); setErr(null); } })
        .catch((e: Error) => { if (mine === gen.current) { setRes([]); setErr(e.message || "Couldn't search this folder."); } });
    }, GREP_DEBOUNCE_MS);
    return () => { window.clearTimeout(t); gen.current++; };
  }, [cwd, query]);

  if (err) return <div className="wf-empty">{err}</div>;
  if (!res) return <div className="wf-empty">Searching…</div>;
  if (!meta.fromGit) {
    return (
      <div className="wf-empty">
        This folder isn't a git checkout, so its contents can't be searched.
        <div className="wf-sub">Search by name instead, or open the file from the tree.</div>
      </div>
    );
  }
  if (res.length === 0) {
    return (
      <div className="wf-empty">
        Nothing in this project matches.
        <div className="wf-sub">Files git ignores aren't searched — open them from the tree instead.</div>
      </div>
    );
  }
  return (
    <>
      {res.map((f) => {
        const found = { abs: f.abs, name: f.path.slice(f.path.lastIndexOf("/") + 1) };
        return (
          <HitRow key={f.abs} file={f}
            onOpen={() => onOpenFile(found)}
            onMenu={(x, y) => onMenu(found, x, y)} />
        );
      })}
      {/* The count is what was READ before the cap stopped the search, not what
          exists — so the note must not claim to know the total. */}
      {meta.truncated && (
        <div className="wf-note">
          Showing the first {meta.total} matching lines — there are more. Narrow the search to see them.
        </div>
      )}
    </>
  );
}

export function FileTree({ cwd, reloadKey, onOpenFile, onMenu }: {
  cwd: string;
  // Bumped by the panel's Refresh button. The tree does not re-fetch on its own
  // — an agent finishing a turn changes a handful of files, and re-listing every
  // open folder for that is a request per level for almost no news.
  reloadKey: number;
  onOpenFile: (file: { abs: string; name: string }) => void;
  // Right-click / long-press on a row. The panel owns the menu itself, because
  // it is positioned against the viewport rather than against the tree.
  onMenu: (file: { abs: string; name: string; isDir?: boolean }, x: number, y: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("name");
  // A new folder is a new tree: dropping the old one's expansions is the point,
  // and a new project is browsed before it is grepped.
  useEffect(() => { setQuery(""); setScope("name"); }, [cwd]);
  const q = query.trim();

  // The find box is pinned and the rows scroll under it: this fills the panel
  // below the mode switch, so a deep tree must not push the box off the top.
  return (
    <>
      <div className="wf-find">
        <input
          type="search"
          placeholder={scope === "text" ? "Search in files" : "Find files"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={scope === "text" ? "Search file contents" : "Find files by name"}
        />
        {/* Two searches, one box: the same words are how you look for a file
            and how you look for what is written in one, and which of those you
            meant is a choice, not something to guess from the term. */}
        <div className="wf-find-scope" role="tablist" aria-label="What to search">
          <button role="tab" aria-selected={scope === "name"} className={scope === "name" ? "active" : ""}
            onClick={() => setScope("name")}>Names</button>
          <button role="tab" aria-selected={scope === "text"} className={scope === "text" ? "active" : ""}
            onClick={() => setScope("text")}>Contents</button>
        </div>
      </div>
      <div className="wf-body">
        {!q
          ? <Level key={cwd + ":" + reloadKey} cwd={cwd} depth={0}
              onOpenFile={(e) => onOpenFile({ abs: e.abs, name: e.name })}
              onMenu={(e, x, y) => onMenu({ abs: e.abs, name: e.name, isDir: e.dir }, x, y)} />
          : scope === "name"
            ? <Results cwd={cwd} query={q} onOpenFile={onOpenFile} onMenu={onMenu} />
            : q.length < MIN_GREP_LEN
              ? <div className="wf-empty">Type at least {MIN_GREP_LEN} characters to search file contents.</div>
              : <TextResults cwd={cwd} query={q} onOpenFile={onOpenFile} onMenu={onMenu} />}
      </div>
    </>
  );
}
