import type { ChangedFile, ChangeStatus } from "./api.ts";
import type { TouchedFile } from "./touchedFiles.ts";
import { basename } from "./format.ts";

// One list of files for the panel, from two sources that each know things the
// other cannot.
//
//   the thread's tool calls  — what THIS conversation wrote, including files it
//                              later reverted, files it committed, and files
//                              outside any checkout (/tmp/shot.png)
//   git status               — what is dirty in the checkout, including work
//                              done through a shell (`Bash` reports a command,
//                              never a path), by another conversation, or by you
//
// Splitting them across two tabs made the reader learn which source knows what —
// a taxonomy that exists because of how the data arrives, not because anyone
// thinks that way. So: one list, and a file that both sources know about is one
// row carrying both facts.

export interface PanelFile {
  abs: string;
  label: string;       // trailing segment, for the row
  fromThread: boolean; // this conversation named it in a tool call
  // Set when git knows the path: its status, line counts, and whether the change
  // is staged. Absent means git has nothing to say — untracked-and-unchanged, a
  // file outside the repo, or no repo at all.
  git?: {
    status: ChangeStatus;
    staged: boolean;
    additions?: number;
    deletions?: number;
    binary?: boolean;
  };
}

export function mergePanelFiles(written: TouchedFile[], changed: ChangedFile[]): PanelFile[] {
  // Insertion-ordered: what the conversation wrote comes first, in the order
  // touchedFiles established (most recently touched first), and the rest of the
  // checkout's dirt follows in git's own mtime order. Enriching an existing row
  // does not move it, so the agent's newest output stays at the top.
  const byPath = new Map<string, PanelFile>();
  for (const f of written) {
    byPath.set(f.path, { abs: f.path, label: f.label, fromThread: true });
  }
  for (const c of changed) {
    const git = {
      status: c.status, staged: c.staged,
      additions: c.additions, deletions: c.deletions, binary: c.binary,
    };
    const existing = byPath.get(c.abs);
    if (existing) existing.git = git;
    else byPath.set(c.abs, { abs: c.abs, label: basename(c.path), fromThread: false, git });
  }
  return [...byPath.values()];
}
