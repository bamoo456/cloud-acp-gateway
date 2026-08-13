import type { ReviewComment, RevSpec } from "./api.ts";

// A finished review, as the one message the agent receives.
//
// Plain text, not file attachments, for two structural reasons:
//
//   - A commit's line numbers address that commit's blob, not the file on disk.
//     An attachment anchored to the working file would quote the wrong lines the
//     moment anything moved — and a review is very often ABOUT code that has
//     since moved. Quoting the diff line inside the message is immune to that.
//   - File references ride on the `embeddedContext` prompt capability, which not
//     every agent has. Text works everywhere.
//
// The header names the revision so the agent knows which tree the line numbers
// belong to; without it "src/a.ts:408" means three different things depending on
// what was being reviewed.

// How a scope reads in the header. `branch` prints the range git was actually
// asked for, so the message says what was compared rather than "this branch".
export function describeScope(spec: RevSpec | null, label?: string): string {
  if (!spec) return "the working tree";
  if (spec.commit) return "commit `" + (label ?? spec.commit) + "`";
  return "`" + spec.base + "...HEAD`";
}

// Comments in reading order — by file, then by line — rather than in the order
// they were written. A review is read as a walk through the diff, and the order
// someone happened to notice things in is not information.
function ordered(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function anchor(c: ReviewComment): string {
  const range = c.endLine && c.endLine > c.line ? c.line + "-" + c.endLine : String(c.line);
  // The side is only worth naming when it is the deleted one: "old" changes what
  // the line number means, and a comment about removed code reads as a comment
  // about the code that replaced it otherwise.
  return c.path + ":" + range + (c.side === "old" ? " (removed line)" : "");
}

// A fence long enough to contain the quoted code. A diff line can itself contain
// a ``` (this very file's diff would), and the default fence would end the block
// early and spill the rest of the comment into the prose.
function fence(code: string): string {
  const longest = [...code.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

export interface ReviewSummary {
  files?: number;
  additions?: number;
  deletions?: number;
}

export function buildReviewMessage(
  comments: ReviewComment[],
  spec: RevSpec | null,
  summary: ReviewSummary = {},
  commitLabel?: string,
): string {
  const list = ordered(comments);
  const scope = describeScope(spec, commitLabel);
  const stat = summary.files !== undefined
    ? ` (${summary.files} ${summary.files === 1 ? "file" : "files"}` +
      (summary.additions !== undefined ? `, +${summary.additions} −${summary.deletions ?? 0}` : "") + ")"
    : "";
  const head = `Code review — ${list.length} ${list.length === 1 ? "comment" : "comments"} on ${scope}${stat}`;
  const body = list.map((c) => {
    const f = fence(c.code);
    // The quoted code is dropped rather than fenced empty when there is none:
    // an empty code block reads as "the line was blank", which is a claim.
    const quote = c.code.trim() ? `\n${f}\n${c.code}\n${f}` : "";
    return `### ${anchor(c)}${quote}\n${c.body.trim()}`;
  });
  return [head, ...body].join("\n\n");
}

// The zero-comment review. Says what was looked at, because "LGTM" on its own
// leaves the agent guessing whether you read the branch or one file of it.
export function buildApprovalMessage(spec: RevSpec | null, commitLabel?: string): string {
  return `Reviewed ${describeScope(spec, commitLabel)} — looks good to me, no comments.`;
}
