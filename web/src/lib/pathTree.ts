// A flat list of paths, folded into the folders they live in.
//
// Every list in the files panel except the project tree arrives from git (or
// from the thread) as one array of paths, and read the folder off a second line
// under each name. That answers "where is this file" one row at a time and
// never answers "what changed under web/src" — which is the question a review
// of more than a handful of files is actually read with.
//
// Single-child directory chains collapse into one row ("web/src/components"):
// a folder whose only content is another folder is a click that reveals
// nothing, and a deep tree is mostly those.

export type PathTreeNode<T> =
  | { dir: true; name: string; path: string; children: PathTreeNode<T>[] }
  | { dir: false; name: string; path: string; item: T };

type Trie<T> = { dirs: Map<string, Trie<T>>; files: Map<string, T> };

const empty = <T>(): Trie<T> => ({ dirs: new Map(), files: new Map() });

const join = (prefix: string, name: string) =>
  !prefix ? name : prefix.endsWith("/") ? prefix + name : prefix + "/" + name;

export function buildPathTree<T>(items: T[], pathOf: (item: T) => string): PathTreeNode<T>[] {
  const root = empty<T>();
  for (const item of items) {
    const raw = pathOf(item);
    const parts = raw.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    // An absolute path keeps its leading slash on the first segment: a file
    // outside the checkout belongs under "/tmp", not under a "tmp" that reads
    // as a folder of the repo being reviewed.
    if (raw.startsWith("/")) parts[0] = "/" + parts[0];
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) { next = empty<T>(); node.dirs.set(part, next); }
      node = next;
    }
    node.files.set(parts[parts.length - 1], item);
  }
  return level(root, "");
}

function level<T>(node: Trie<T>, prefix: string): PathTreeNode<T>[] {
  const dirs = [...node.dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, child]) => {
      let label = name;
      let path = join(prefix, name);
      let cur = child;
      // The chain collapse. Stops at the first folder that has anything of its
      // own to show — a file, or a second subfolder to choose between.
      while (cur.files.size === 0 && cur.dirs.size === 1) {
        const [only, next] = [...cur.dirs.entries()][0];
        label = label + "/" + only;
        path = join(path, only);
        cur = next;
      }
      return { dir: true as const, name: label, path, children: level(cur, path) };
    });
  const files = [...node.files.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, item]) => ({ dir: false as const, name, path: join(prefix, name), item }));
  // Folders first, then files — git's own ordering, and the one that keeps a
  // folder's rows contiguous under its header.
  return [...dirs, ...files];
}
