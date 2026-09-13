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

function anchor(c: { path: string; line: number; endLine?: number; side?: string }): string {
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

// A question about, or a fix for, one stretch of code — captured when the
// reviewer pressed the button, and sent as text for the same reasons the review
// above is. `sessionId`/`agentName` bind it to the conversation it came from,
// whatever is on screen by the time it is sent.
export interface AskFixRequest {
  intent: "ask" | "fix" | "trace";
  agentName: string;
  sessionId: string;
  cwd: string;
  spec: RevSpec | null;
  // How the commit reads in Review (short sha + subject); the spec only has the sha.
  label?: string;
  path: string;
  side?: "new" | "old";
  line: number;
  endLine?: number;
  code: string;
}

// What the reviewer can navigate afterwards is the checkout on disk, not the
// revision the request names: a trace result opened under a commit's scope would
// otherwise be read as a historical location and land on the wrong line.
const CURRENT_TREE =
  "Paths refer to the checkout as it is now (working tree); results open the current file.";

// One block, because the renderer draws the first structured block it can read
// and a second would be a second card claiming to be the same result. Prose is
// still welcome: the raw fence stays on screen as the readable fallback.
const TRACE_CONTRACT =
  "Reply with prose as you like, then EXACTLY ONE fenced block with info string `acp-trace` containing JSON: " +
  '{ "symbol": string, "definition": Ref[], "callers": Ref[], "callees": Ref[], "references"?: Ref[], "notes"?: string } ' +
  'where Ref = { "label": string, "path": string (repository-relative), "line"?: number, "endLine"?: number, "why"?: string }. ' +
  "`path` is required for every Ref; give a line whenever you can; omit an item rather than guess.";

const GUIDE_CONTRACT =
  "Reply with prose as you like, then EXACTLY ONE fenced block with info string `acp-guide` containing JSON: " +
  '{ "title": string, "steps": [{ "label": string, "path": string (repository-relative), "line"?: number, "endLine"?: number, "why": string }] }. ' +
  "Order the steps as a reading path covering the implementation, the risky and failure paths, and the tests. " +
  "`path` is required for every step; a step about a whole file may omit `line`; omit a step rather than guess.";

const DIAGRAM_CONTRACT =
  "Reply with prose as you like, then EXACTLY ONE fenced `mermaid` flowchart block, immediately followed by " +
  "EXACTLY ONE fenced block with info string `acp-nodes` containing JSON: " +
  '{ "<mermaid node id>": { "path": string (repository-relative), "line"?: number, "endLine"?: number, "label"?: string } }. ' +
  "The keys are the node identifiers written in the mermaid source, not the node labels. " +
  "Click directives and links inside the mermaid source are ignored — the metadata block is the only thing that makes a node navigable.";

export function buildAskFixMessage(r: AskFixRequest, body: string): string {
  const head = r.intent === "ask"
    ? "Question about selected code — explain it; do not edit anything."
    : r.intent === "fix"
    ? "Fix request for selected code — make the change described below."
    : "Trace request for selected code — find where it is defined, what calls it and what it calls; do not edit anything.";
  const f = fence(r.code);
  const quote = r.code.trim() ? `\n${f}\n${r.code}\n${f}` : "";
  return [
    head,
    `In checkout \`${r.cwd}\` (${describeScope(r.spec, r.label)}):`,
    `### ${anchor(r)}${quote}`,
    body.trim(),
    ...(r.intent === "trace" ? [TRACE_CONTRACT, CURRENT_TREE] : []),
  ].filter(Boolean).join("\n\n");
}

// A guide or a diagram is about the whole change, so there is no anchor to quote
// — the changed-file list stands in for it. `kind` is what the one dispatch
// action switches on; buildDiagramMessage still takes the shape explicitly, so a
// caller can ask for any of them.
export type DiagramKind = "request-flow" | "architecture" | "call-flow";

export interface GuideRequest {
  kind: "guide" | DiagramKind;
  agentName: string;
  sessionId: string;
  cwd: string;
  spec: RevSpec | null;
  label?: string;
  files: { path: string; status: string; additions?: number; deletions?: number }[];
}

// A capped list, and it says so when it caps: a thousand-file rename would
// otherwise spend the whole prompt on paths, and an agent that cannot see it was
// truncated will describe the change as if those files did not exist.
const GUIDE_FILE_CAP = 60;

function fileList(r: GuideRequest): string {
  const shown = r.files.slice(0, GUIDE_FILE_CAP);
  const head = shown.length < r.files.length
    ? `The first ${shown.length} of ${r.files.length} changed files:`
    : `The ${r.files.length} changed ${r.files.length === 1 ? "file" : "files"}:`;
  return [head, ...shown.map((f) =>
    `- ${f.path} (${f.status}` +
    (f.additions !== undefined ? `, +${f.additions} −${f.deletions ?? 0}` : "") + ")",
  )].join("\n");
}

function preamble(r: GuideRequest, head: string): string {
  return [head, `In checkout \`${r.cwd}\` (${describeScope(r.spec, r.label)}):`, fileList(r)].join("\n\n");
}

export function buildGuideMessage(r: GuideRequest): string {
  return [
    preamble(r, "Review guide request — plan a reading path through this change; do not edit anything."),
    GUIDE_CONTRACT,
    CURRENT_TREE,
  ].join("\n\n");
}

const DIAGRAM_HEAD: Record<DiagramKind, string> = {
  "request-flow": "Diagram request — draw the request flow through this change; do not edit anything.",
  architecture: "Diagram request — draw the architecture this change sits in; do not edit anything.",
  "call-flow": "Diagram request — draw the call flow through this change; do not edit anything.",
};

export function buildDiagramMessage(r: GuideRequest, kind: DiagramKind): string {
  return [preamble(r, DIAGRAM_HEAD[kind]), DIAGRAM_CONTRACT, CURRENT_TREE].join("\n\n");
}

// One durable discussion, as the message a branch opens with. Same quoting
// rules as a review comment, plus the trailing reference line: a fork is a new
// conversation with no idea where it came from, and the id is what lets an
// answer be tied back to the record that asked for it.
export function buildDiscussionMessage(d: {
  id: string; path: string; side: "new" | "old"; line: number; endLine?: number;
  code: string; body: string; replies: { body: string }[];
}): string {
  const f = fence(d.code);
  const quote = d.code.trim() ? `\n${f}\n${d.code}\n${f}` : "";
  const thread = [d.body, ...d.replies.map((r) => r.body)].map((b) => b.trim()).filter(Boolean).join("\n\n");
  return `Review discussion — look into this and report back.\n\n### ${anchor(d)}${quote}\n\n${thread}\n\n` +
    `Discussion ${d.id} at ${d.path}:${d.line}`;
}
