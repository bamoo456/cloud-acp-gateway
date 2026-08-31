import { describe, expect, test } from "vitest";
import { buildHandoffMessage, MAX_HANDOFF_BYTES } from "./handoffPrompt.ts";
import type { ThreadItem } from "../types.ts";

const user = (text: string, over: Partial<Extract<ThreadItem, { kind: "user" }>> = {}): ThreadItem =>
  ({ id: "u", kind: "user", text, ...over });
const asst = (text: string): ThreadItem => ({ id: "a", kind: "assistant", text });

const src = (items: ThreadItem[]) => ({
  items, fromAgent: "claude", title: "Filetree folder git badge", cwd: "/repo",
});

describe("buildHandoffMessage", () => {
  test("heads the message with who and where, so the retelling isn't mistaken for this session's own", () => {
    const text = buildHandoffMessage(src([user("hi"), asst("hello")]), "carry on");
    expect(text.split("\n")[0]).toBe("## Handoff from claude — “Filetree folder git badge”");
    expect(text).toContain("Folder: /repo");
    expect(text).toContain("The conversation follows in full.");
  });

  test("an untitled conversation is not given a name it doesn't have", () => {
    const text = buildHandoffMessage({ ...src([user("hi")]), title: "Untitled" }, "go");
    expect(text.split("\n")[0]).toBe("## Handoff from claude");
  });

  test("keeps what was said and drops what the receiving agent can re-derive", () => {
    const items: ThreadItem[] = [
      user("plan the badge"),
      { id: "t", kind: "thought", text: "the entry needs a repo flag" },
      {
        id: "c", kind: "tool", toolCallId: "c1", title: "Read workspace.ts", toolKind: "read",
        status: "completed", locations: ["src/workspace.ts"], content: [],
      },
      { id: "p", kind: "permission", reqId: 1, title: "Edit workspace.ts", options: [], resolved: true },
      asst("add a repo flag to each entry"),
    ];
    const text = buildHandoffMessage(src(items), "build it");
    expect(text).toContain("**User:**\nplan the badge");
    expect(text).toContain("**claude:**\nadd a repo flag to each entry");
    expect(text).not.toContain("the entry needs a repo flag");
    expect(text).not.toContain("Read workspace.ts");
    expect(text).not.toContain("Edit workspace.ts");
  });

  test("the plan survives — on a plan-here-build-there handoff it is the point", () => {
    const items: ThreadItem[] = [{
      id: "pl", kind: "plan", entries: [
        { content: "mark nested checkouts in tree()", status: "completed" },
        { content: "draw the badge", status: "in_progress" },
        { content: "cover it in workspace.test.ts", status: "pending" },
        { content: "   ", status: "pending" },
      ],
    }];
    const text = buildHandoffMessage(src(items), "finish it");
    expect(text).toContain("**claude — plan:**");
    expect(text).toContain("- [x] mark nested checkouts in tree()");
    expect(text).toContain("- [~] draw the badge");
    expect(text).toContain("- [ ] cover it in workspace.test.ts");
    // An entry with no content would render as a bare checkbox — a task that
    // reads as "something, forgotten".
    expect(text).not.toContain("- [ ] \n");
  });

  test("attachments become named placeholders rather than vanishing", () => {
    // A reply to a screenshot read as a reply to nothing is worse than a reply to
    // "[image]": the second is missing information, the first is wrong.
    const text = buildHandoffMessage(src([
      user("like this", { images: [{ mimeType: "image/png", data: "x" }], files: [{ name: "plan.md", range: "1-20" }] }),
    ]), "go");
    expect(text).toContain("[image]");
    expect(text).toContain("[file: plan.md:1-20]");
  });

  test("the instruction lands last, where an agent reads the ask", () => {
    const text = buildHandoffMessage(src([user("hi"), asst("hello")]), "implement the last item");
    expect(text.trimEnd().endsWith("implement the last item")).toBe(true);
    expect(text).toContain("none of its tool state");
  });

  test("over budget, the OLDEST messages go and the header says how many", () => {
    // The end of a conversation is where the plan, the decision and the last
    // failure are — so the budget is spent backwards from there.
    const big = "x".repeat(4000);
    const items = Array.from({ length: 20 }, (_, i) => asst(`m${i} ${big}`));
    const text = buildHandoffMessage(src(items), "go");
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_HANDOFF_BYTES + 1024);
    expect(text).toMatch(/The first \d+ messages are not included/);
    expect(text).toContain("m19");
    expect(text).not.toContain("m0 ");
  });

  test("one message that alone blows the budget is clipped, not dropped", () => {
    // Dropping it would leave a handoff with no conversation in it at all.
    const text = buildHandoffMessage(src([asst("y".repeat(MAX_HANDOFF_BYTES * 2))]), "go");
    expect(text).toContain("…[truncated]");
    expect(text).toContain("**claude:**");
    expect(text.trimEnd().endsWith("go")).toBe(true);
  });
});
