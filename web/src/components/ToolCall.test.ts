import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ThreadItem } from "../types.ts";

type Tool = Extract<ThreadItem, { kind: "tool" }>;

const tool = (over: Partial<Tool> = {}): Tool => ({
  id: "i1", kind: "tool", toolCallId: "t1", title: "Edit file",
  toolKind: "edit", status: "completed", locations: [], content: [], ...over,
});

describe("ToolCall file links", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

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
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
  });

  async function render(item: Tool) {
    const { ToolCall } = await import("./ToolCall.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(ToolCall, { item }));
    });
  }

  test("a file the agent wrote becomes a card, naming what it is", async () => {
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    useStore.setState({ openFilePreview });
    await render(tool({ toolKind: "edit", locations: ["file:///repo/reports/raven.sql"] }));

    const card = container.querySelector<HTMLButtonElement>("button.fcard-main");
    expect(card?.querySelector(".fcard-name")?.textContent).toBe("raven.sql");
    expect(card?.querySelector(".fcard-kind")?.textContent).toBe("Code · SQL");
    await act(async () => { card?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({
      abs: "/repo/reports/raven.sql", path: "raven.sql", mode: "diff",
    });
  });

  test("a card saves through the blob helper, never a link at the raw route", async () => {
    // Same constraint as the panel's Download: an <a href download> is a
    // top-level navigation, which the native client's WKWebView answers by
    // tearing the console down.
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../lib/download.ts", () => ({ downloadFile }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ cwd: "/repo" });
    await render(tool({ toolKind: "edit", locations: ["/repo/reports/raven.sql"] }));

    expect(container.querySelector("a[download]")).toBeNull();
    const dl = container.querySelector<HTMLButtonElement>("button.fcard-dl");
    await act(async () => { dl?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(downloadFile).toHaveBeenCalledWith(
      expect.stringContaining("/workspace/raw?cwd=%2Frepo&path=%2Frepo%2Freports%2Fraven.sql"),
      "raven.sql",
    );
    vi.doUnmock("../lib/download.ts");
  });

  test("a file the agent only read stays a path row, not a card", async () => {
    // Twenty reads in a turn must not bury the one file it wrote.
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    useStore.setState({ openFilePreview });
    await render(tool({ toolKind: "read", locations: ["file:///repo/src/a.ts"] }));

    expect(container.querySelector(".fcard")).toBeNull();
    const link = container.querySelector<HTMLButtonElement>("button.loc.openable");
    expect(link?.textContent).toBe("file:///repo/src/a.ts");
    await act(async () => { link?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({ abs: "/repo/src/a.ts" });
  });

  test("an inline diff is headed by its file's card, not a second path row", async () => {
    await render(tool({ content: [{ type: "diff", path: "/repo/src/b.ts", oldText: "a", newText: "b" }] }));

    expect(container.querySelector(".fcard-name")?.textContent).toBe("b.ts");
    // The card names the file; a path header under it would say it twice.
    expect(container.querySelector("button.path.openable")).toBeNull();
    expect(container.querySelector(".diff .path")).toBeNull();
    expect(container.querySelector(".diff .ln.add")?.textContent).toBe("b");
  });

  test("an edit reports the same file as a location AND a diff — it appears once", async () => {
    // claude-agent-acp's Edit/Write send both for every call, so this is the
    // shape of every real edit, not an edge case.
    await render(tool({
      toolKind: "edit",
      locations: ["/repo/src/b.ts"],
      content: [{ type: "diff", path: "/repo/src/b.ts", oldText: "a", newText: "b" }],
    }));

    expect(container.querySelectorAll(".fcard")).toHaveLength(1);
    expect(container.querySelector(".loc")).toBeNull();
  });

  test("a diff block earns a card even when the tool kind doesn't say `edit`", async () => {
    // Matches the panel's Outputs rule: showing a before/after IS the write.
    await render(tool({ toolKind: "other", content: [{ type: "diff", path: "/repo/src/b.ts", oldText: "a", newText: "b" }] }));
    expect(container.querySelector(".fcard-name")?.textContent).toBe("b.ts");
  });

  test("a diff for a remote path keeps its plain linkless header", async () => {
    await render(tool({ content: [{ type: "diff", path: "https://example.com/b.ts", oldText: "a", newText: "b" }] }));
    expect(container.querySelector(".fcard")).toBeNull();
    expect(container.querySelector(".diff .path")?.textContent).toBe("https://example.com/b.ts");
  });

  test("a finished call is a closed one-line record; a running or failed one is open", async () => {
    const out = [{ type: "content" as const, content: { type: "text" as const, text: "lots of output" } }];

    await render(tool({ status: "completed", content: out }));
    expect(container.querySelector("details.tool")?.hasAttribute("open")).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    await render(tool({ status: "in_progress", content: out }));
    expect(container.querySelector("details.tool")?.hasAttribute("open")).toBe(true);

    await act(async () => root?.unmount());
    root = null;
    await render(tool({ status: "failed", content: out }));
    expect(container.querySelector("details.tool")?.hasAttribute("open")).toBe(true);
  });

  test("a card you opened by hand stays open once the call completes", async () => {
    const out = [{ type: "content" as const, content: { type: "text" as const, text: "output" } }];
    const { ToolCall } = await import("./ToolCall.tsx");

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(ToolCall, { item: tool({ status: "completed", content: out }) }));
    });
    const details = container.querySelector("details.tool") as HTMLDetailsElement;
    expect(details.hasAttribute("open")).toBe(false);

    // Open it the way a tap does: <details> flips itself, then fires toggle.
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(container.querySelector("details.tool")?.hasAttribute("open")).toBe(true);

    // The same call re-rendered (status churn, streamed output) must not shut it.
    await act(async () => {
      root?.render(React.createElement(ToolCall, { item: tool({ status: "completed", content: out }) }));
    });
    expect(container.querySelector("details.tool")?.hasAttribute("open")).toBe(true);
  });

  test("a remote URI stays plain text — there is no local file to open", async () => {
    await render(tool({ locations: ["https://example.com/a.ts"] }));
    expect(container.querySelector(".fcard")).toBeNull();
    expect(container.querySelector("button.openable")).toBeNull();
    expect(container.querySelector(".loc")?.textContent).toBe("https://example.com/a.ts");
  });
});
