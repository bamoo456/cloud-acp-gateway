import { folderKey, folderLabel } from "./folderKey.ts";

// The two views over one list (docs/ui-refactor-plan.md §3 P4). Pure functions
// over rows the sidebar has already built, so they are testable without a DOM
// and cheap enough to run inside a useMemo on the source arrays (§4.4).

// The only fields either view sorts or groups on. Everything else a row needs
// to render travels with it in `data`.
export interface GroupableRow<T> {
  key: string;
  cwd: string;
  /** ms since epoch; 0 for a row with no usable timestamp, which sorts last. */
  when: number;
  running: boolean;
  needsYou: boolean;
  data: T;
}

export interface FolderGroup<T> {
  /** normalised — the group identity, and the collapse-state key */
  key: string;
  /** as the folder is actually spelled on screen */
  label: string;
  /** the first row's raw cwd, for a title attribute */
  cwd: string;
  rows: Array<GroupableRow<T>>;
  running: boolean;
  needsYou: boolean;
  /** the folder the app is currently working in */
  current: boolean;
}

const byWhen = <T>(a: GroupableRow<T>, b: GroupableRow<T>) => b.when - a.when;

// Ordering, both views, in one place so the two can't drift:
//   needs you first, then running, then most recent.
// In the folder view the folder you are working in is pinned above all of it —
// you are in it, so its position must be stable while you work.
export function groupByFolder<T>(
  rows: Array<GroupableRow<T>>,
  currentCwd: string,
  home = "",
): Array<FolderGroup<T>> {
  const currentKey = folderKey(currentCwd, home);
  const groups = new Map<string, FolderGroup<T>>();
  for (const row of rows) {
    const key = folderKey(row.cwd, home);
    let g = groups.get(key);
    if (!g) {
      g = {
        key, label: folderLabel(row.cwd) || key, cwd: row.cwd,
        rows: [], running: false, needsYou: false, current: key === currentKey,
      };
      groups.set(key, g);
    }
    g.rows.push(row);
    g.running ||= row.running;
    g.needsYou ||= row.needsYou;
  }
  // The folder you are in belongs in the list even before it has a session.
  if (currentKey && !groups.has(currentKey)) {
    groups.set(currentKey, {
      key: currentKey, label: folderLabel(currentCwd) || currentKey, cwd: currentCwd,
      rows: [], running: false, needsYou: false, current: true,
    });
  }
  const out = [...groups.values()];
  for (const g of out) g.rows.sort(rankThen(byWhen));
  const freshest = (g: FolderGroup<T>) => g.rows.reduce((n, r) => Math.max(n, r.when), 0);
  return out.sort((a, b) =>
    Number(b.current) - Number(a.current) ||
    Number(b.needsYou) - Number(a.needsYou) ||
    Number(b.running) - Number(a.running) ||
    freshest(b) - freshest(a));
}

function rankThen<T>(tie: (a: GroupableRow<T>, b: GroupableRow<T>) => number) {
  return (a: GroupableRow<T>, b: GroupableRow<T>) =>
    Number(b.needsYou) - Number(a.needsYou) ||
    Number(b.running) - Number(a.running) ||
    tie(a, b);
}

// Strict recency, EXCEPT that anything running or waiting on you is pinned
// above the fold. A session that wants an Allow must not sink out of sight just
// because it has been quiet — that is exactly the case you opened the phone for.
export function latestWithPinned<T>(rows: Array<GroupableRow<T>>): {
  pinned: Array<GroupableRow<T>>;
  rest: Array<GroupableRow<T>>;
} {
  const pinned = rows.filter((r) => r.needsYou || r.running).sort(rankThen(byWhen));
  const rest = rows.filter((r) => !r.needsYou && !r.running).sort(byWhen);
  return { pinned, rest };
}

// Splits the (already-sorted) recency list in two, so a reader can tell "just
// happened" apart from "sometime in the last N days" without reading every
// relative timestamp. `<=`, not `<`, at the boundary: a row exactly one hour
// old has not gone stale in the second it crosses the line. A `when` of 0 (no
// usable timestamp) is always more than windowMs away from `now`, so it lands
// in `older` — which is where it already sorts anyway.
export function splitByAge<T>(
  rows: Array<GroupableRow<T>>,
  now: number,
  windowMs = 3600_000,
): { fresh: Array<GroupableRow<T>>; older: Array<GroupableRow<T>> } {
  const fresh: Array<GroupableRow<T>> = [];
  const older: Array<GroupableRow<T>> = [];
  for (const row of rows) (now - row.when <= windowMs ? fresh : older).push(row);
  return { fresh, older };
}

// Folders the reader has explicitly chosen (in the folder picker) never to
// see — real folders now, not typed substring patterns, so a hide entry is
// matched by normalised folder key: exact, or a parent whose subtree the
// entry covers. That "subtree" rule is why a plain string.includes() won't
// do: it would make "/x/repo" hide "/x/repo-2" too, which is not what hiding
// a specific folder should mean. This is the one place a row IS allowed to
// sink out of sight even while running or needing you: unlike the sorting
// above, hiding is something the reader chose on purpose, the durable inbox
// still surfaces that session's prompts elsewhere, and the "N hidden"
// affordance the caller renders keeps the cut from being silent.
export function hideFolders<T>(
  rows: Array<GroupableRow<T>>,
  hidden: string[],
  currentCwd: string,
  home = "",
): Array<GroupableRow<T>> {
  const hiddenKeys = [...new Set(hidden.map((h) => folderKey(h, home)).filter(Boolean))];
  if (hiddenKeys.length === 0) return rows;
  // Never hide the folder you're working in — silently emptying it would
  // read as data loss, not as the filter doing its job.
  const currentKey = folderKey(currentCwd, home);
  return rows.filter((row) => {
    const key = folderKey(row.cwd, home);
    return key === currentKey || !hiddenKeys.some((h) => key === h || key.startsWith(h + "/"));
  });
}
