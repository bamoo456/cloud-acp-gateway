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

  test("a reported path opens the preview panel on that file", async () => {
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    useStore.setState({ openFilePreview });
    await render(tool({ locations: ["file:///repo/src/a.ts"] }));

    const link = container.querySelector<HTMLButtonElement>("button.loc.openable");
    expect(link?.textContent).toBe("file:///repo/src/a.ts");
    await act(async () => { link?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({ abs: "/repo/src/a.ts" });
  });

  test("an inline diff's path header is a link to the whole file", async () => {
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    useStore.setState({ openFilePreview });
    await render(tool({ content: [{ type: "diff", path: "/repo/src/b.ts", oldText: "a", newText: "b" }] }));

    const link = container.querySelector<HTMLButtonElement>("button.path.openable");
    expect(link?.textContent).toBe("/repo/src/b.ts");
    await act(async () => { link?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({ abs: "/repo/src/b.ts" });
  });

  test("a remote URI stays plain text — there is no local file to open", async () => {
    await render(tool({ locations: ["https://example.com/a.ts"] }));
    expect(container.querySelector("button.openable")).toBeNull();
    expect(container.querySelector(".loc")?.textContent).toBe("https://example.com/a.ts");
  });
});
