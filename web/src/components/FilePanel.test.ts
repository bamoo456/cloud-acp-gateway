import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChangesResult, FileDiffResult, FilePreviewResult } from "../lib/api.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const CHANGES: ChangesResult = {
  repo: "/repo",
  truncated: false,
  files: [
    { path: "src/gateway.ts", abs: "/repo/src/gateway.ts", status: "modified", staged: false, additions: 12, deletions: 3 },
    { path: "docs/shot.png", abs: "/repo/docs/shot.png", status: "untracked", staged: false },
  ],
};

const DIFF: FileDiffResult = {
  path: "src/gateway.ts",
  status: "modified",
  binary: false,
  truncated: false,
  diff: ["@@ -1,3 +1,3 @@", " keep", "-old line", "+new line"].join("\n"),
};

describe("FilePanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getWorkspaceChanges: ReturnType<typeof vi.fn>;
  let getFileDiff: ReturnType<typeof vi.fn>;
  let getFilePreview: ReturnType<typeof vi.fn>;
  let getWorkspaceTree: ReturnType<typeof vi.fn>;
  let getWorkspaceOutputs: ReturnType<typeof vi.fn>;
  let getHtmlRender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp",
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    getWorkspaceChanges = vi.fn().mockResolvedValue(CHANGES);
    getFileDiff = vi.fn().mockResolvedValue(DIFF);
    getFilePreview = vi.fn().mockResolvedValue({
      path: "src/gateway.ts", abs: "/repo/src/gateway.ts", kind: "text",
      size: 20, modifiedAt: new Date().toISOString(), text: "line one\nline two\n", truncated: false,
    } satisfies FilePreviewResult);
    getWorkspaceTree = vi.fn().mockResolvedValue({
      abs: "/repo", path: "", truncated: false,
      entries: [{ name: "src", abs: "/repo/src", dir: true }],
    });
    // Nothing in this conversation wrote outside the checkout, which is the
    // ordinary case: the tests that care about output folders set their own.
    getWorkspaceOutputs = vi.fn().mockResolvedValue([]);
    getHtmlRender = vi.fn().mockResolvedValue({
      html: "", inlined: 0, skipped: 0, truncated: false, htmlTruncated: false,
    });
    vi.doMock("../lib/api.ts", () => ({
      getWorkspaceChanges,
      getFileDiff,
      getFilePreview,
      getWorkspaceTree,
      getWorkspaceOutputs,
      getHtmlRender,
      findWorkspaceFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, fromGit: true }),
      // The Project tab's folder switcher browses with the same /fs route the
      // composer's folder picker uses.
      listDir: vi.fn().mockResolvedValue({ root: "/", path: "/repo", parent: "/", dirs: [{ name: "other" }] }),
      rawFileUrl: (cwd: string, p: string) => `/workspace/raw?cwd=${cwd}&path=${p}`,
      // Review mode's surface. The panel reads the draft counts alongside the
      // change list (that is what badges the tab), so these have to exist even
      // for the tests that never open that mode.
      getReviewDraft: vi.fn().mockResolvedValue({ scope: "working", comments: [], counts: {}, persisted: true }),
      saveReviewDraft: vi.fn().mockResolvedValue(true),
      getCommits: vi.fn().mockResolvedValue({ repo: "/repo", commits: [] }),
      revParam: () => "",
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.doUnmock("../lib/api.ts");
    // matchMedia and innerWidth are stubbed per test; a failed assertion would
    // otherwise leak a 1600px desktop into whatever runs next.
    vi.unstubAllGlobals();
  });

  async function render() {
    const { FilePanel } = await import("./FilePanel.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(FilePanel));
    });
    await act(async () => { await flush(); });
  }

  const section = (name: string) =>
    [...container.querySelectorAll<HTMLElement>(".wf-sec")]
      .find((el) => el.querySelector(".wf-sec-head")?.getAttribute("data-section") === name);

  async function toggleSection(name: string) {
    const head = section(name)?.querySelector<HTMLButtonElement>(".wf-sec-head");
    await act(async () => { head?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
  }

  test("stays shut and reads only the diffstat the status bar shows", async () => {
    // The count is on screen with the panel closed — status bar, and the phone's
    // Changes badge — so the checkout is read; the lists nobody is looking at
    // are not built.
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ cwd: "/repo" });
    await render();
    expect(getWorkspaceChanges).toHaveBeenCalledWith("/repo");
    expect(getWorkspaceOutputs).not.toHaveBeenCalled();
    expect(container.querySelector("#files")?.className).not.toContain("open");
  });

  test("opening the panel reads the checkout, because Outputs is built from it", async () => {
    // Files an agent writes through a shell name no path in any tool call, so
    // without git the Outputs list would silently omit them.
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    expect(getWorkspaceChanges).toHaveBeenCalledWith("/repo");
  });

  test("every section is on screen at once, and each folds away", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    expect(section("outputs")).toBeDefined();
    expect(section("context")).toBeDefined();
    expect(section("outputs")?.querySelector(".wf-sec-body")).not.toBeNull();

    await toggleSection("outputs");
    expect(section("outputs")?.querySelector(".wf-sec-body")).toBeNull();
    expect(section("context")?.querySelector(".wf-sec-body")).not.toBeNull();
  });

  test("lists the folder's changed files with their line counts", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    expect(getWorkspaceChanges).toHaveBeenCalledWith("/repo");
    const rows = [...container.querySelectorAll("button.wf-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("gateway.ts");
    expect(rows[0].textContent).toContain("+12");
    expect(rows[0].textContent).toContain("−3");
    expect(rows[1].textContent).toContain("shot.png");
  });

  test("inspects the conversation's folder, not whatever the picker last showed", async () => {
    // Opening a session from another folder leaves s.cwd behind; diffing that
    // would show an unrelated checkout's changes.
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      filesOpen: true,
      cwd: "/elsewhere",
      activeId: "s1",
      sessions: { s1: { ...makeSession("s1"), cwd: "/repo/web" } },
    });
    await render();
    expect(getWorkspaceChanges).toHaveBeenCalledWith("/repo/web");
  });

  test("opening a row shows that file's diff", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    const row = container.querySelector<HTMLButtonElement>("button.wf-row");
    await act(async () => { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    expect(getFileDiff).toHaveBeenCalledWith("/repo", "/repo/src/gateway.ts");
    expect(container.querySelector(".wf-title")?.textContent).toBe("src/gateway.ts");
    expect(container.querySelector(".udiff-row.add .code")?.textContent).toBe("new line");
    expect(container.querySelector(".udiff-row.del .code")?.textContent).toBe("old line");
  });

  test("an .html file gets a Preview mode; other files don't", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    // src/gateway.ts (from the default DIFF fixture) is not HTML.
    const row = container.querySelector<HTMLButtonElement>("button.wf-row");
    await act(async () => { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    const modeLabels = () =>
      [...container.querySelectorAll(".wf-modes button:not(.wf-dl):not(.wf-search-btn)")].map((b) => b.textContent);
    expect(modeLabels()).toEqual(["Diff", "File"]);

    getFilePreview.mockResolvedValue({
      path: "report.html", abs: "/repo/report.html", kind: "text",
      size: 40, modifiedAt: new Date().toISOString(), text: "<h1>hi</h1>", truncated: false,
    } satisfies FilePreviewResult);
    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/report.html", path: "report.html", mode: "file" });
    });
    await act(async () => { await flush(); });
    expect(modeLabels()).toEqual(["Diff", "File", "Preview"]);
  });

  test("Preview renders the file in a sandboxed iframe with no same-origin access", async () => {
    getFilePreview.mockResolvedValue({
      path: "report.html", abs: "/repo/report.html", kind: "text",
      size: 40, modifiedAt: new Date().toISOString(),
      text: "<html><head></head><body><h1>hi</h1></body></html>", truncated: false,
    } satisfies FilePreviewResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/report.html", path: "report.html", mode: "file" });
    });
    await act(async () => { await flush(); });

    const previewBtn = [...container.querySelectorAll<HTMLButtonElement>(".wf-modes button")]
      .find((b) => b.textContent === "Preview");
    await act(async () => { previewBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    const iframe = container.querySelector<HTMLIFrameElement>("iframe.wf-html-preview");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    // The injected CSP is the actual security boundary's belt-and-suspenders —
    // assert it's really there, not just that an iframe exists.
    expect(iframe?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(container.textContent).toContain("Sandboxed preview");
  });

  test(".md files get a Preview mode too, rendered — not sandboxed, since nothing executes", async () => {
    getFilePreview.mockResolvedValue({
      path: "README.md", abs: "/repo/README.md", kind: "text",
      size: 20, modifiedAt: new Date().toISOString(),
      text: "# Title\n\nSome **bold** text.", truncated: false,
    } satisfies FilePreviewResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/README.md", path: "README.md", mode: "file" });
    });
    await act(async () => { await flush(); });

    const previewBtn = [...container.querySelectorAll<HTMLButtonElement>(".wf-modes button")]
      .find((b) => b.textContent === "Preview");
    expect(previewBtn).toBeDefined();
    await act(async () => { previewBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    // Same renderer chat markdown uses — an actual heading and bold element,
    // not escaped source text, and no sandboxed iframe (there's no script to
    // contain here, unlike the HTML preview).
    expect(container.querySelector(".wf-md-preview h1")?.textContent).toBe("Title");
    expect(container.querySelector(".wf-md-preview strong")?.textContent).toBe("bold");
    expect(container.querySelector("iframe.wf-html-preview")).toBeNull();
  });

  test("a picture beside the document is shown, and opens full size", async () => {
    // A README's own screenshot: relative to the file, which resolves against
    // the console's origin unless the preview says otherwise.
    getFilePreview.mockResolvedValue({
      path: "docs/guide.md", abs: "/repo/docs/guide.md", kind: "text",
      size: 40, modifiedAt: new Date().toISOString(),
      text: "# Guide\n\n![a shot](shot.png)\n", truncated: false,
    } satisfies FilePreviewResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/docs/guide.md", path: "docs/guide.md", mode: "file" });
    });
    await act(async () => { await flush(); });
    const previewBtn = [...container.querySelectorAll<HTMLButtonElement>(".wf-modes button")]
      .find((b) => b.textContent === "Preview")!;
    await act(async () => { previewBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    const img = container.querySelector<HTMLImageElement>(".wf-md-preview img")!;
    // The gateway's own bytes route, with the path resolved against the
    // document's folder — not /shot.png on this origin.
    expect(img.getAttribute("src")).toContain("/workspace/raw");
    expect(img.getAttribute("src")).toContain("/repo/docs/shot.png");

    // And it zooms, which is the only way to read a wide screenshot in a
    // 440px column.
    expect(container.querySelector(".wf-lightbox")).toBeNull();
    await act(async () => { img.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    // Resolved rather than the relative attribute — it is the same bytes route.
    expect(container.querySelector<HTMLImageElement>(".wf-lightbox img")?.src)
      .toContain("path=/repo/docs/shot.png");

    // Escape closes it, as it does every other overlay here.
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-lightbox")).toBeNull();
  });

  test("a file with no diff falls through to its contents instead of an empty pane", async () => {
    getFileDiff.mockResolvedValue({ ...DIFF, diff: "" });
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/gateway.ts", path: "src/gateway.ts" });
    });
    await act(async () => { await flush(); });

    expect(getFilePreview).toHaveBeenCalledWith("/repo", "/repo/src/gateway.ts");
    expect(container.querySelector("pre.wf-text")?.textContent).toBe("line one\nline two\n");
  });

  test("find-in-file counts the matches and Enter steps through them", async () => {
    // A phone has no browser find bar, so the viewer carries its own.
    getFilePreview.mockResolvedValue({
      path: "src/gateway.ts", abs: "/repo/src/gateway.ts", kind: "text",
      size: 40, modifiedAt: new Date().toISOString(),
      text: "const port = 1;\nconst host = 2;\nlet port2 = 3;\n", truncated: false,
    } satisfies FilePreviewResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/gateway.ts", path: "src/gateway.ts", mode: "file" });
    });
    await act(async () => { await flush(); });

    const open = container.querySelector<HTMLButtonElement>(".wf-search-btn")!;
    await act(async () => { open.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const input = container.querySelector<HTMLInputElement>(".wf-search input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "port");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-search .n")?.textContent).toBe("1/2");

    const enter = () => act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await enter();
    expect(container.querySelector(".wf-search .n")?.textContent).toBe("2/2");
    // Wraps rather than stopping dead at the last match.
    await enter();
    expect(container.querySelector(".wf-search .n")?.textContent).toBe("1/2");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".wf-search")).toBeNull();
  });

  test("a deleted file says so instead of bouncing into a 404", async () => {
    // The file-contents route MUST 404 a path that isn't on disk, so falling
    // through to it turned every deletion git can't describe — a file the agent
    // wrote and later removed through a shell, a staged `git rm` — into a red
    // error under a row that claims the conversation produced something.
    getFileDiff.mockResolvedValue({ ...DIFF, status: "deleted", diff: "" } satisfies FileDiffResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/gateway.ts", path: "src/gateway.ts" });
    });
    await act(async () => { await flush(); });

    expect(getFilePreview).not.toHaveBeenCalled();
    expect(container.querySelector(".wf-empty")?.textContent).toContain("has been deleted");
  });

  test("a deletion git can still describe shows the lines that went", async () => {
    // A tracked file removed from the worktree still diffs against HEAD, and
    // those lines are the most useful thing the panel has — the deleted case
    // must not swallow them.
    getFileDiff.mockResolvedValue({
      ...DIFF, status: "deleted",
      diff: ["@@ -1,2 +0,0 @@", "-old line", "-second line"].join("\n"),
    } satisfies FileDiffResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/gateway.ts", path: "src/gateway.ts" });
    });
    await act(async () => { await flush(); });

    expect(getFilePreview).not.toHaveBeenCalled();
    expect(container.querySelector(".udiff-row.del .code")?.textContent).toBe("old line");
  });

  test("Download fetches the bytes — it never links the page at an attachment", async () => {
    // A plain <a href download> is a top-level navigation, and the native
    // client's WKWebView answers an attachment response by killing the frame
    // (WebKitErrorDomain 102) and replacing the console with "Can't reach
    // gateway". So there must be no anchor here, and the click must go through
    // the blob helper instead.
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/download.ts", () => ({ downloadFile }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/docs/report.pdf", path: "docs/report.pdf", mode: "file" });
    });
    await act(async () => { await flush(); });

    expect(container.querySelector("a[download]")).toBeNull();
    expect(container.querySelector("a[href*='/workspace/raw']")).toBeNull();

    const dl = container.querySelector<HTMLButtonElement>("button.wf-dl");
    expect(dl).not.toBeNull();
    await act(async () => { dl?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(downloadFile).toHaveBeenCalledWith(
      "/workspace/raw?cwd=/repo&path=/repo/docs/report.pdf",
      "report.pdf",
    );
    vi.doUnmock("../lib/download.ts");
  });

  test("an image preview renders as a picture rather than as decoded bytes", async () => {
    getFilePreview.mockResolvedValue({
      path: "docs/shot.png", abs: "/repo/docs/shot.png", kind: "image",
      size: 4096, modifiedAt: new Date().toISOString(), mimeType: "image/png",
    } satisfies FilePreviewResult);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/docs/shot.png", path: "docs/shot.png", mode: "file" });
    });
    await act(async () => { await flush(); });

    const img = container.querySelector<HTMLImageElement>(".wf-image img");
    expect(img?.getAttribute("src")).toBe("/workspace/raw?cwd=/repo&path=/repo/docs/shot.png");
    expect(getFileDiff).not.toHaveBeenCalled();

    // Full size opens in-app. target="_blank" has nowhere to go in the native
    // client's webview — dropped silently at best, navigating away at worst.
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    expect(document.querySelector(".wf-lightbox")).toBeNull();
    const zoom = container.querySelector<HTMLButtonElement>(".wf-image button");
    await act(async () => { zoom?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".wf-lightbox img")?.getAttribute("src"))
      .toBe("/workspace/raw?cwd=/repo&path=/repo/docs/shot.png");
  });

  // A conversation that read one file and wrote another — the split the panel
  // exists to draw.
  async function withTouchedSession() {
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      filesOpen: true,
      cwd: "/repo",
      activeId: "s1",
      sessions: {
        s1: {
          ...makeSession("s1"),
          cwd: "/repo",
          items: [
            {
              id: "t1", kind: "tool", toolCallId: "t1", title: "Read", toolKind: "read",
              status: "completed", locations: ["file:///repo/notes/plan.md"], content: [],
            },
            {
              id: "t2", kind: "tool", toolCallId: "t2", title: "Write", toolKind: "edit",
              status: "completed", locations: ["file:///repo/reports/raven.sql"], content: [],
            },
          ],
        },
      },
    });
    await render();
  }

  test("Outputs holds what the conversation wrote, Context what it only read", async () => {
    await withTouchedSession();

    const text = (name: string) => section(name)?.querySelector(".wf-sec-body")?.textContent ?? "";
    expect(text("outputs")).toContain("raven.sql");
    expect(text("outputs")).not.toContain("plan.md");
    expect(text("context")).toContain("plan.md");
    expect(text("context")).not.toContain("raven.sql");
  });

  test("Outputs names which half of it this conversation actually wrote", async () => {
    // git status runs at the repo root, so the other half is whatever else is
    // dirty — another session, your editor, a reverted branch. Blending the two
    // made every row read as "this conversation produced it".
    await withTouchedSession();

    const groups = [...section("outputs")!.querySelectorAll(".wf-group")].map((g) => g.textContent);
    expect(groups).toEqual(["Written in this conversation", "Other changes in this folder"]);
    const rows = [...section("outputs")!.querySelectorAll("button.wf-row")].map((r) => r.textContent);
    expect(rows[0]).toContain("raven.sql");
    expect(rows.slice(1).join(" ")).toContain("gateway.ts");
  });

  test("a shell-written file outside the checkout reaches Outputs through its folder", async () => {
    // The gap both other sources have at once: `Bash` names no path, so the
    // thread doesn't know it, and /tmp is outside every checkout, so git can't
    // see it. Only the folder listing can — asked for because a tool call DID
    // name a sibling of it.
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    getWorkspaceOutputs.mockResolvedValue([{
      abs: "/tmp/icons",
      files: [{ path: "generated.html", abs: "/tmp/icons/generated.html", size: 120 }],
      truncated: false,
    }]);
    useStore.setState({
      filesOpen: true, cwd: "/repo", activeId: "s1",
      sessions: {
        s1: {
          ...makeSession("s1"), cwd: "/repo",
          items: [{
            id: "t1", kind: "tool", toolCallId: "t1", title: "Write", toolKind: "edit",
            status: "completed", locations: ["/tmp/icons/mockup.html"], content: [],
          }],
        },
      },
    });
    await render();

    // Only the folder of a file the conversation WROTE is asked about.
    expect(getWorkspaceOutputs).toHaveBeenCalledWith("/repo", ["/tmp/icons"]);
    const rows = [...section("outputs")!.querySelectorAll("button.wf-row")].map((r) => r.textContent);
    expect(rows.join(" ")).toContain("generated.html");
    const groups = [...section("outputs")!.querySelectorAll(".wf-group")].map((g) => g.textContent);
    expect(groups).toContain("Also in folders this conversation wrote to");
  });

  test("a failed folder listing leaves the rest of Outputs standing", async () => {
    // A gateway too old to know the route, or a folder deleted since the turn:
    // neither is a reason to replace the git half of the list with an error.
    getWorkspaceOutputs.mockRejectedValue(new Error("no such route"));
    await withTouchedSession();

    const rows = [...section("outputs")!.querySelectorAll("button.wf-row")].map((r) => r.textContent);
    expect(rows.join(" ")).toContain("raven.sql");
    expect(rows.join(" ")).toContain("gateway.ts");
  });

  test("with nothing from the thread, the folder's changes still say where they came from", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    const groups = [...section("outputs")!.querySelectorAll(".wf-group")].map((g) => g.textContent);
    expect(groups).toEqual(["Other changes in this folder"]);
  });

  test("each section header carries its own count", async () => {
    await withTouchedSession();
    const count = (name: string) => section(name)?.querySelector(".wf-sec-count")?.textContent;
    // Outputs is the write plus the two files git reports dirty.
    expect(count("outputs")).toBe("3");
    expect(count("context")).toBe("1");
  });

  test("Outputs merges git's view with the thread's, one row per file", async () => {
    // The same file named by a tool call AND reported dirty by git is one row —
    // and it carries git's status letter and line counts, not just its name.
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      filesOpen: true, cwd: "/repo", activeId: "s1",
      sessions: {
        s1: {
          ...makeSession("s1"), cwd: "/repo",
          items: [{
            id: "t1", kind: "tool", toolCallId: "t1", title: "Edit", toolKind: "edit",
            status: "completed", locations: ["/repo/src/gateway.ts"], content: [],
          }],
        },
      },
    });
    await render();

    const rows = [...section("outputs")!.querySelectorAll("button.wf-row")];
    expect(rows.filter((r) => r.textContent?.includes("gateway.ts"))).toHaveLength(1);
    expect(rows[0].textContent).toContain("+12");
    expect(rows[0].querySelector(".wf-mark")?.className).toContain("wf-git modified");
    expect(rows[0].querySelector(".wf-mark")?.textContent).toBe("M");
  });

  test("a file git knows nothing about keeps its type icon, not a status letter", async () => {
    // Written to /tmp, or written and reverted: git has no letter for it.
    getWorkspaceChanges.mockResolvedValue({ repo: "/repo", files: [], truncated: false });
    await withTouchedSession();
    const mark = section("outputs")!.querySelector(".wf-mark");
    expect(mark?.className).toContain("wf-kind");
    expect(mark?.querySelector("svg")).not.toBeNull();
  });

  test("the agent's plan leads the panel as a Progress section", async () => {
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      filesOpen: true, cwd: "/repo", activeId: "s1",
      sessions: {
        s1: {
          ...makeSession("s1"), cwd: "/repo",
          items: [
            { id: "p1", kind: "plan", entries: [{ content: "stale", status: "pending" }] },
            // ACP resends the whole plan on every change; the last one wins.
            { id: "p2", kind: "plan", entries: [
              { content: "Gather the tickets", status: "completed" },
              { content: "Draft the deck", status: "in_progress" },
            ] },
          ],
        },
      },
    });
    await render();

    const sections = [...container.querySelectorAll(".wf-sec-head")].map((h) => h.getAttribute("data-section"));
    expect(sections).toEqual(["progress", "outputs", "context"]);
    const progress = section("progress")?.textContent ?? "";
    expect(progress).toContain("Gather the tickets");
    expect(progress).toContain("Draft the deck");
    expect(progress).not.toContain("stale");
  });

  const switchTo = async (label: string) => {
    const btn = [...container.querySelectorAll<HTMLButtonElement>(".wf-switch button")]
      .find((b) => b.textContent === label);
    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
  };

  test("opens on Session, and asks for no tree until Project is chosen", async () => {
    // Session's lists are built from state the panel already holds; the tree is
    // a request per level, so the default mode must cost none of them.
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    expect(container.querySelector(".wf-switch button.active")?.textContent).toBe("Session");
    expect(getWorkspaceTree).not.toHaveBeenCalled();

    await switchTo("Project");
    // No path: the tree's root is the conversation's own folder.
    expect(getWorkspaceTree).toHaveBeenCalledWith("/repo", undefined);
    // Project is the whole panel — the conversation's lists are gone, not
    // pushed below a tree.
    expect(section("outputs")).toBeUndefined();
    expect(container.textContent).toContain("src");

    await switchTo("Session");
    expect(section("outputs")).toBeDefined();
  });

  test("Back from a file opened in Project returns to Project, not to the lists", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    await switchTo("Project");

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/repo/src/app.ts", path: "src/app.ts", mode: "file" });
    });
    await act(async () => { await flush(); });
    // The viewer takes over, and the switch goes with it — Back is the one way out.
    expect(container.querySelector(".wf-switch")).toBeNull();

    await act(async () => { useStore.getState().clearFilePreview(); });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-switch button.active")?.textContent).toBe("Project");
    expect(section("outputs")).toBeUndefined();
  });

  test("given room, a file opens BESIDE the list rather than over it", async () => {
    // The reason the split exists: reading a second file must not cost a Back
    // and a hunt down the list for where you were.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("innerWidth", 1600);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    const panel = container.querySelector<HTMLElement>("#files")!;
    const listWidth = parseInt(panel.style.width, 10);

    const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button.wf-row")];
    await act(async () => { rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    expect(container.querySelector(".wf-panes.split")).not.toBeNull();
    // The panel extended by the list's width — the list did not give up its own.
    expect(parseInt(panel.style.width, 10)).toBe(listWidth + 300);
    // The list keeps its rows, and the mode switch stays reachable above both.
    expect(container.querySelector(".wf-list")).not.toBeNull();
    expect(container.querySelector(".wf-switch")).not.toBeNull();
    expect(container.querySelector(".wf-view")).not.toBeNull();
    // Nothing to go Back to while the list is right there.
    expect([...container.querySelectorAll("button")].some((b) => b.title === "Back to file list")).toBe(false);
    expect(rows()[0].classList.contains("on")).toBe(true);

    // The next file is one click away, from the same list.
    await act(async () => { rows()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(getFileDiff).toHaveBeenLastCalledWith("/repo", "/repo/docs/shot.png");
    expect(rows()[1].classList.contains("on")).toBe(true);
    expect(rows()[0].classList.contains("on")).toBe(false);

    // The list folds away when one diff wants the whole panel, and comes back.
    const fold = [...container.querySelectorAll<HTMLButtonElement>(".wf-head .icon-btn")]
      .find((b) => b.title === "Hide the file list")!;
    await act(async () => { fold.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-panes.split.folded")).not.toBeNull();
    // Still mounted, so it keeps its scroll and its open folders.
    expect(container.querySelector(".wf-list")).not.toBeNull();
    // The mode switch goes with it: folded means the file gets the room.
    expect(container.querySelector(".wf-switch")).toBeNull();
    // The panel keeps its extended width — folding is for the diff, not against it.
    expect(parseInt(panel.style.width, 10)).toBe(listWidth + 300);
    const unfold = [...container.querySelectorAll<HTMLButtonElement>(".wf-head .icon-btn")]
      .find((b) => b.title === "Show the file list")!;
    await act(async () => { unfold.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-panes.folded")).toBeNull();

    // And the viewer closes from its own header, since Back is gone with it.
    const close = [...container.querySelectorAll<HTMLButtonElement>(".wf-view-head .icon-btn")][0];
    await act(async () => { close.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-view")).toBeNull();
    expect(parseInt(panel.style.width, 10)).toBe(listWidth);
    vi.unstubAllGlobals();
  });

  test("a column with no room for two panes keeps the takeover", async () => {
    // 1024px leaves the panel 564 at most (the chat keeps 460), and a 264px
    // viewer beside a 300px list is two unreadable columns.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button.wf-row")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-panes.split")).toBeNull();
    expect(container.querySelector(".wf-switch")).toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.title === "Back to file list")).toBe(true);
    vi.unstubAllGlobals();
  });

  test("a Review file opens beside its list too, and gives the width back", async () => {
    // Review draws its own viewer — the diff with comments written on it — so
    // it reports the open file up rather than going through filePreview. The
    // panel must widen for it all the same.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("innerWidth", 1600);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    const panel = container.querySelector<HTMLElement>("#files")!;
    const listWidth = parseInt(panel.style.width, 10);
    await switchTo("Review");

    const row = [...container.querySelectorAll<HTMLButtonElement>("button.wf-row")]
      .find((b) => b.textContent?.includes("gateway.ts"))!;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    expect(container.querySelector(".wf-panes.split")).not.toBeNull();
    expect(parseInt(panel.style.width, 10)).toBe(listWidth + 300);
    // The scope chips are still there — the list did not go anywhere.
    expect(container.querySelector(".wf-list .rv-scope")).not.toBeNull();
    expect(container.querySelector(".wf-view .rv-bar")?.textContent).toContain("src/gateway.ts");
    expect(row.classList.contains("on")).toBe(true);

    // Closing it hands the width back.
    const back = container.querySelector<HTMLButtonElement>(".wf-view .rv-bar .icon-btn")!;
    await act(async () => { back.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-view")).toBeNull();
    expect(parseInt(panel.style.width, 10)).toBe(listWidth);
  });

  test("with no room, a Review file still takes over — and the switch stays", async () => {
    // jsdom reports no matchMedia, so this is the sheet: one pane. The mode
    // switch is not the way out of a review file (FileReview's own Back is),
    // but it must not vanish either — it is how you leave Review at all.
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    await switchTo("Review");

    const row = [...container.querySelectorAll<HTMLButtonElement>("button.wf-row")]
      .find((b) => b.textContent?.includes("gateway.ts"))!;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    expect(container.querySelector(".wf-panes.split")).toBeNull();
    expect(container.querySelector(".rv-bar")?.textContent).toContain("src/gateway.ts");
    expect(container.querySelector(".rv-scope")).toBeNull();
    expect(container.querySelector(".wf-switch")).not.toBeNull();
  });

  test("Project browses another folder without moving the conversation", async () => {
    getWorkspaceTree.mockResolvedValue({
      abs: "/repo/other", path: "", truncated: false,
      entries: [{ name: "app.ts", abs: "/repo/other/app.ts", dir: false }],
    });
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    await switchTo("Project");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".wf-root-pick")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await flush(); });
    const dir = [...container.querySelectorAll<HTMLButtonElement>("#fb .bp.top button.dir")][0];
    await act(async () => { dir.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    const use = [...container.querySelectorAll<HTMLButtonElement>("#fb button")]
      .find((b) => b.textContent === "Use this folder")!;
    await act(async () => { use.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });

    expect(getWorkspaceTree).toHaveBeenLastCalledWith("/repo/other", undefined);
    // The conversation stays where it was: this reads a folder, it doesn't move in.
    expect(useStore.getState().cwd).toBe("/repo");

    // A file over there is read with ITS root as the cwd, or the gateway refuses it.
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button.wf-tree-row")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await flush(); });
    expect(getFilePreview).toHaveBeenLastCalledWith("/repo/other", "/repo/other/app.ts");

    // And one tap home again.
    await act(async () => { useStore.getState().clearFilePreview(); });
    await act(async () => { await flush(); });
    const home = [...container.querySelectorAll<HTMLButtonElement>(".wf-root button")]
      .find((b) => b.textContent?.includes("Back to"))!;
    await act(async () => { home.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(getWorkspaceTree).toHaveBeenLastCalledWith("/repo", undefined);
  });

  test("a different folder is a different project, so the panel returns to Session", async () => {
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    await switchTo("Project");

    await act(async () => {
      useStore.setState({ activeId: "s2", sessions: { s2: { ...makeSession("s2"), cwd: "/other" } } });
    });
    await act(async () => { await flush(); });
    expect(container.querySelector(".wf-switch button.active")?.textContent).toBe("Session");
  });

  test("no plan, no Progress section", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    expect(section("progress")).toBeUndefined();
  });

  test("an output row opens on its diff", async () => {
    await withTouchedSession();
    const row = container.querySelector<HTMLButtonElement>("button.wf-row");
    await act(async () => { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(getFileDiff).toHaveBeenCalledWith("/repo", "/repo/reports/raven.sql");
  });

  test("an empty Outputs list is only empty when git agrees", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: "/repo", files: [], truncated: false });
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    expect(container.textContent).toContain("Nothing written in this conversation yet");
  });

  test("a file the agent wrote outside the project is still listed and clickable", async () => {
    // Whether the gateway will serve it is the gateway's call (cwd, its repo,
    // and ACPG_PREVIEW_ROOTS); the panel's job is to show the row and ask.
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      filesOpen: true,
      cwd: "/repo",
      activeId: "s1",
      sessions: {
        s1: {
          ...makeSession("s1"), cwd: "/repo",
          items: [{
            id: "t1", kind: "tool", toolCallId: "t1", title: "Write", toolKind: "edit",
            status: "completed", locations: ["/tmp/shot.png"], content: [],
          }],
        },
      },
    });
    await render();

    const row = container.querySelector<HTMLButtonElement>("button.wf-row");
    expect(row?.textContent).toContain("shot.png");
    await act(async () => { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
    expect(getFileDiff).toHaveBeenCalledWith("/repo", "/tmp/shot.png");
  });

  test("a refused file explains itself instead of printing the server's JSON", async () => {
    getFileDiff.mockRejectedValue(new Error("This file is outside the conversation's project, so the gateway won't read it. Add its folder to ACPG_PREVIEW_ROOTS to allow it."));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    await act(async () => {
      useStore.getState().openFilePreview({ abs: "/tmp/shot.png", path: "shot.png" });
    });
    await act(async () => { await flush(); });

    expect(container.querySelector(".wf-empty")?.textContent).toContain("ACPG_PREVIEW_ROOTS");
    expect(container.textContent).not.toContain('{"error"');
  });

  test("the panel is draggable to a new width, and remembers it", async () => {
    // jsdom reports 1024px, below the 1100px column breakpoint, so the handle
    // must be there only when the panel is actually a column.
    const desktop = vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
    vi.stubGlobal("matchMedia", desktop);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    const panel = container.querySelector<HTMLElement>("#files");
    const handle = container.querySelector<HTMLElement>(".wf-resize");
    expect(handle).not.toBeNull();
    const before = panel!.style.width;

    // Drag the left edge 100px left — the panel is right-anchored, so that
    // makes it wider.
    await act(async () => {
      handle!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 700 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 600 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent("pointerup", {}) as PointerEvent);
    });

    expect(panel!.style.width).not.toBe(before);
    expect(parseInt(panel!.style.width, 10)).toBe(parseInt(before, 10) + 100);
    // Committed on release, so the next visit opens at the chosen width.
    expect(localStorage.getItem("acpg.filePanelWidth")).toBe(String(parseInt(panel!.style.width, 10)));
    // The drag must not leave the whole page unselectable.
    expect(document.body.classList.contains("resizing")).toBe(false);
    vi.unstubAllGlobals();
  });

  test("Expand hands the panel the whole window, and hands it back", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    const panel = container.querySelector<HTMLElement>("#files")!;
    const expand = [...container.querySelectorAll<HTMLButtonElement>(".wf-head .icon-btn")]
      .find((b) => b.title === "Expand")!;
    await act(async () => { expand.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(panel.classList.contains("expanded")).toBe(true);
    // The inline width would beat the stylesheet's full-window rule.
    expect(panel.style.width).toBe("");
    expect(container.querySelector(".wf-resize")).toBeNull();

    await act(async () => { expand.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(panel.classList.contains("expanded")).toBe(false);
    expect(panel.style.width).not.toBe("");
    expect(container.querySelector(".wf-resize")).not.toBeNull();
    vi.unstubAllGlobals();
  });

  test("below the column breakpoint there is nothing to drag", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();

    expect(container.querySelector(".wf-resize")).toBeNull();
    // No inline width either — the sheet's layout is the stylesheet's to own.
    expect(container.querySelector<HTMLElement>("#files")!.style.width).toBe("");
    vi.unstubAllGlobals();
  });

  test("says a non-repo folder has nothing to compare rather than showing an error", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: null, files: [], truncated: false, reason: "not-a-repo" });
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    expect(container.textContent).toContain("only files this conversation named");
  });

  test("refreshes when a turn finishes — the moment the list is most likely stale", async () => {
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      filesOpen: true,
      cwd: "/repo",
      activeId: "s1",
      sessions: { s1: { ...makeSession("s1"), cwd: "/repo", working: true } },
    });
    await render();
    expect(getWorkspaceChanges).toHaveBeenCalledTimes(1);

    await act(async () => {
      const st = useStore.getState();
      useStore.setState({ sessions: { s1: { ...st.sessions.s1, working: false } } });
    });
    await act(async () => { await flush(); });
    expect(getWorkspaceChanges).toHaveBeenCalledTimes(2);
  });

  // ---- attaching to the chat ----

  test("a row's menu attaches the file the menu was opened on", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      filesOpen: true, cwd: "/repo", attachedFiles: [],
      promptCapabilities: { embeddedContext: true },
    });
    await render();

    const row = [...container.querySelectorAll<HTMLElement>("button.wf-row")]
      .find((r) => r.querySelector(".wf-nm")?.textContent === "gateway.ts")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(document.querySelector(".wf-menu-head .nm")?.textContent).toBe("gateway.ts");

    const add = [...document.querySelectorAll<HTMLElement>(".wf-menu-row")]
      .find((b) => b.textContent === "Add to chat")!;
    await act(async () => { add.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // Labelled as it reads from the conversation's folder; addressed absolutely.
    expect(useStore.getState().attachedFiles).toEqual([
      { name: "src/gateway.ts", uri: "file:///repo/src/gateway.ts" },
    ]);
    expect(document.querySelector(".wf-menu")).toBeNull();
  });

  test("no menu entry to attach when the agent takes no file references", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo", promptCapabilities: {} });
    await render();

    const row = container.querySelector<HTMLElement>("button.wf-row")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect([...document.querySelectorAll(".wf-menu-row")].map((b) => b.textContent))
      .toEqual(["Open", "Copy path"]);
  });

  test("selected lines attach as a range, with the lines themselves", async () => {
    const { useStore } = await import("../store/store.ts");
    getFilePreview.mockResolvedValue({
      path: "notes.txt", abs: "/repo/notes.txt", kind: "text",
      size: 40, modifiedAt: new Date().toISOString(),
      text: "alpha\nbravo\ncharlie\ndelta", truncated: false,
    } satisfies FilePreviewResult);
    useStore.setState({
      filesOpen: true, cwd: "/repo", attachedFiles: [],
      promptCapabilities: { embeddedContext: true },
      filePreview: { abs: "/repo/notes.txt", path: "notes.txt", mode: "file" },
    });
    await render();

    const add = () => container.querySelector<HTMLButtonElement>("button.wf-add")!;
    // Offered before anything is selected — an action that only appears once you
    // have already done the thing that enables it is an action nobody finds.
    expect(add().disabled).toBe(true);

    // "vo\nchar" — part of line 2 through part of line 3.
    const code = container.querySelector("pre.wf-text code")!;
    await act(async () => {
      const range = document.createRange();
      range.setStart(code.firstChild!, 9);
      range.setEnd(code.firstChild!, 16);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    // Snapped out to whole lines: half a line is not what "add these lines"
    // means, and the range has to be one you can look up in the file.
    expect(add().disabled).toBe(false);
    expect(add().textContent).toContain("2-3");

    // Pressing a button is itself what collapses a selection on most platforms.
    // If that disarmed the button, it would go disabled in the instant between
    // the press and the click — so a collapse leaves the armed range alone.
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(add().disabled).toBe(false);
    expect(add().textContent).toContain("2-3");

    await act(async () => { add().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(useStore.getState().attachedFiles).toEqual([{
      name: "notes.txt",
      range: "2-3",
      uri: "file:///repo/notes.txt#L2-L3",
      text: "bravo\ncharlie",
    }]);
  });

  test("attaching from a phone gets the panel out of the way of the chip", async () => {
    // Below the desktop breakpoint this panel is a sheet ON TOP of the composer,
    // so the chip it just added would be behind it. (jsdom reports no matchMedia,
    // which is the non-desktop branch.)
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      filesOpen: true, cwd: "/repo", attachedFiles: [],
      promptCapabilities: { embeddedContext: true },
    });
    await render();

    const row = container.querySelector<HTMLElement>("button.wf-row")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    const add = [...document.querySelectorAll<HTMLElement>(".wf-menu-row")]
      .find((b) => b.textContent === "Add to chat")!;
    await act(async () => { add.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(useStore.getState().attachedFiles).toHaveLength(1);
    expect(useStore.getState().filesOpen).toBe(false);
  });
});
