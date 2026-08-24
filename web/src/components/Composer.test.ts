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

// Composer's props are all optional (bound mode opts in with `sessionId`), and
// createElement's overload inference can't derive P from an all-optional,
// defaulted props parameter — it silently falls back to bare `Attributes` and
// rejects `sessionId` as unknown. Spelling the shape out here as an explicit
// type argument sidesteps that without giving up prop type-checking.
type ComposerProps = { sessionId?: string; compact?: boolean };

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
    // Restore what the touch-detection test deletes, so later tests in this
    // file still see jsdom's default (touch-looking) window.
    if (!("ontouchstart" in window)) (window as unknown as { ontouchstart: null }).ontouchstart = null;
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

  // One button now covers images and files alike (iOS renders the same picker
  // sheet for both, so two were indistinguishable), which makes it a union of
  // the two capabilities rather than a match on either one.
  test("hides the attach button when the agent takes neither images nor embedded context", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: {} } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Attach"]')).toBeNull();
  });

  test("shows the attach button for an image-only agent", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: { image: true } } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Attach"]')).not.toBeNull();
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

  test("shows the attach button for a file-only agent (no image support)", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: { embeddedContext: true } } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    expect(container.querySelector('button[title="Attach"]')).not.toBeNull();
  });

  test("one picker, two routes: an image goes inline, a document gets uploaded", async () => {
    // The whole point of merging the two buttons — the picked file's MIME type,
    // not which button was pressed, decides the path. An image must NOT hit
    // /uploads (it keeps the zero-round-trip inline base64 route), and a
    // document must, in the same selection.
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({
      agentReady: true,
      promptCapabilities: { image: true, embeddedContext: true },
    } as any);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: "spec.pdf", uri: "file:///data/uploads/cd34-spec.pdf" }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    const pdf = new File(["%PDF-1.4"], "spec.pdf", { type: "application/pdf" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [png, pdf], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    // Exactly one upload, and it's the PDF — the PNG never touched the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/uploads?name=spec.pdf");
    // The PDF is a file chip; the image took the inline path instead (a thumb,
    // not a chip), so it must not show up as one.
    const chips = Array.from(container.querySelectorAll(".file-chip .nm")).map((e) => e.textContent);
    expect(chips).toEqual(["spec.pdf"]);
    // …and it really did land inline, rather than being silently dropped —
    // without this, the test would pass just as happily if addFiles never ran.
    // FileReader resolves on a macrotask, so this needs a real-timer wait that
    // the microtask drain above can't cover.
    await vi.waitFor(() => expect(container.querySelectorAll(".attachments .thumb")).toHaveLength(1));
  });

  test("picking a file uploads it and renders a removable chip", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({ agentReady: true, promptCapabilities: { embeddedContext: true } } as any);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: "notes.md", uri: "file:///data/uploads/ab12-notes.md" }),
    } as Response));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const attachFile = container.querySelector<HTMLButtonElement>('button[title="Attach"]');
    expect(attachFile).not.toBeNull();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeUndefined();

    const file = new File(["# hi"], "notes.md", { type: "text/markdown" });
    // uploadFile()'s fetch -> json -> setFiles chain needs a few microtask hops to
    // settle; draining them inside the same act() call (rather than polling with
    // a real-timer vi.waitFor, which crosses a macrotask boundary act() doesn't
    // track) is what lets React commit the update without an "outside of act()" warning.
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(container.querySelector(".file-chip .nm")?.textContent).toBe("notes.md");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/uploads?name=notes.md"),
      { method: "POST", body: file },
    );
    // The upload settled, so it's no longer holding the button disabled.
    expect(container.querySelector<HTMLButtonElement>('button[title="Attach"]')).not.toBeDisabled();
  });

  test("Enter doesn't submit while a file upload is still in flight", async () => {
    // Composer treats Enter as submit only on desktop (isTouchDevice, computed
    // once at module import from "ontouchstart" in window). jsdom defines that
    // as an own property unconditionally, regardless of real touch support, so
    // it must be deleted before importing a fresh Composer instance here, or
    // Enter exercises the (already-covered) newline path instead of submit.
    expect("ontouchstart" in window).toBe(true);
    delete (window as any).ontouchstart;

    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    // Send is wired separately from the Send button's disabled state (Enter
    // calls submit() directly via the editor keymap), so this exercises that
    // path specifically rather than the button's `disabled` attribute.
    const sendPrompt = vi.fn();
    useStore.setState({ agentReady: true, promptCapabilities: { embeddedContext: true }, sendPrompt } as any);
    // A fetch that never resolves keeps `uploading` pinned at 1 so the guard is
    // exercised deterministically instead of racing a real upload's completion.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["# hi"], "notes.md", { type: "text/markdown" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.querySelector<HTMLButtonElement>('button[title="Attach"]')).toBeDisabled();

    const view = cmView(container);
    await act(async () => { cmSet(view, "hello"); });
    await act(async () => { cmKey(view, "Enter"); });

    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test("Stop still cancels a running turn while a file upload is in flight", async () => {
    // The upload guard sits *below* submit()'s cancel branch on purpose: while
    // the agent is busy the same button is Stop, and an in-flight upload must
    // not take away the user's only way to interrupt a running turn. Ordering
    // those two guards the other way round silently breaks Stop, which nothing
    // else here would catch (the sibling test only asserts send *doesn't* fire).
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    const cancel = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({
      agentReady: true,
      promptCapabilities: { embeddedContext: true },
      activeId: "s1",
      busySessionIds: { s1: true },
      cancel,
      sendPrompt,
    } as any);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Composer));
    });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [new File(["# hi"], "notes.md")], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    const stop = container.querySelector<HTMLButtonElement>("button.send.stop")!;
    expect(stop).toBeEnabled(); // canSend short-circuits on activeBusy, upload or not
    await act(async () => { stop.click(); });

    expect(cancel).toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
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

  test("a bound instance sends through sendPromptTo with its own session id, not sendPrompt", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    const sendPrompt = vi.fn();
    const sendPromptTo = vi.fn();
    useStore.setState({ agentReady: true, sendPrompt, sendPromptTo } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement<ComposerProps>(Composer, { sessionId: "branch-1" }));
    });

    await act(async () => { cmSet(cmView(container), "hello"); });
    const send = container.querySelector<HTMLButtonElement>("button.send")!;
    await act(async () => { send.click(); });

    expect(sendPromptTo).toHaveBeenCalledWith("branch-1", "hello", [], []);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test("a bound instance's file attachments are isolated from the store's attachedFiles", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    useStore.setState({
      agentReady: true,
      promptCapabilities: { embeddedContext: true },
      // Stands in for a file the panel attached to the (unbound) main composer —
      // it must not leak into this bound instance's chip strip.
      attachedFiles: [{ name: "panel.md", uri: "file:///panel.md" }],
    } as any);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: "branch.md", uri: "file:///data/uploads/branch.md" }),
    } as Response));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement<ComposerProps>(Composer, { sessionId: "branch-1" }));
    });

    // The store's file (from the file panel) does not show up as a chip here.
    expect(container.querySelector(".file-chip .nm")).toBeNull();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["# hi"], "branch.md", { type: "text/markdown" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The upload landed in this instance's own chip strip...
    expect(container.querySelector(".file-chip .nm")?.textContent).toBe("branch.md");
    // ...and never touched the store's list.
    expect(useStore.getState().attachedFiles).toEqual([{ name: "panel.md", uri: "file:///panel.md" }]);
  });

  test("clearing after send only clears the bound instance's own file list", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    const sendPromptTo = vi.fn();
    useStore.setState({
      agentReady: true,
      promptCapabilities: { embeddedContext: true },
      attachedFiles: [{ name: "panel.md", uri: "file:///panel.md" }],
      sendPromptTo,
    } as any);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: "branch.md", uri: "file:///data/uploads/branch.md" }),
    } as Response));

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement<ComposerProps>(Composer, { sessionId: "branch-1" }));
    });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["# hi"], "branch.md", { type: "text/markdown" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.querySelector(".file-chip .nm")?.textContent).toBe("branch.md");

    await act(async () => { cmSet(cmView(container), "go"); });
    const send = container.querySelector<HTMLButtonElement>("button.send")!;
    await act(async () => { send.click(); });

    expect(sendPromptTo).toHaveBeenCalledWith(
      "branch-1", "go", [], [{ name: "branch.md", uri: "file:///data/uploads/branch.md" }],
    );
    // The bound instance's own chip is gone...
    expect(container.querySelector(".file-chip")).toBeNull();
    // ...but the store's list (the file panel's own state) is untouched.
    expect(useStore.getState().attachedFiles).toEqual([{ name: "panel.md", uri: "file:///panel.md" }]);
  });

  test("cancel in a bound instance passes its session id", async () => {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");

    const cancel = vi.fn();
    useStore.setState({
      agentReady: true,
      // The parent conversation is active but idle; the branch is the one
      // running, which is exactly the case bound busy-state has to tell apart
      // from unbound (activeId-based) busy-state.
      activeId: "parent-1",
      busySessionIds: { "branch-1": true },
      cancel,
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement<ComposerProps>(Composer, { sessionId: "branch-1" }));
    });

    const stop = container.querySelector<HTMLButtonElement>("button.send.stop");
    expect(stop).not.toBeNull(); // busy read from busySessionIds[sessionId], not activeId
    await act(async () => { stop!.click(); });

    expect(cancel).toHaveBeenCalledWith("branch-1");
  });

  // The branch button is one click from send and spends a few seconds spawning a
  // CLI, so it arms before it fires.
  type BranchPrompt = { text: string; images?: unknown[]; files?: unknown[] };
  async function mountWithFork(
    props: ComposerProps = {},
    fork: (p: BranchPrompt) => Promise<boolean> = async () => true,
  ) {
    const { Composer } = await import("./Composer.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    const branchSession = vi.fn(fork);
    useStore.setState({
      agentReady: true,
      agentName: "claude",
      cfg: { ...useStore.getState().cfg, agents: [{ name: "claude", cwd: "/p", sessionFork: true }] },
      activeId: "s1",
      sessions: { s1: makeSession("s1"), b1: makeSession("b1") },
      sideWindows: [],
      runningTasks: [],
      busySessionIds: {},
      branchSession,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement<ComposerProps>(Composer, props));
    });
    return { branchSession };
  }

  test("the branch button arms on the first click and only forks on the second", async () => {
    const { branchSession } = await mountWithFork();

    // Branching sends: with nothing typed there is nothing to open a branch with,
    // so the control is refused until there is.
    expect(container.querySelector<HTMLButtonElement>(".branch-btn")!).toBeDisabled();
    await act(async () => { cmSet(cmView(container), "try it the other way"); });

    const btn = container.querySelector<HTMLButtonElement>(".branch-btn")!;
    expect(btn).not.toBeDisabled();
    expect(btn.textContent).toContain("branch");
    expect(container.querySelector(".branch-hint")).toBeNull();

    await act(async () => { btn.click(); });
    expect(branchSession).not.toHaveBeenCalled();
    expect(container.querySelector(".branch-hint")).not.toBeNull();
    expect(container.querySelector(".branch-btn")!.textContent).toContain("confirm");

    await act(async () => { container.querySelector<HTMLButtonElement>(".branch-btn")!.click(); });
    // The typed message is what the branch opens with — and the box is cleared
    // only because the fork reported success.
    expect(branchSession).toHaveBeenCalledTimes(1);
    expect(branchSession.mock.calls[0][0]).toMatchObject({ text: "try it the other way" });
    expect(container.querySelector(".branch-hint")).toBeNull();
    expect(cmView(container).state.doc.toString()).toBe("");
  });

  test("a fork that fails leaves the typed message in the box", async () => {
    const { branchSession } = await mountWithFork({}, async () => false);
    await act(async () => { cmSet(cmView(container), "would have been lost"); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".branch-btn")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".branch-btn")!.click(); });
    expect(branchSession).toHaveBeenCalledTimes(1);
    expect(cmView(container).state.doc.toString()).toBe("would have been lost");
  });

  test("an armed branch button gives up on Escape", async () => {
    const { branchSession } = await mountWithFork();

    await act(async () => { cmSet(cmView(container), "never mind"); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".branch-btn")!.click(); });
    expect(container.querySelector(".branch-hint")).not.toBeNull();

    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(container.querySelector(".branch-hint")).toBeNull();
    expect(branchSession).not.toHaveBeenCalled();
  });

  test("a bound instance never offers to branch the conversation behind it", async () => {
    await mountWithFork({ sessionId: "b1" });
    expect(container.querySelector(".branch-btn")).toBeNull();
  });

});
