// Grouping the sessions list by folder needs one answer to "are these the same
// folder", and the four sources it merges do NOT spell a folder the same way.
// Sidebar.tsx already says so about recents: "a recents row can spell the same
// cwd differently than the gateway does". Using the raw cwd as a group key
// splits one folder into several groups, which is risk §4.1 in
// docs/ui-refactor-plan.md — hence this function, and hence its tests.
//
// Normalises: a "~" or "$HOME" prefix, "." and ".." segments, repeated and
// trailing slashes, and case (macOS filesystems are case-insensitive by
// default, so /Users/x/Repo and /Users/x/repo are one folder there).
//
// ponytail: case-folds unconditionally. A case-SENSITIVE volume could in
// principle hold two folders differing only in case; merging them in a sidebar
// list is a far smaller wrong than splitting every folder whose case drifted.

// The home directory as the gateway's own paths spell it. Derived from any
// absolute path we have seen, so no environment lookup is needed in the browser.
function expandHome(path: string, home: string): string {
  // With no home to expand against, leave the path alone: turning "~/git/repo"
  // into "/git/repo" would claim it lives at the filesystem root.
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  if (path === "$HOME") return home;
  if (path.startsWith("$HOME/")) return home + path.slice(5);
  return path;
}

export function folderKey(cwd: string | null | undefined, home = ""): string {
  const raw = (cwd ?? "").trim();
  if (!raw) return "";
  const expanded = expandHome(raw, home.replace(/\/+$/, ""));
  const absolute = expanded.startsWith("/");
  const out: string[] = [];
  for (const part of expanded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // A leading ".." on a relative path has nothing to pop and must survive,
      // or "../a" and "a" would collapse into the same folder.
      if (out.length && out[out.length - 1] !== "..") { out.pop(); continue; }
      if (absolute) continue; // "/.." is "/"
      out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return ((absolute ? "/" : "") + joined).toLowerCase() || (absolute ? "/" : "");
}

// What the folder is called on screen. Derived from the ORIGINAL path, not the
// key, so the case the user actually uses is what they read.
// The home directory, inferred from any absolute path the gateway has given us.
// There is no env to read in a browser, and ACPG_FS_ROOT is the gateway's
// sandbox root ("/" on most installs), not the user's home.
export function homeFrom(...paths: Array<string | null | undefined>): string {
  for (const p of paths) {
    const m = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(p ?? "");
    if (m) return m[1];
  }
  return "";
}

export function folderLabel(cwd: string | null | undefined): string {
  const src = cwd ?? "";
  if (!src.trim()) return "";
  const raw = src.replace(/\/+$/, "");
  if (!raw) return "/"; // the path was nothing but slashes — that is the root
  const name = raw.split("/").filter((p) => p && p !== ".").pop();
  return name === ".." ? raw : (name || "/");
}
