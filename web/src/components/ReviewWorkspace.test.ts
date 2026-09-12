import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChangesResult, CommitEntry, FileDiffResult, ReviewComment } from "../lib/api.ts";

// A file row, not a folder row: the changed files are a folder tree, so
// ".wf-row" also matches the folder headers the tree draws.
const FILE_ROW = "button.wf-row:not(.wf-dir-row)";

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

const NEW_COMMIT: CommitEntry = {
  sha: "eeee333ffff", shortSha: "eeee333", author: "Ada", date: "2026-08-14T10:00:00Z",
  subject: "fix: the other thing", files: 1, additions: 2, deletions: 1,
};

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

describe("review workspace", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getCommits: ReturnType<typeof vi.fn>;
  let getWorkspaceChanges: ReturnType<typeof vi.fn>;
  let getFileDiff: ReturnType<typeof vi.fn>;
  let getFilePreview: ReturnType<typeof vi.fn>;
  let getReviewDraft: ReturnType<typeof vi.fn>;
  let saveReviewDraft: ReturnType<typeof vi.fn>;
  let sendPrompt: ReturnType<typeof vi.fn>;
  let Harness: React.FunctionComponent<{ active?: boolean }>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token":"t","defaultAgent":"claude",
      "agents":[{"name":"claude","cwd":"/repo"}],"fsRoot":"/"}</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);

    getCommits = vi.fn().mockResolvedValue({
      repo: "/repo", commits: COMMITS, branch: "feature", defaultBase: "origin/main",
    });
    getWorkspaceChanges = vi.fn().mockResolvedValue(CHANGES);
    getFileDiff = vi.fn().mockResolvedValue(DIFF);
    getFilePreview = vi.fn().mockResolvedValue({
      abs: "/repo/src/workspace.ts", path: "src/workspace.ts", kind: "text", size: 12, text: "on disk",
    });
    getReviewDraft = vi.fn().mockResolvedValue({ scope: "working", comments: [], counts: {}, persisted: true });
    saveReviewDraft = vi.fn().mockResolvedValue(true);
    sendPrompt = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../lib/api.ts", () => ({
      getCommits, getWorkspaceChanges, getFileDiff, getFilePreview, getReviewDraft, saveReviewDraft,
      // The viewer builds a download link as it renders, so this one is read
      // even by a test that never opens a file.
      rawFileUrl: () => "/raw",
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
    vi.doUnmock("../lib/api.ts");
  });

  // The real store, not a stand-in: the canvas reads the location
  // `openFilePreview` writes, and which of the two slots it writes is decided by
  // the workspace being in Review. A mocked store cannot do that round trip.
  async function setup(seed: Record<string, unknown> = {}) {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      cwd: "/repo", workspace: "review", agentReady: true, sendPrompt, ...seed,
    } as never);
    const { useReviewSession, ReviewLeft, ReviewCanvas } = await import("./ReviewWorkspace.tsx");
    // The two columns are siblings around `.content`, sharing one hook that
    // App holds — this is that shape, minus the conversation between them.
    Harness = ({ active = true }) => {
      const rv = useReviewSession("/repo", active);
      return React.createElement(React.Fragment, null,
        React.createElement(ReviewLeft, { rv }),
        React.createElement(ReviewCanvas, { rv }));
    };
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Harness, { active: true }));
    });
    await act(async () => { await flush(); });
    return useStore;
  }

  // The workspace leaving and returning to the screen. Both columns stay
  // mounted either way — the hook lives in App, which outlives the switch.
  const setActive = async (active: boolean) => {
    await act(async () => { root?.render(React.createElement(Harness, { active })); });
    await act(async () => { await flush(); });
  };

  const click = async (el: Element | null | undefined) => {
    await act(async () => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
  };

  const chip = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".rv-chip")].find((b) => b.textContent === label);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  const refresh = () => container.querySelector<HTMLButtonElement>('.rv-bar button[title="Refresh"]');
  const rows = () => [...container.querySelectorAll<HTMLElement>(".udiff-row")];
  const nav = (label: string) =>
    container.querySelector<HTMLButtonElement>(`main.canvas .rv-bar button[aria-label="${label}"]`);
  const canvasBody = () => container.querySelector<HTMLElement>("main.canvas .wf-body")!;

  test("opens on the working tree — the scope that needs no picking", async () => {
    await setup();
    expect(chip("Working")?.className).toContain("on");
    // No revision parameter: the working tree is what Review has always shown.
    expect(getWorkspaceChanges).toHaveBeenCalledWith("/repo", null);
    // The scope chips are the canvas's; the files are the left column's.
    expect(container.querySelector("main.canvas .rv-scope")).not.toBeNull();
    expect(container.querySelector("aside.rv-left " + FILE_ROW + " .wf-nm")?.textContent).toBe("workspace.ts");
    expect(container.querySelector("aside.rv-left button.wf-dir-row .wf-nm")?.textContent).toBe("src");
    // Nothing open yet, so the canvas says what to do rather than nothing.
    expect(container.querySelector("main.canvas")?.textContent).toContain("Pick a changed file");
  });

  test("a folder row folds its files away, and back", async () => {
    await setup();
    const folder = container.querySelector<HTMLButtonElement>("button.wf-dir-row")!;
    expect(folder.getAttribute("aria-expanded")).toBe("true");

    await click(folder);
    expect(container.querySelector(FILE_ROW)).toBeNull();
    expect(container.querySelector<HTMLButtonElement>("button.wf-dir-row")!
      .getAttribute("aria-expanded")).toBe("false");

    await click(container.querySelector("button.wf-dir-row"));
    expect(container.querySelector(FILE_ROW + " .wf-nm")?.textContent).toBe("workspace.ts");
  });

  test("a changed file opens in the canvas, and nowhere else", async () => {
    // The single-viewer rule: the canvas is the Review workspace's one viewer,
    // and the Agent workspace's slot must not have been touched on the way.
    const useStore = await setup();
    await click(container.querySelector(FILE_ROW));
    expect(container.querySelector("main.canvas .udiff")).not.toBeNull();
    expect(container.querySelector("main.canvas .rv-title")?.textContent).toBe("src/workspace.ts");
    expect(useStore.getState().reviewPreview?.abs).toBe("/repo/src/workspace.ts");
    expect(useStore.getState().filePreview).toBeNull();
    expect(useStore.getState().filesOpen).toBe(false);
  });

  test("Commits lists the log in the canvas, and picking one re-asks for that revision", async () => {
    await setup();
    await click(chip("Commits"));
    expect(container.querySelector("main.canvas")?.textContent).toContain("feat: the thing");
    // A merge reports no counts rather than zeroes.
    expect(container.textContent).toContain("Merge pull request #97");
    // The left column has nothing to list until a revision is chosen.
    expect(container.querySelector("aside.rv-left")?.textContent).toContain("Pick a commit");

    await click([...container.querySelectorAll(".rv-commit")][0]);
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { commit: "aaaa111bbbb" });
  });

  test("a refresh re-reads the log — an agent's commit lands mid-review", async () => {
    await setup();
    await click(chip("Commits"));
    expect(container.textContent).not.toContain("fix: the other thing");

    getCommits.mockResolvedValue({
      repo: "/repo", commits: [NEW_COMMIT, ...COMMITS], branch: "feature", defaultBase: "origin/main",
    });
    await click(refresh());
    expect(container.textContent).toContain("fix: the other thing");
  });

  test("a refresh keeps the revision and the file being read", async () => {
    await setup();
    await click(chip("Commits"));
    await click([...container.querySelectorAll(".rv-commit")][0]);
    await click(container.querySelector(FILE_ROW));
    expect(rows().length).toBeGreaterThan(0);

    await click(refresh());
    // Still that commit, and still that file: a refresh updates what is on
    // screen, it doesn't send you back to the list.
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { commit: "aaaa111bbbb" });
    expect(getFileDiff).toHaveBeenLastCalledWith("/repo", "/repo/src/workspace.ts", { commit: "aaaa111bbbb" });
    expect(rows().length).toBeGreaterThan(0);
  });

  test("a refresh doesn't overwrite a base someone typed", async () => {
    await setup();
    await click(chip("Branch"));
    await click(container.querySelector(".rv-ref"));
    const input = container.querySelector("input");
    await act(async () => {
      if (input) {
        // Through the native setter, or React's value tracker treats the write
        // as a no-op and the field keeps what it was rendered with.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
          .set!.call(input, "develop");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await flush(); });
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { base: "develop" });

    await click(refresh());
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { base: "develop" });
  });

  test("Refresh re-reads the open file's diff; a turn ending leaves it alone", async () => {
    const { makeSession } = await import("../store/reducers.ts");
    const useStore = await setup({
      activeId: "s1", sessions: { s1: { ...makeSession("s1"), working: true } },
    });
    await click(container.querySelector(FILE_ROW));
    expect(getFileDiff).toHaveBeenCalledTimes(1);

    // A turn ending refreshes the lists around the diff, not the diff itself:
    // it could be redrawn under a comment being written.
    await act(async () => {
      const st = useStore.getState();
      useStore.setState({ sessions: { s1: { ...st.sessions.s1, working: false } } });
    });
    await act(async () => { await flush(); });
    expect(getWorkspaceChanges).toHaveBeenCalledTimes(2);
    expect(getFileDiff).toHaveBeenCalledTimes(1);
    expect(rows().length).toBeGreaterThan(0);

    // Refresh is an explicit ask, and takes the diff with it.
    await click(refresh());
    expect(getFileDiff).toHaveBeenCalledTimes(2);
    expect(getFileDiff).toHaveBeenLastCalledWith("/repo", "/repo/src/workspace.ts", null);
    expect(rows().length).toBeGreaterThan(0);
  });

  test("going back to the conversation leaves the review where it was", async () => {
    // Nothing is read while the Agent workspace is up — the file panel is
    // already asking git the same questions over there — and nothing is
    // dropped either: the revision and the file come back as they were.
    const useStore = await setup();
    await click(chip("Commits"));
    await click([...container.querySelectorAll(".rv-commit")][0]);
    await click(container.querySelector(FILE_ROW));
    const reads = getWorkspaceChanges.mock.calls.length;
    const logs = getCommits.mock.calls.length;

    await setActive(false);
    expect(getWorkspaceChanges.mock.calls.length).toBe(reads);
    expect(getCommits.mock.calls.length).toBe(logs);
    expect(useStore.getState().reviewPreview?.abs).toBe("/repo/src/workspace.ts");

    await setActive(true);
    expect(chip("Commits")?.className).toContain("on");
    expect(container.querySelector(".rv-ref")?.textContent).toContain("aaaa111");
    expect(container.querySelector("main.canvas .rv-title")?.textContent).toBe("src/workspace.ts");
    // And it re-reads on the way in: the agent may have been working while you
    // were answering it.
    expect(getWorkspaceChanges.mock.calls.length).toBeGreaterThan(reads);
  });

  test("Branch defaults to the base the gateway resolved", async () => {
    await setup();
    await click(chip("Branch"));
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { base: "origin/main" });
    expect(container.querySelector(".rv-ref")?.textContent).toContain("origin/main");
  });

  test("every diff row is a comment target, and adding one saves the draft", async () => {
    await setup();
    await click(container.querySelector(FILE_ROW));
    expect(getFileDiff).toHaveBeenCalledWith("/repo", "/repo/src/workspace.ts", null);

    // The whole row, not a hover-only affordance: this is driven from a phone,
    // where there is no hover to reveal anything.
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
    await click(button("Add comment"));

    expect(saveReviewDraft).toHaveBeenCalledTimes(1);
    const [, spec, saved] = saveReviewDraft.mock.calls[0] as [string, unknown, ReviewComment[]];
    expect(spec).toBe(null);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      path: "src/workspace.ts", side: "new", line: 405, code: "new line", body: "this leaks",
    });
    // And the file's row carries what was written against it.
    expect(container.querySelector("aside.rv-left .rv-badge")?.textContent).toBe("1");
  });

  test("Ask on a diff line captures that line, its side and the scope for the composer", async () => {
    const { makeSession } = await import("../store/reducers.ts");
    const useStore = await setup({
      // The session's own agent, not the connection's: they differ right after a switch.
      agentName: "codex",
      activeId: "s1", sessions: { s1: { ...makeSession("s1"), agentName: "claude" } },
      // Mid-turn on purpose: Ask is not the Send button, the composer queues it.
      busySessionIds: { s1: true },
    });
    await click(container.querySelector(FILE_ROW));
    await click(rows().find((r) => r.className.includes("del")));
    await click([...container.querySelectorAll(".rv-acts button")].find((b) => b.textContent === "Ask"));

    expect(useStore.getState().askFix).toEqual({
      intent: "ask", agentName: "claude", sessionId: "s1", cwd: "/repo", spec: null, label: undefined,
      path: "src/workspace.ts", side: "old", line: 405, code: "old line",
    });
    // Nothing became a comment, and the diff under the picked row stays put.
    expect(saveReviewDraft).not.toHaveBeenCalled();
    expect(getFileDiff).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".rv-cmt textarea")).toBeTruthy();
  });

  test("Ask/Fix are not offered on a saved conversation that has not been resumed", async () => {
    // sendPromptTo refuses a view-only session, so the buttons would only bounce.
    const { makeSession } = await import("../store/reducers.ts");
    await setup({ activeId: "s1", sessions: { s1: { ...makeSession("s1"), viewOnly: true } } });
    await click(container.querySelector(FILE_ROW));
    await click(rows().find((r) => r.className.includes("del")));
    const acts = [...container.querySelectorAll(".rv-cmt .rv-acts button")].map((b) => b.textContent);
    expect(acts).not.toContain("Ask");
    expect(acts).toContain("Add comment");
  });

  test("a comment on a deleted line is anchored to the old side", async () => {
    // The two numbering schemes are not interchangeable — storing this against
    // the new side would point at unrelated code.
    await setup();
    await click(container.querySelector(FILE_ROW));
    await click(rows().find((r) => r.className.includes("del")));
    expect(container.querySelector(".rv-anchor")?.textContent).toContain("removed");
  });

  test("a file a revision didn't touch says so, instead of showing today's file", async () => {
    // The viewer falls back to the file on disk when a diff is empty, which
    // under a commit's name would be unrelated current code.
    getFileDiff.mockResolvedValue({ ...DIFF, diff: "" });
    await setup();
    await click(chip("Commits"));
    await click([...container.querySelectorAll(".rv-commit")][0]);
    await click(container.querySelector(FILE_ROW));

    expect(container.textContent).toContain("This revision didn't change this file");
    expect(getFilePreview).not.toHaveBeenCalled();
  });

  test("a file opened from the conversation is read as itself, not as the revision's", async () => {
    // A CodeRef names a line in the working file. Under a commit's scope the
    // canvas must still show it as that file — and offer no comment layer,
    // since a line the commit never had cannot be anchored in its draft.
    const useStore = await setup();
    await click(chip("Commits"));
    await click([...container.querySelectorAll(".rv-commit")][0]);
    // From a changed file of that commit, so the CodeRef has somewhere to
    // retrace to below.
    await click(container.querySelector(FILE_ROW));
    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/gateway.ts", path: "src/gateway.ts", mode: "diff" });
    });
    await act(async () => { await flush(); });

    expect(getFileDiff).toHaveBeenLastCalledWith("/repo", "/repo/src/gateway.ts", null);
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().some((r) => r.tagName === "BUTTON")).toBe(false);

    // And retracing it doesn't change the review either: opening a file that
    // named no revision left the scope alone, so Back and Forward must too.
    await click(nav("Back"));
    await click(nav("Forward"));
    expect(chip("Commits")?.className).toContain("on");
    expect(getWorkspaceChanges).toHaveBeenLastCalledWith("/repo", { commit: "aaaa111bbbb" });
  });

  test("leaving for the conversation keeps the offset the canvas was left at", async () => {
    const useStore = await setup();
    await click(container.querySelector(FILE_ROW));
    canvasBody().scrollTop = 80;
    await act(async () => { canvasBody().dispatchEvent(new Event("scroll")); });

    // The canvas is unmounted while the Agent workspace is up, and its scroller
    // goes with it — the location has to carry the offset out.
    await act(async () => { root?.unmount(); root = null; });
    expect(useStore.getState().reviewPreview).toMatchObject({ abs: "/repo/src/workspace.ts", scrollTop: 80 });
  });

  test("Send builds one message from the whole draft and clears it", async () => {
    getReviewDraft.mockResolvedValue({
      scope: "working", persisted: true, counts: { working: 1 },
      comments: [{ id: "x1", path: "src/workspace.ts", side: "new", line: 405, code: "+new line", body: "this leaks" }],
    });
    await setup();
    await click(button("Send review"));

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
    await setup();
    const btn = button("Approve");
    expect(btn).toBeTruthy();
    await click(btn);
    expect(sendPrompt.mock.calls[0][0]).toBe("Reviewed the working tree — looks good to me, no comments.");
  });

  test("Send is disabled while the session has a turn in flight", async () => {
    // sendPrompt returns without sending when the active session is busy, and
    // nothing rejects — so an enabled button here would resolve, clear the
    // draft, and lose the whole review to a no-op.
    const { makeSession } = await import("../store/reducers.ts");
    await setup({
      activeId: "s1", sessions: { s1: makeSession("s1") }, busySessionIds: { s1: true },
    });
    expect(button("Approve")?.disabled).toBe(true);
  });

  test("a draft the gateway can't store says so rather than losing it quietly", async () => {
    getReviewDraft.mockResolvedValue({ scope: "working", comments: [], counts: {}, persisted: false });
    saveReviewDraft.mockResolvedValue(false);
    await setup();
    await click(container.querySelector(FILE_ROW));
    await click(rows().find((r) => r.className.includes("add")));
    const box = container.querySelector<HTMLTextAreaElement>(".rv-cmt textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hm");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Add comment"));
    expect(container.querySelector(".rv-warn")?.textContent).toContain("not saved");
  });

  test("a folder that isn't a checkout says there's nothing to review", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: null, files: [], truncated: false, reason: "not-a-repo" });
    await setup();
    expect(container.textContent).toContain("isn't a git checkout");
    // No footer: there is nothing to send, and nothing to approve.
    expect(container.querySelector(".rv-foot")).toBe(null);
  });

  test("a base ref git doesn't know is named, not rendered as an empty diff", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: "/repo", files: [], truncated: false, reason: "bad-revision" });
    await setup();
    await click(chip("Branch"));
    expect(container.textContent).toContain("git doesn't know");
    expect(container.textContent).toContain("origin/main");
    // The regression: a failed diff also rendered "nothing changed" underneath,
    // flatly contradicting the line above it.
    expect(container.textContent).not.toContain("Nothing changed here");
  });

  test("a base with no common ancestor points at the fetch depth, not the ref", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: "/repo", files: [], truncated: false, reason: "no-merge-base" });
    await setup();
    await click(chip("Branch"));
    expect(container.textContent).toContain("too shallow");
    expect(container.textContent).toContain("git fetch --unshallow");
    expect(container.textContent).not.toContain("never have been fetched");
    expect(container.textContent).not.toContain("Nothing changed here");
  });

  test("a diff git couldn't run at all isn't reported as a clean worktree", async () => {
    // changes() returns repo: root with reason "status-failed" — non-null repo
    // and no files, which used to land in the "nothing uncommitted" branch.
    getWorkspaceChanges.mockResolvedValue({ repo: "/repo", files: [], truncated: false, reason: "status-failed" });
    await setup();
    expect(container.textContent).toContain("git couldn't read");
    expect(container.textContent).not.toContain("Nothing uncommitted");
  });
  test("Back returns to the file, the view and the offset it was left at", async () => {
    const useStore = await setup();
    expect(nav("Back")?.disabled).toBe(true);
    await click(container.querySelector(FILE_ROW));

    // Where the reader had got to, off the viewer's own scroller — scroll does
    // not bubble, so the canvas listens for it in the capture phase.
    canvasBody().scrollTop = 120;
    await act(async () => { canvasBody().dispatchEvent(new Event("scroll")); });
    // And in which view: a location is only the same place if it comes back the
    // way it was being read.
    await click(button("File"));

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/gateway.ts", path: "src/gateway.ts", mode: "diff" });
    });
    await act(async () => { await flush(); });
    expect(container.querySelector("main.canvas .rv-title")?.textContent).toBe("src/gateway.ts");
    // The viewer is the same element across a navigation, so it still carries
    // the offset of the file it was showing — the restore below has to be what
    // puts it back, not what is left over.
    canvasBody().scrollTop = 0;

    await click(nav("Back"));
    expect(useStore.getState().reviewPreview).toMatchObject({
      abs: "/repo/src/workspace.ts", mode: "file", scrollTop: 120,
    });
    expect(canvasBody().scrollTop).toBe(120);

    await click(nav("Forward"));
    expect(container.querySelector("main.canvas .rv-title")?.textContent).toBe("src/gateway.ts");
    expect(nav("Forward")?.disabled).toBe(true);
  });

  test("Back out of a scope change brings the revision with it", async () => {
    // Choosing a revision closes the file read against the old one. Back has to
    // put the chips back too, or the header would name a revision the canvas
    // isn't reading.
    const useStore = await setup();
    await click(chip("Commits"));
    await click([...container.querySelectorAll(".rv-commit")][0]);
    await click(container.querySelector(FILE_ROW));
    expect(getFileDiff).toHaveBeenLastCalledWith("/repo", "/repo/src/workspace.ts", { commit: "aaaa111bbbb" });

    await click(chip("Working"));
    expect(useStore.getState().reviewPreview).toBeNull();

    await click(nav("Back"));
    expect(chip("Commits")?.className).toContain("on");
    expect(container.querySelector(".rv-ref")?.textContent).toContain("aaaa111");
    expect(getFileDiff).toHaveBeenLastCalledWith("/repo", "/repo/src/workspace.ts", { commit: "aaaa111bbbb" });
  });

  test("one sheet at a time, and opening a file reveals the canvas", async () => {
    const useStore = await setup();
    await click(button("Files"));
    expect(useStore.getState().reviewSheet).toBe("files");
    expect(container.querySelector("aside.rv-left")?.className).toContain("open");

    await click(button("Companion"));
    expect(useStore.getState().reviewSheet).toBe("companion");
    expect(container.querySelector("aside.rv-left")?.className).not.toContain("open");

    await click(button("Files"));
    await click(container.querySelector(FILE_ROW));
    // A row tapped through the sheet has navigated nowhere the reader can see
    // until the sheet is out of the way.
    expect(useStore.getState().reviewSheet).toBe("none");
  });

  test("Escape closes the sheet and hands focus back to the button that opened it", async () => {
    const useStore = await setup();
    const files = button("Files")!;
    await click(files);
    expect(useStore.getState().reviewSheet).toBe("files");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useStore.getState().reviewSheet).toBe("none");
    expect(document.activeElement).toBe(files);
  });
});
