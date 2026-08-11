import { useEffect, useRef, useState } from "react";
import { getWorkspaceTree, findWorkspaceFiles, type TreeEntry, type FoundFile } from "../lib/api.ts";
import { fileKind } from "../lib/fileKind.ts";
import { formatBytes } from "../lib/format.ts";
import { IconFolder, IconChevronDown, IconChevronRight, fileIcon } from "../lib/icons.tsx";

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

function Row({ entry, depth, open, onClick }: {
  entry: TreeEntry; depth: number; open?: boolean; onClick: () => void;
}) {
  const kind = fileKind(entry.name);
  return (
    <button
      className={"wf-row wf-tree-row" + (entry.ignored ? " ignored" : "")}
      style={{ paddingLeft: 10 + depth * INDENT_PX }}
      onClick={onClick}
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
function Level({ cwd, dir, depth, onOpenFile }: {
  cwd: string; dir?: string; depth: number; onOpenFile: (e: TreeEntry) => void;
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
            onClick={() => (e.dir ? toggle(e.abs) : onOpenFile(e))} />
          {e.dir && open.has(e.abs) && (
            <Level cwd={cwd} dir={e.abs} depth={depth + 1} onOpenFile={onOpenFile} />
          )}
        </div>
      ))}
      {truncated && <div className="wf-note">Showing the first {entries.length} entries in this folder.</div>}
    </>
  );
}

function Results({ cwd, query, onOpenFile }: {
  cwd: string; query: string; onOpenFile: (e: { abs: string; name: string }) => void;
}) {
  const [files, setFiles] = useState<FoundFile[] | null>(null);
  const [meta, setMeta] = useState<{ truncated: boolean; fromGit: boolean }>({ truncated: false, fromGit: false });
  const [err, setErr] = useState<string | null>(null);
  // Only the newest query may paint: typing "app" fires three requests and the
  // first one must not land on top of the last.
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    // Debounced, because this walks a repo's file list on every keystroke.
    const t = window.setTimeout(() => {
      findWorkspaceFiles(cwd, query)
        .then((r) => { if (mine === gen.current) { setFiles(r.files); setMeta(r); setErr(null); } })
        .catch((e: Error) => { if (mine === gen.current) { setFiles([]); setErr(e.message || "Couldn't search this folder."); } });
    }, 160);
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
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        const dir = f.path.slice(0, f.path.length - name.length - 1);
        return (
          <button key={f.abs} className="wf-row" onClick={() => onOpenFile({ abs: f.abs, name })} title={f.path}>
            <span className="wf-mark wf-kind">{fileIcon(fileKind(name).icon)}</span>
            <span className="wf-name">
              <span className="wf-nm">{name}</span>
              {dir && <span className="wf-dir">{dir}</span>}
            </span>
          </button>
        );
      })}
      {meta.truncated && <div className="wf-note">Showing the first {files.length} matches.</div>}
    </>
  );
}

export function FileTree({ cwd, reloadKey, onOpenFile }: {
  cwd: string;
  // Bumped by the panel's Refresh button. The tree does not re-fetch on its own
  // — an agent finishing a turn changes a handful of files, and re-listing every
  // open folder for that is a request per level for almost no news.
  reloadKey: number;
  onOpenFile: (file: { abs: string; name: string }) => void;
}) {
  const [query, setQuery] = useState("");
  // A new folder is a new tree: dropping the old one's expansions is the point.
  useEffect(() => { setQuery(""); }, [cwd]);

  return (
    <div className="wf-tree">
      <div className="wf-find">
        <input
          type="search"
          placeholder="Find files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find files by name"
        />
      </div>
      {query.trim()
        ? <Results cwd={cwd} query={query.trim()} onOpenFile={onOpenFile} />
        : <Level key={cwd + ":" + reloadKey} cwd={cwd} depth={0}
            onOpenFile={(e) => onOpenFile({ abs: e.abs, name: e.name })} />}
    </div>
  );
}
