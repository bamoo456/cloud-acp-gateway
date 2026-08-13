// Which view the sessions list is in, and which folders are collapsed.
//
// Deliberately localStorage rather than the gateway's cross-device `meta` KV
// that holds text_size / screen_lock: a phone and a desktop usually want
// different views of the same list, and a folder you collapsed on one has no
// bearing on the other (docs/ui-refactor-plan.md §4.3 / P4.3).
export type SessionsView = "folder" | "latest";

const VIEW_KEY = "acpg.sessionsView";
const COLLAPSED_KEY = "acpg.foldersCollapsed";

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

// Collapsed folders are stored by their NORMALISED key (see folderKey): the
// same folder spelled two ways must not collapse twice, and must not re-expand
// because the next poll spelled it differently.
export function readCollapsedFolders(): Set<string> {
  const raw = read(COLLAPSED_KEY);
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolders(keys: Set<string>): void {
  write(COLLAPSED_KEY, JSON.stringify([...keys]));
}
