import { describe, test, expect, beforeEach, vi } from "vitest";

describe("review workspace state", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp",
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
  });

  test("Review takes the sidebar's column and leaving gives it back", async () => {
    const { useStore } = await import("./store.ts");

    useStore.setState({ sidebarOpen: true });
    useStore.getState().setWorkspace("review");
    expect(useStore.getState().sidebarOpen).toBe(false);

    // Re-entering must not remember the false it set itself.
    useStore.getState().setWorkspace("review");
    useStore.getState().setWorkspace("agent");
    expect(useStore.getState().sidebarOpen).toBe(true);

    // And a sidebar that was already shut stays shut on the way back.
    useStore.getState().setWorkspace("review");
    useStore.getState().setWorkspace("agent");
    expect(useStore.getState().sidebarOpen).toBe(true);
  });

  test("a file opened in Review lands on the canvas, not in the file panel", async () => {
    const { useStore } = await import("./store.ts");

    useStore.getState().openFilePreview({ abs: "/repo/src/a.ts", path: "src/a.ts", mode: "file" });
    expect(useStore.getState().filePreview?.path).toBe("src/a.ts");
    expect(useStore.getState().filesOpen).toBe(true);
    expect(useStore.getState().reviewPreview).toBeNull();

    useStore.setState({ filesOpen: false });
    useStore.getState().setWorkspace("review");
    useStore.getState().openFilePreview({
      abs: "/repo/src/b.ts", path: "src/b.ts", mode: "diff", spec: { commit: "abc123" },
    });

    expect(useStore.getState().reviewPreview).toMatchObject({ path: "src/b.ts", spec: { commit: "abc123" } });
    // The Agent workspace's own reading position is untouched, panel included.
    expect(useStore.getState().filePreview?.path).toBe("src/a.ts");
    expect(useStore.getState().filesOpen).toBe(false);
  });

  test("Back and Forward walk the canvas's own history", async () => {
    const { useStore } = await import("./store.ts");
    const a = { abs: "/repo/a.ts", path: "a.ts", mode: "diff" as const, scrollTop: 120 };
    const b = { abs: "/repo/b.ts", path: "b.ts", mode: "diff" as const };

    useStore.getState().pushReviewHistory(a);
    useStore.setState({ reviewPreview: b });
    useStore.getState().reviewBack(b);
    expect(useStore.getState().reviewPreview).toEqual(a);
    expect(useStore.getState().reviewHistory).toEqual({ past: [], future: [b] });

    useStore.getState().reviewForward(a);
    expect(useStore.getState().reviewPreview).toEqual(b);
    expect(useStore.getState().reviewHistory).toEqual({ past: [a], future: [] });

    // A fresh navigation is a new branch: what Forward led to is gone.
    useStore.getState().reviewBack(b);
    useStore.getState().pushReviewHistory(a);
    expect(useStore.getState().reviewHistory.future).toEqual([]);

    // Both ends are no-ops when the stack they read is empty.
    useStore.setState({ reviewHistory: { past: [], future: [] }, reviewPreview: a });
    useStore.getState().reviewBack(a);
    useStore.getState().reviewForward(a);
    expect(useStore.getState().reviewPreview).toEqual(a);
  });

  test("retracing reveals the canvas the sheet was covering", async () => {
    const { useStore } = await import("./store.ts");
    const a = { abs: "/repo/a.ts", path: "a.ts", mode: "diff" as const };
    const b = { abs: "/repo/b.ts", path: "b.ts", mode: "diff" as const };

    useStore.setState({ reviewPreview: b, reviewHistory: { past: [a], future: [] }, reviewSheet: "files" });
    useStore.getState().reviewBack(b);
    expect(useStore.getState().reviewSheet).toBe("none");

    useStore.setState({ reviewSheet: "companion" });
    useStore.getState().reviewForward(b);
    expect(useStore.getState().reviewSheet).toBe("none");
  });

  test("changing folder clears the canvas and its history", async () => {
    const { useStore } = await import("./store.ts");
    const a = { abs: "/repo/a.ts", path: "a.ts", mode: "diff" as const };

    useStore.setState({ reviewPreview: a, reviewHistory: { past: [a], future: [a] } });
    useStore.setState({ cwd: "/other" });

    expect(useStore.getState().reviewPreview).toBeNull();
    expect(useStore.getState().reviewHistory).toEqual({ past: [], future: [] });
  });

  test("each workspace keeps its own reading position across a switch", async () => {
    const { useStore } = await import("./store.ts");

    useStore.getState().setWorkspace("review");
    useStore.getState().openFilePreview({ abs: "/repo/src/b.ts", path: "src/b.ts", mode: "diff" });

    useStore.getState().setWorkspace("agent");
    useStore.getState().openFilePreview({ abs: "/repo/src/a.ts", path: "src/a.ts", mode: "file" });

    useStore.getState().setWorkspace("review");
    // An Agent preview opened while away must not have taken the canvas with it.
    expect(useStore.getState().reviewPreview?.path).toBe("src/b.ts");
    expect(useStore.getState().filePreview?.path).toBe("src/a.ts");
  });

  test("a file opened in Review closes the sheet covering the canvas", async () => {
    const { useStore } = await import("./store.ts");

    useStore.getState().setWorkspace("review");
    useStore.getState().toggleReviewSheet("files");
    useStore.getState().openFilePreview({ abs: "/repo/src/b.ts", path: "src/b.ts", mode: "diff" });

    expect(useStore.getState().reviewSheet).toBe("none");
  });

  test("only one side sheet overlays the canvas at a time", async () => {
    const { useStore } = await import("./store.ts");

    useStore.getState().toggleReviewSheet("files");
    expect(useStore.getState().reviewSheet).toBe("files");
    useStore.getState().toggleReviewSheet("companion");
    expect(useStore.getState().reviewSheet).toBe("companion");
    useStore.getState().toggleReviewSheet("companion");
    expect(useStore.getState().reviewSheet).toBe("none");
  });
});
