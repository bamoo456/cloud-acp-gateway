import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";

// The composer input is a CodeMirror editor; reach its view to simulate edits.
function cmView(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
  if (!view) throw new Error("no CodeMirror editor mounted");
  return view;
}

// Replace the whole document with `value` and leave the caret/selection at
// [start, end] (collapsed at the end by default) — the editor equivalent of
// typing then placing the caret.
function cmSet(view: EditorView, value: string, start = value.length, end = start) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: start, head: end } });
}

// Dispatch a keydown on the editor's content so its keymap runs (Enter, Mod-b…).
function cmKey(view: EditorView, key: string, opts: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
}

describe("Composer session busy state", () => {
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
    vi.unstubAllGlobals();
  });

  test("does not show stop state for another session's in-flight prompt", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");

    useStore.setState({
      agentReady: true,
      busy: true,
      busySessionIds: { "first-session": true },
      activeId: "second-session",
      sessions: {
        "first-session": { ...makeSession("first-session"), working: true },
        "second-session": { ...makeSession("second-session"), working: false },
      },
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const send = container.querySelector<HTMLButtonElement>("button.send");
    expect(send).not.toBeNull();
    expect(send).not.toHaveClass("stop");
    expect(send).toBeDisabled();
  });

  test("hides the attach-image button when the agent can't accept images", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: {} } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Attach image"]')).toBeNull();
  });

  test("shows the attach-image button when the agent reports image support", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: { image: true } } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Attach image"]')).not.toBeNull();
  });

  test("hides the @ file button when the agent can't take embedded context", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: {} } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Reference a file"]')).toBeNull();
  });

  test("shows the @ file button when the agent reports embeddedContext", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: { embeddedContext: true } } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Reference a file"]')).not.toBeNull();
  });

  test("the slash button opens the command menu listing every command", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({
      agentReady: true,
      commands: [
        { name: "init", description: "Initialize" },
        { name: "review", description: "Review a PR" },
      ],
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector(".cmds.open")).toBeNull();

    const slash = container.querySelector<HTMLButtonElement>('button[title="Slash commands"]')!;
    await act(async () => { slash.click(); });

    const menu = container.querySelector(".cmds.open");
    expect(menu).not.toBeNull();
    const names = Array.from(menu!.querySelectorAll(".cn")).map((e) => e.textContent);
    expect(names).toEqual(["/init", "/review"]);
  });

  test("typing a /query filters the command menu", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({
      agentReady: true,
      commands: [
        { name: "init", description: "Initialize" },
        { name: "review", description: "Review a PR" },
        { name: "security-review", description: "Security review" },
      ],
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    // Simulate typing "/rev" with the caret at the end.
    await act(async () => { cmSet(cmView(container), "/rev"); });

    const menu = container.querySelector(".cmds.open");
    expect(menu).not.toBeNull();
    const names = Array.from(menu!.querySelectorAll(".cn")).map((e) => e.textContent);
    // "review" (prefix) ranks before "security-review" (substring); "init" drops out.
    expect(names).toEqual(["/review", "/security-review"]);
  });

  test("renders Codex skills with their $ prefix, not a slash", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({
      agentReady: true,
      commands: [
        { name: "skills", description: "List available skills." },
        { name: "$deep-research", description: "Run deep research." },
      ],
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const slash = container.querySelector<HTMLButtonElement>('button[title="Slash commands"]')!;
    await act(async () => { slash.click(); });

    const menu = container.querySelector(".cmds.open")!;
    const names = Array.from(menu.querySelectorAll(".cn")).map((e) => e.textContent);
    // the builtin stays "/skills"; the skill keeps its own "$" prefix (not "/$…")
    expect(names).toEqual(["/skills", "$deep-research"]);
  });

  test("typing a $query filters down to matching Codex skills", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({
      agentReady: true,
      commands: [
        { name: "status", description: "Session status." },
        { name: "$deep-research", description: "Run deep research." },
        { name: "$review", description: "Review a change." },
      ],
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    await act(async () => { cmSet(cmView(container), "$rev"); });

    const menu = container.querySelector(".cmds.open");
    expect(menu).not.toBeNull();
    const names = Array.from(menu!.querySelectorAll(".cn")).map((e) => e.textContent);
    expect(names).toEqual(["$review"]);
  });

  test("Cmd/Ctrl+B wraps the selection in bold markers", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentReady: true } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const view = cmView(container);
    await act(async () => { cmSet(view, "make me bold", 8, 12); }); // select "bold"
    // CodeMirror maps "Mod" to Ctrl off macOS (which is how jsdom reports here).
    await act(async () => { cmKey(view, "b", { ctrlKey: true }); });

    expect(view.state.doc.toString()).toBe("make me **bold**");
  });

  test("Shift+Enter continues a markdown list with the next bullet", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentReady: true } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const view = cmView(container);
    await act(async () => { cmSet(view, "- first"); }); // caret at end
    await act(async () => { cmKey(view, "Enter", { shiftKey: true }); });

    expect(view.state.doc.toString()).toBe("- first\n- ");
  });

  test("uses a Codex placeholder for a Codex-skinned agent, hiding its configOptions", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");
    const s0 = useStore.getState();

    useStore.setState({
      agentReady: true,
      agentName: "codex",
      cfg: { ...s0.cfg, agents: [{ name: "codex", cwd: "", skin: "codex" }] },
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5.5",
          options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          category: "reasoning",
          currentValue: "xhigh",
          options: [{ value: "xhigh", name: "Xhigh" }],
        },
        {
          id: "approval_policy",
          name: "Approval Preset",
          type: "select",
          category: "approval",
          currentValue: "auto",
          options: [{ value: "auto", name: "Auto" }],
        },
      ],
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector(".cm-placeholder")?.textContent).toBe("Reply to Codex…");
    expect(container.textContent).not.toContain("GPT-5.5");
    expect(container.textContent).not.toContain("Model");
    expect(container.textContent).not.toContain("Xhigh");
    expect(container.textContent).not.toContain("Reasoning Effort");
    expect(container.textContent).not.toContain("Auto");
    expect(container.textContent).not.toContain("Approval Preset");
  });
});
