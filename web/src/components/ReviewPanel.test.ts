import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChangesResult, CommitEntry, FileDiffResult, ReviewComment } from "../lib/api.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const COMMITS: CommitEntry[] = [
  { sha: "aaaa111bbbb", shortSha: "aaaa111", author: "Ada", date: "2026-08-13T10:00:00Z",
    subject: "feat: the thing", files: 2, additions: 30, deletions: 4 },
  { sha: "cccc222dddd", shortSha: "cccc222", author: "Ada", date: "2026-08-12T10:00:00Z",
    subject: "Merge pull request #97" },
];

const CHANGES: ChangesResult = {
  repo: "/repo",
  truncated: false,
  files: [
    { path: "src/workspace.ts", abs: "/repo/src/workspace.ts", status: "modified", staged: false, additions: 12, deletions: 3 },
  ],
};

const DIFF: FileDiffResult = {
  path: "src/workspace.ts",
  status: "modified",
  binary: false,
  truncated: false,
  diff: ["@@ -404,3 +404,4 @@", " keep", "-old line", "+new line"].join("\n"),
};

describe("ReviewPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getCommits: ReturnType<typeof vi.fn>;
  let getWorkspaceChanges: ReturnType<typeof vi.fn>;
  let getFileDiff: ReturnType<typeof vi.fn>;
  let getReviewDraft: ReturnType<typeof vi.fn>;
  let saveReviewDraft: ReturnType<typeof vi.fn>;
  let sendPrompt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);

    getCommits = vi.fn().mockResolvedValue({
      repo: "/repo", commits: COMMITS, branch: "feature", defaultBase: "origin/main",
    });
    getWorkspaceChanges = vi.fn().mockResolvedValue(CHANGES);
    getFileDiff = vi.fn().mockResolvedValue(DIFF);
    getReviewDraft = vi.fn().mockResolvedValue({ scope: "working", comments: [], counts: {}, persisted: true });
    saveReviewDraft = vi.fn().mockResolvedValue(true);
    sendPrompt = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../lib/api.ts", () => ({
      getCommits, getWorkspaceChanges, getFileDiff, getReviewDraft, saveReviewDraft,
    }));
    vi.doMock("../store/store.ts", () => ({
      useStore: (pick: (s: unknown) => unknown) =>
        pick({ sendPrompt, agentReady: true, closeFiles: vi.fn() }),
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
    vi.doUnmock("../lib/api.ts");
    vi.doUnmock("../store/store.ts");
  });

  async function render(onCount = vi.fn()) {
    const { ReviewPanel } = await import("./ReviewPanel.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(ReviewPanel, { cwd: "/repo", onCount }));
    });
    await act(async () => { await flush(); });
    return onCount;
  }

  const click = async (el: Element | null | undefined) => {
    await act(async () => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
  };

  const chip = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".rv-chip")].find((b) => b.textContent === label);
  const rows = () => [...container.querySelectorAll<HTMLElement>(".udiff-row")];

  test("opens on the working tree — the scope that needs no picking", async () => {
    await render();
    expect(chip("Working")?.className).toContain("on");
    // No revision parameter: the working tree is what the panel has always shown.
    expect(getWorkspaceChanges).toHaveBeenCalledWith("/repo", null);
    // Name and folder are separate cells, as in every other list in the panel.
    expect(container.querySelector(".wf-nm")?.textContent).toBe("workspace.ts");
    expect(container.querySelector(".wf-dir")?.textContent).toBe("src");
  });

  test("Commits lists the log, and picking one re-asks for that revision", async () => {
    await render();
    await click(chip("Commits"));
    expect(container.textContent).toContain("feat: the thing");
    // A merge reports no counts rather than zeroes.
    expect(container.textContent).toContain("Merge pull request #97");

    await click([...container.querySelectorAll(".rv-commit")][0]);
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { commit: "aaaa111bbbb" });
  });

  test("Branch defaults to the base the gateway resolved", async () => {
    await render();
    await click(chip("Branch"));
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { base: "origin/main" });
    expect(container.querySelector(".rv-ref")?.textContent).toContain("origin/main");
  });

  test("every diff row is a comment target, and adding one saves the draft", async () => {
    const onCount = await render();
    await click(container.querySelector(".wf-row"));
    expect(getFileDiff).toHaveBeenCalledWith("/repo", "/repo/src/workspace.ts", null);

    // The whole row, not a hover-only affordance: this panel is driven from a
    // phone, where there is no hover to reveal anything.
    const added = rows().find((r) => r.className.includes("add"));
    expect(added?.tagName).toBe("BUTTON");
    await click(added);
    const box = container.querySelector<HTMLTextAreaElement>(".rv-cmt textarea");
    expect(box).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box!, "this leaks");
      box!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add comment"));

    expect(saveReviewDraft).toHaveBeenCalledTimes(1);
    const [, spec, saved] = saveReviewDraft.mock.calls[0] as [string, unknown, ReviewComment[]];
    expect(spec).toBe(null);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      path: "src/workspace.ts", side: "new", line: 405, code: "new line", body: "this leaks",
    });
    // The badge on the tab is the only thing that says an unsent review exists
    // while you are looking at something else.
    expect(onCount).toHaveBeenLastCalledWith(1);
  });

  test("a comment on a deleted line is anchored to the old side", async () => {
    // The two numbering schemes are not interchangeable — storing this against
    // the new side would point at unrelated code.
    await render();
    await click(container.querySelector(".wf-row"));
    await click(rows().find((r) => r.className.includes("del")));
    expect(container.querySelector(".rv-anchor")?.textContent).toContain("removed");
  });

  test("Send builds one message from the whole draft and clears it", async () => {
    getReviewDraft.mockResolvedValue({
      scope: "working", persisted: true, counts: { working: 1 },
      comments: [{ id: "x1", path: "src/workspace.ts", side: "new", line: 405, code: "+new line", body: "this leaks" }],
    });
    await render();
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Send review"));

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const text = sendPrompt.mock.calls[0][0] as string;
    expect(text).toContain("Code review — 1 comment on the working tree");
    expect(text).toContain("### src/workspace.ts:405");
    expect(text).toContain("this leaks");
    // Cleared only after the send resolved — a review that never reached the
    // agent has to still be on screen.
    expect(saveReviewDraft).toHaveBeenLastCalledWith("/repo", null, []);
  });

  test("an empty review offers Approve instead of Send", async () => {
    await render();
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve");
    expect(btn).toBeTruthy();
    await click(btn);
    expect(sendPrompt.mock.calls[0][0]).toBe("Reviewed the working tree — looks good to me, no comments.");
  });

  test("a draft the gateway can't store says so rather than losing it quietly", async () => {
    getReviewDraft.mockResolvedValue({ scope: "working", comments: [], counts: {}, persisted: false });
    saveReviewDraft.mockResolvedValue(false);
    await render();
    await click(container.querySelector(".wf-row"));
    await click(rows().find((r) => r.className.includes("add")));
    const box = container.querySelector<HTMLTextAreaElement>(".rv-cmt textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hm");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Add comment"));
    await click(container.querySelector(".icon-btn"));  // back to the file list
    expect(container.querySelector(".rv-warn")?.textContent).toContain("not saved");
  });

  test("a folder that isn't a checkout says there's nothing to review", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: null, files: [], truncated: false, reason: "not-a-repo" });
    await render();
    expect(container.textContent).toContain("isn't a git checkout");
    // No footer: there is nothing to send, and nothing to approve.
    expect(container.querySelector(".rv-foot")).toBe(null);
  });

  test("a base ref git doesn't know is named, not rendered as an empty diff", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: "/repo", files: [], truncated: false, reason: "bad-revision" });
    await render();
    await click(chip("Branch"));
    expect(container.textContent).toContain("git doesn't know");
    expect(container.textContent).toContain("origin/main");
  });
});

