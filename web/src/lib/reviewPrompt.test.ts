import { describe, expect, test } from "vitest";
import {
  buildReviewMessage, buildApprovalMessage, buildAskFixMessage, buildGuideMessage, buildDiagramMessage,
  describeScope, type AskFixRequest, type GuideRequest,
} from "./reviewPrompt.ts";
import type { ReviewComment } from "./api.ts";

const c = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  path: "src/workspace.ts", side: "new", line: 408,
  code: '+  const args = rev ? ["show", rev] : ["diff"];',
  body: "`rev` comes straight off the query string.",
  ...over,
});

describe("describeScope", () => {
  test("names each scope so the agent knows which tree the line numbers are in", () => {
    expect(describeScope(null)).toBe("the working tree");
    expect(describeScope({ base: "origin/main" })).toBe("`origin/main...HEAD`");
    expect(describeScope({ commit: "abc1234" })).toBe("commit `abc1234`");
    expect(describeScope({ commit: "abc1234" }, "abc1234 feat: a thing")).toBe("commit `abc1234 feat: a thing`");
  });
});

describe("buildReviewMessage", () => {
  test("heads the message with the scope and the diffstat", () => {
    const text = buildReviewMessage([c()], { base: "origin/main" }, { files: 7, additions: 212, deletions: 38 });
    expect(text.split("\n")[0]).toBe("Code review — 1 comment on `origin/main...HEAD` (7 files, +212 −38)");
  });

  test("each comment is an anchor, the quoted line, and the body", () => {
    const text = buildReviewMessage([c()], null);
    expect(text).toContain("### src/workspace.ts:408");
    expect(text).toContain('```\n+  const args = rev ? ["show", rev] : ["diff"];\n```');
    expect(text).toContain("`rev` comes straight off the query string.");
  });

  test("a range anchor prints the range", () => {
    expect(buildReviewMessage([c({ line: 406, endLine: 411 })], null)).toContain("### src/workspace.ts:406-411");
  });

  test("a comment on a removed line says so — the number means something else there", () => {
    // Without this, a comment about deleted code reads as a comment about
    // whatever now occupies that line number on the new side.
    expect(buildReviewMessage([c({ side: "old" })], null)).toContain("### src/workspace.ts:408 (removed line)");
  });

  test("comments arrive in reading order, not in the order they were written", () => {
    const text = buildReviewMessage([
      c({ path: "web/src/App.tsx", line: 12, body: "third" }),
      c({ line: 900, body: "second" }),
      c({ line: 10, body: "first" }),
    ], null);
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"));
  });

  test("a quoted line containing a fence gets a longer fence", () => {
    // Reviewing a markdown file — or this very file's diff — otherwise ends the
    // code block early and spills the rest of the comment into the prose.
    const text = buildReviewMessage([c({ code: "+```ts" })], null);
    expect(text).toContain("````\n+```ts\n````");
  });

  test("an empty quoted line is dropped rather than fenced empty", () => {
    // An empty code block is a claim — "the line was blank" — and a comment
    // whose anchor couldn't be quoted hasn't made it.
    const text = buildReviewMessage([c({ code: "" })], null);
    expect(text).not.toContain("```");
    expect(text).toContain("### src/workspace.ts:408\n`rev` comes");
  });

  test("counts singular and plural", () => {
    expect(buildReviewMessage([c()], null)).toContain("1 comment on");
    expect(buildReviewMessage([c(), c({ line: 9 })], null)).toContain("2 comments on");
  });

  test("no diffstat when there is nothing to report one about", () => {
    expect(buildReviewMessage([c()], null)).toContain("on the working tree\n");
  });
});

describe("buildApprovalMessage", () => {
  test("says what was looked at, not just LGTM", () => {
    // "LGTM" alone leaves the agent guessing whether the branch was read or one
    // file of it.
    expect(buildApprovalMessage({ base: "main" }))
      .toBe("Reviewed `main...HEAD` — looks good to me, no comments.");
  });
});

