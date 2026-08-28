// Which view the sessions list is in, and which folders are collapsed.
//
// Deliberately localStorage rather than the gateway's cross-device `meta` KV
// that holds text_size / screen_lock: a phone and a desktop usually want
// different views of the same list, and a folder you collapsed on one has no
// bearing on the other (docs/ui-refactor-plan.md §4.3 / P4.3).
import type { FolderSort } from "./sessionGroups.ts";

export type SessionsView = "folder" | "latest";

const VIEW_KEY = "acpg.sessionsView";
const SORT_KEY = "acpg.folderSort";
const STATES_KEY = "acpg.folderStates";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}

export function readSessionsView(): SessionsView {
  return read(VIEW_KEY) === "latest" ? "latest" : "folder";
}

export function saveSessionsView(view: SessionsView): void {
  write(VIEW_KEY, view);
}

// How the folder view orders its groups (see sessionGroups.FolderSort).
// Same storage choice as the view itself: local, per-device.
export function readFolderSort(): FolderSort {
  return read(SORT_KEY) === "name" ? "name" : "activity";
}

export function saveFolderSort(sort: FolderSort): void {
  write(SORT_KEY, sort);
}

// A folder's default is open when it is the one you are working in or has
// something running / waiting on you, and collapsed otherwise. This map records
// the folders the reader has toggled by hand — as the chosen STATE, not as a
// delta against that default: the default flips whenever a folder becomes
// current or starts running, and a stored delta inverts its meaning at exactly
// that moment (tap a folder open, click a chat in it, and the folder slams
// shut as it becomes current). A folder with no entry follows the default, so
// one that starts running still expands on its own; one with an entry stays
// where the reader put it.
//
// Stored by NORMALISED folder key (see folderKey): the same folder spelled two
// ways must not collapse twice, and must not spring open because the next poll
// spelled it differently (§4.3).
export type FolderState = "open" | "shut";

export function readFolderStates(): Record<string, FolderState> {
  const raw = read(STATES_KEY);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    const out: Record<string, FolderState> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, st] of Object.entries(v)) if (st === "open" || st === "shut") out[k] = st;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveFolderStates(states: Record<string, FolderState>): void {
  write(STATES_KEY, JSON.stringify(states));
}
