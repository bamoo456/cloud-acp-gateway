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
    vi.doMock("../lib/api.ts", () => ({
      getWorkspaceChanges,
      getFileDiff,
      getFilePreview,
      rawFileUrl: (cwd: string, p: string) => `/workspace/raw?cwd=${cwd}&path=${p}`,
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.doUnmock("../lib/api.ts");
  });

  async function render() {
    const { FilePanel } = await import("./FilePanel.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(FilePanel));
    });
    await act(async () => { await flush(); });
  }

  test("stays shut and asks the gateway for nothing until it is opened", async () => {
    await render();
    expect(getWorkspaceChanges).not.toHaveBeenCalled();
    expect(container.querySelector("#files")?.className).not.toContain("open");
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
  });

  test("the Session tab lists files the conversation touched", async () => {
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
          items: [{
            id: "t1", kind: "tool", toolCallId: "t1", title: "Read", toolKind: "read",
            status: "completed", locations: ["file:///repo/notes/plan.md"], content: [],
          }],
        },
      },
    });
    await render();

    const tab = [...container.querySelectorAll<HTMLButtonElement>("button.wf-tab")]
      .find((b) => b.dataset.tab === "session");
    await act(async () => { tab?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(container.querySelector(".wf-body")?.textContent).toContain("plan.md");
  });

  test("says a non-repo folder has nothing to compare rather than showing an error", async () => {
    getWorkspaceChanges.mockResolvedValue({ repo: null, files: [], truncated: false, reason: "not-a-repo" });
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ filesOpen: true, cwd: "/repo" });
    await render();
    expect(container.textContent).toContain("isn't a git repository");
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
});
