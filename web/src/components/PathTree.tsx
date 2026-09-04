import { useEffect, useState } from "react";
import { buildPathTree, type PathTreeNode } from "../lib/pathTree.ts";
import { IconFolder, IconChevronDown, IconChevronRight } from "../lib/icons.tsx";

// The folder rows every path list in the panel gets, over whatever row the list
// already drew for a file. The project tree (FileTree) is not one of these: it
// fetches a folder when you open it, so its levels cannot be built from a list
// that is already in hand — which is all this does.
//
// Files stay the caller's to render: Review's row carries git's status letter
// and a comment badge, Session's carries a type icon and a diffstat, and the
// only thing they need from the tree is how far to indent.

// Depth is indentation only. Shared with FileTree so the two trees in this
// panel step by the same amount.
export const INDENT_PX = 12;
export const rowIndent = (depth: number) => 10 + depth * INDENT_PX;

export function PathTree<T>({ items, pathOf, resetKey, renderFile }: {
  items: T[];
  pathOf: (item: T) => string;
  // A new revision, or a new folder, is a new list — and the folders someone
  // closed in the last one mean nothing in this one.
  resetKey?: string;
  renderFile: (item: T, indent: number) => React.ReactNode;
}) {
  // Collapsed, not expanded: the list this replaces showed every file, and a
  // tree that opens closed would hide the diff someone came here to read.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => { setCollapsed(new Set()); }, [resetKey]);
  const toggle = (path: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  return (
    <Level nodes={buildPathTree(items, pathOf)} depth={0}
      collapsed={collapsed} onToggle={toggle} renderFile={renderFile} />
  );
}

function Level<T>({ nodes, depth, collapsed, onToggle, renderFile }: {
  nodes: PathTreeNode<T>[]; depth: number; collapsed: Set<string>;
  onToggle: (path: string) => void;
  renderFile: (item: T, indent: number) => React.ReactNode;
}) {
  return (
    <>
      {nodes.map((n) => {
        if (!n.dir) return <div key={n.path}>{renderFile(n.item, rowIndent(depth))}</div>;
        const open = !collapsed.has(n.path);
        return (
          <div key={n.path}>
            <button className="wf-row wf-tree-row wf-dir-row" style={{ paddingLeft: rowIndent(depth) }}
              onClick={() => onToggle(n.path)} aria-expanded={open} title={n.path}>
              <span className="wf-twist">{open ? <IconChevronDown /> : <IconChevronRight />}</span>
              <span className="wf-mark wf-kind"><IconFolder /></span>
              <span className="wf-name"><span className="wf-nm">{n.name}</span></span>
            </button>
            {open && (
              <Level nodes={n.children} depth={depth + 1}
                collapsed={collapsed} onToggle={onToggle} renderFile={renderFile} />
            )}
          </div>
        );
      })}
    </>
  );
}
