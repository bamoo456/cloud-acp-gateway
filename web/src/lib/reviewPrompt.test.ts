import { describe, expect, test } from "vitest";
import { buildReviewMessage, buildApprovalMessage, describeScope } from "./reviewPrompt.ts";
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
