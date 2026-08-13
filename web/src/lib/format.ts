import type { ChangeStatus } from "./api.ts";

export function basename(p: string): string {
  return (p || "").replace(/\/+$/, "").split("/").pop() || p || "/";
}

// Everything above the directory in a path ("src/lib/api.ts" -> "src/lib"), for
// the second line of a file row. Empty for a file at the root.
export function dirname(p: string): string {
  const i = (p || "").replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

// A path as it reads inside a folder: "/repo/web/src/App.tsx" against "/repo"
// becomes "web/src/App.tsx". Anything outside keeps its absolute path — in a
// column this narrow, a "../../" chain is noise, and the full path at least
// says where the file really is.
export function relativeTo(p: string, dir: string): string {
  return isInside(p, dir) ? p.slice(dir.replace(/\/+$/, "").length + 1) : p;
}

// Is `p` under `dir`? The client's copy of the gateway's own ACPG_FS_ROOT test,
// used to say up front that a file can't be opened rather than letting the row
// look ordinary until it is clicked. An empty `dir` means "unknown" — the
// config didn't say — so nothing is claimed to be outside it.
export function isInside(p: string, dir: string): boolean {
  if (!dir || !p) return false;
  const base = dir.replace(/\/+$/, "");
  return p.startsWith(base + "/");
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

// Capitalize an agent name for display (e.g. "codex" -> "Codex").
export function displayName(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h";
  return Math.round(h / 24) + "d";
}

// Time left until an instant given in Unix *seconds* (what the Claude adapter
// puts in a rate limit's `resetsAt`), in the two coarsest units that fit:
// "1d 9h", "1h 32m", "12m". Empty once it has passed or is under a minute —
// a window about to reset has nothing useful to count down to.
export function formatUntil(epochSeconds: number, now = Date.now()): string {
  const total = Math.floor((epochSeconds * 1000 - now) / 60000);
  if (!Number.isFinite(total) || total <= 0) return "";
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// git's own status letters and their prose, shared by every list that shows
// them — the files panel's changed rows and the review panel's. Here rather than
// in either component because importing one panel from the other would make the
// two of them a cycle.
export const STATUS_MARK: Record<ChangeStatus, string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U",
};
export const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", untracked: "New file",
};
