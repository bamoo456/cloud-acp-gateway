import type { ChangedFile, ChangeStatus, OutputFile } from "./api.ts";
import type { TouchedFile } from "./touchedFiles.ts";
import { basename, dirname } from "./format.ts";

// One list of files for the panel, from three sources that each know things the
// others cannot.
//
//   the thread's tool calls  — what THIS conversation wrote, including files it
//                              later reverted, files it committed, and files
//                              outside any checkout (/tmp/shot.png)
//   git status               — what is dirty in the checkout, including work
//                              done through a shell (`Bash` reports a command,
//                              never a path), by another conversation, or by you
//   output folders           — everything in a folder the conversation wrote into
//                              that git cannot describe at all. The two sources
//                              above are blind to the SAME file whenever a shell
//                              writes outside the checkout, which is what
//                              "generate the mockup in /tmp" does every time
//
// Splitting them across tabs made the reader learn which source knows what — a
// taxonomy that exists because of how the data arrives, not because anyone
// thinks that way. So: one list, and a file more than one source knows about is
// one row carrying every fact.

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
  // Only the folder listing found it: nothing in the thread names it and git
  // can't see it. True of anything a shell wrote outside the checkout. Kept
  // separate from the other two because it is a weaker claim — "it is in a folder
  // this conversation wrote to", not "this conversation wrote it".
  inWrittenFolder?: boolean;
}

// Folders worth asking the gateway to list: the parents of the files this
// conversation WROTE. Read-only tool calls are deliberately excluded — a folder
// the agent merely looked in is not somewhere it put anything, and listing it
// would bury the output in the project the agent was reading.
//
// Ordered by the thread's own recency (touchedFiles hands back most-recent
// first), deduped, and capped: the gateway caps too, and sending it fifty
// candidates to refuse is work for both sides.
export const MAX_OUTPUT_FOLDER_CANDIDATES = 8;

export function outputFolderCandidates(written: TouchedFile[]): string[] {
  const dirs: string[] = [];
  for (const f of written) {
    const dir = dirname(f.path);
    // No separator in the path means a bare filename in the conversation's own
    // folder, which is never an output folder — the gateway refuses cwd itself.
    if (!dir || dirs.includes(dir)) continue;
    dirs.push(dir);
    if (dirs.length >= MAX_OUTPUT_FOLDER_CANDIDATES) break;
  }
  return dirs;
}

export function mergePanelFiles(
  written: TouchedFile[], changed: ChangedFile[], inFolders: OutputFile[] = [],
): PanelFile[] {
  // Insertion-ordered: what the conversation wrote comes first, in the order
  // touchedFiles established (most recently touched first), then the rest of the
  // checkout's dirt in git's own mtime order, then the folder listings in theirs.
  // Enriching an existing row does not move it, so the agent's newest output
  // stays at the top.
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
  for (const f of inFolders) {
    // A row from either source above already says more about this file than "it
    // is in the folder" — the folder listing is the fallback, not an addition.
    if (byPath.has(f.abs)) continue;
    byPath.set(f.abs, { abs: f.abs, label: basename(f.path), fromThread: false, inWrittenFolder: true });
  }
  return [...byPath.values()];
}