describe("ReviewPanel · sending mid-turn", () => {
  test("Send is disabled while the session has a turn in flight", async () => {
    // sendPrompt returns without sending when the active session is busy, and
    // nothing rejects — so an enabled button here would resolve, clear the
    // draft, and lose the whole review to a no-op.
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/api.ts", () => ({
      getCommits: vi.fn().mockResolvedValue({ repo: "/repo", commits: [] }),
      getWorkspaceChanges: vi.fn().mockResolvedValue(CHANGES),
      getFileDiff: vi.fn().mockResolvedValue(DIFF),
      getReviewDraft: vi.fn().mockResolvedValue({ scope: "working", comments: [], counts: {}, persisted: true }),
      saveReviewDraft: vi.fn().mockResolvedValue(true),
    }));
    vi.doMock("../store/store.ts", () => ({
      useStore: (pick: (s: unknown) => unknown) => pick({
        sendPrompt, agentReady: true, closeFiles: vi.fn(),
        activeId: "s1", busySessionIds: { s1: true },
      }),
    }));
    const { ReviewPanel } = await import("./ReviewPanel.tsx");
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(ReviewPanel, { cwd: "/repo", onCount: vi.fn() }));
    });
    await act(async () => { await flush(); });

    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve");
    expect(btn?.disabled).toBe(true);
    act(() => root?.unmount());
    document.body.innerHTML = "";
    vi.doUnmock("../lib/api.ts");
    vi.doUnmock("../store/store.ts");
  });
});
