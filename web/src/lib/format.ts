export function basename(p: string): string {
  return (p || "").replace(/\/+$/, "").split("/").pop() || p || "/";
}

// Everything above the directory in a path ("src/lib/api.ts" -> "src/lib"), for
// the second line of a file row. Empty for a file at the root.
export function dirname(p: string): string {
  const i = (p || "").replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
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