describe("buildAskFixMessage", () => {
  const r = (over: Partial<AskFixRequest> = {}): AskFixRequest => ({
    intent: "ask", agentName: "claude", sessionId: "s1", cwd: "/repo", spec: null,
    path: "src/workspace.ts", line: 408, code: "const args = rev;", ...over,
  });

  test("Ask says explain and forbids edits; Fix asks for the described change", () => {
    expect(buildAskFixMessage(r(), "why?").split("\n")[0])
      .toBe("Question about selected code — explain it; do not edit anything.");
    expect(buildAskFixMessage(r({ intent: "fix" }), "guard it").split("\n")[0])
      .toBe("Fix request for selected code — make the change described below.");
  });

  test("names the checkout, the scope, the place, and quotes the code as selected", () => {
    const text = buildAskFixMessage(r({ spec: { base: "main" }, endLine: 411 }), "  why?  ");
    expect(text).toContain("In checkout `/repo` (`main...HEAD`):");
    expect(text).toContain("### src/workspace.ts:408-411\n```\nconst args = rev;\n```\n\nwhy?");
  });

  test("Trace asks for definition, callers and callees in one acp-trace block", () => {
    const text = buildAskFixMessage(r({ intent: "trace" }), "");
    expect(text.split("\n")[0])
      .toBe("Trace request for selected code — find where it is defined, what calls it and what it calls; do not edit anything.");
    // The excerpt is the whole question, so an empty body must not leave a hole
    // between the fence and the contract.
    expect(text).toContain("### src/workspace.ts:408\n```\nconst args = rev;\n```\n\nReply with prose");
    expect(text).toContain("EXACTLY ONE fenced block with info string `acp-trace`");
    expect(text).toContain('{ "symbol": string, "definition": Ref[], "callers": Ref[], "callees": Ref[], "references"?: Ref[], "notes"?: string }');
    expect(text).toContain("`path` is required for every Ref; give a line whenever you can; omit an item rather than guess.");
    expect(text).toContain("Paths refer to the checkout as it is now (working tree); results open the current file.");
  });

  test("Ask and Fix carry no output contract — they are prose questions", () => {
    expect(buildAskFixMessage(r(), "why?")).not.toContain("acp-trace");
  });

  test("a removed diff line says so — its number belongs to the old side", () => {
    expect(buildAskFixMessage(r({ side: "old" }), "gone?")).toContain("### src/workspace.ts:408 (removed line)");
  });

  test("a commit is named the way Review names it, not by its full sha", () => {
    const spec = { commit: "3f2a9c0d3f2a9c0d3f2a9c0d3f2a9c0d3f2a9c0d" };
    expect(buildAskFixMessage(r({ spec, label: "3f2a9c0 fix: guard it" }), "why?")).toContain("(commit `3f2a9c0 fix: guard it`):");
  });
});

describe("buildGuideMessage / buildDiagramMessage", () => {
  const g = (over: Partial<GuideRequest> = {}): GuideRequest => ({
    kind: "guide", agentName: "claude", sessionId: "s1", cwd: "/repo", spec: null,
    files: [{ path: "src/workspace.ts", status: "modified", additions: 12, deletions: 3 }], ...over,
  });

  test("a guide names the checkout, the scope and the changed files it was given", () => {
    const text = buildGuideMessage(g({ spec: { base: "main" } }));
    expect(text.split("\n")[0]).toBe("Review guide request — plan a reading path through this change; do not edit anything.");
    expect(text).toContain("In checkout `/repo` (`main...HEAD`):");
    expect(text).toContain("The 1 changed file:\n- src/workspace.ts (modified, +12 −3)");
  });

  test("the file list is capped, and the prompt says it was", () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ path: "src/f" + i + ".ts", status: "added" }));
    const text = buildGuideMessage(g({ files: many }));
    // An agent that cannot see it was truncated describes the change as if the
    // files past the cap were not in it.
    expect(text).toContain("The first 60 of 61 changed files:");
    expect(text).toContain("- src/f59.ts (added)");
    expect(text).not.toContain("src/f60.ts");
  });

  test("a guide asks for one acp-guide block, ordered, with a path on every step", () => {
    const text = buildGuideMessage(g());
    expect(text).toContain("EXACTLY ONE fenced block with info string `acp-guide`");
    expect(text).toContain('{ "title": string, "steps": [{ "label": string, "path": string (repository-relative)');
    expect(text).toContain("the implementation, the risky and failure paths, and the tests");
    expect(text).toContain("a step about a whole file may omit `line`");
  });

  test("a diagram asks for one flowchart plus one acp-nodes block, keyed on source ids", () => {
    const text = buildDiagramMessage(g({ kind: "request-flow" }), "request-flow");
    expect(text.split("\n")[0]).toBe("Diagram request — draw the request flow through this change; do not edit anything.");
    expect(text).toContain("EXACTLY ONE fenced `mermaid` flowchart block");
    expect(text).toContain("EXACTLY ONE fenced block with info string `acp-nodes`");
    expect(text).toContain("the node identifiers written in the mermaid source, not the node labels");
    // Nothing the agent writes into the diagram can navigate, and saying so
    // beats a reviewer wondering why their click directive did nothing.
    expect(text).toContain("Click directives and links inside the mermaid source are ignored");
  });

  test("each diagram shape asks for that shape", () => {
    expect(buildDiagramMessage(g(), "architecture")).toContain("draw the architecture this change sits in");
    expect(buildDiagramMessage(g(), "call-flow")).toContain("draw the call flow through this change");
  });

  test("every request says its paths mean the checkout as it is now", () => {
    // A trace taken under a commit's scope must not be read as a historical
    // location: what opens afterwards is the working file.
    const now = "Paths refer to the checkout as it is now (working tree); results open the current file.";
    expect(buildGuideMessage(g())).toContain(now);
    expect(buildDiagramMessage(g(), "architecture")).toContain(now);
  });
});
