export function basename(p: string): string {
  return (p || "").replace(/\/+$/, "").split("/").pop() || p || "/";
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
