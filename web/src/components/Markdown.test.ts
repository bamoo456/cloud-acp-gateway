import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Markdown } from "./Markdown.tsx";

// The copy button is injected as HTML (lib/markdown.ts) and handled by the
// delegated click on .md — so the wiring only exists once something clicks it.
describe("Markdown code copy", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  const copied: string[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    copied.length = 0;
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async (t: string) => { copied.push(t); }) } });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container.remove();
  });

  test("copies the block's source and acknowledges the click", async () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(Markdown, { text: "```js\nconst a = 1;\n```" }));
    });
    const btn = container.querySelector<HTMLButtonElement>(".md-copy")!;
    expect(btn).not.toBeNull();

    // The click lands on the icon, not the button — .closest() is what makes
    // the delegated handler find it.
    await act(async () => { btn.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(copied).toEqual(["const a = 1;\n"]);
    expect(btn.classList.contains("copied")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Copied");
  });
});

// A path in an answer becomes a link only once the gateway has placed it, and
// it is placed against the folder the answer was written from.
describe("Markdown code references", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let resolveWorkspaceRef: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp", "token": "test-token", "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    resolveWorkspaceRef = vi.fn(async (_cwd: string, p: string) =>
      p === "src/app.ts" ? { abs: "/projA/src/app.ts", path: "src/app.ts" } : null);
    vi.doMock("../lib/api.ts", () => ({ resolveWorkspaceRef }));
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    vi.doUnmock("../lib/api.ts");
  });

  async function render(text: string, cwd?: string) {
    const { Markdown } = await import("./Markdown.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Markdown, { text, cwd }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }
  const ref = (path: string) => container.querySelector<HTMLElement>(`.md-ref[data-path="${path}"]`)!;

  test("a resolved reference opens the file at its line, against the answer's own folder", async () => {
    await render("see src/app.ts:12 and e.g. missing.ts", "/projA");
    expect(resolveWorkspaceRef).toHaveBeenCalledWith("/projA", "src/app.ts");

    const hit = ref("src/app.ts");
    expect(hit.className).toBe("md-ref resolved");
    expect(hit.getAttribute("role")).toBe("link");
    expect(hit.tabIndex).toBe(0);
    expect(hit.title).toBe("src/app.ts");
    // Unresolved: the plain text it arrived as.
    const miss = ref("missing.ts");
    expect(miss.className).toBe("md-ref");
    expect(miss.hasAttribute("role")).toBe(false);
    expect(miss.hasAttribute("tabindex")).toBe(false);

    // The active conversation moves to another project; the answer does not.
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    await act(async () => {
      useStore.setState({ activeId: "s2", sessions: { s2: { id: "s2", cwd: "/projB" } as never }, openFilePreview });
    });
    await act(async () => { hit.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({
      abs: "/projA/src/app.ts", path: "src/app.ts", mode: "file", cwd: "/projA", line: 12, endLine: undefined,
    });
    // Keyboard too, since it is a link.
    await act(async () => { hit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledTimes(2);
    await act(async () => { miss.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledTimes(2);
  });

  test("without a folder to read against, references stay plain and nothing is asked", async () => {
    await render("see src/app.ts:12");
    expect(resolveWorkspaceRef).not.toHaveBeenCalled();
    expect(ref("src/app.ts").className).toBe("md-ref");
  });

  test("a stream re-rendering the same text asks once and keeps the link", async () => {
    const { Markdown } = await import("./Markdown.tsx");
    for (const text of ["see src/app", "see src/app.ts", "see src/app.ts:12 and", "see src/app.ts:12 and src/app.ts"]) {
      await act(async () => {
        root ??= createRoot(container);
        root.render(React.createElement(Markdown, { text, cwd: "/projA" }));
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(1);
    const hits = container.querySelectorAll(".md-ref.resolved[role=link]");
    expect(hits).toHaveLength(2);
  });
});

// A trace or a review guide arrives as a fenced JSON block (lib/reviewPrompt.ts
// asks for exactly one), and is drawn as the card a tool call gets.
describe("Markdown structured results", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let resolveWorkspaceRef: ReturnType<typeof vi.fn>;
  const copied: string[] = [];

  const TRACE = JSON.stringify({
    symbol: "resolveRef",
    definition: [{ label: "resolveRef", path: "src/app.ts", line: 12, endLine: 20, why: "the cache entry point" }],
    callers: [{ label: "Markdown", path: "missing.ts", line: 40 }],
    callees: [{ label: "a built-in", why: "no file to open" }],
    notes: "callers found by search, not by an index",
  });
  const GUIDE = JSON.stringify({
    title: "Start with the resolver",
    steps: [{ label: "the whole file", path: "src/app.ts", why: "read it top to bottom" }],
  });
  const fence = (kind: string, body: string) => "```" + kind + "\n" + body + "\n```";

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    copied.length = 0;
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async (t: string) => { copied.push(t); }) } });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp", "token": "test-token", "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    resolveWorkspaceRef = vi.fn(async (_cwd: string, p: string) =>
      p === "src/app.ts" ? { abs: "/projA/src/app.ts", path: "src/app.ts" } : null);
    vi.doMock("../lib/api.ts", () => ({ resolveWorkspaceRef }));
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    vi.doUnmock("../lib/api.ts");
  });

  async function render(text: string, final: boolean) {
    const { Markdown } = await import("./Markdown.tsx");
    await act(async () => {
      root ??= createRoot(container);
      root.render(React.createElement(Markdown, { text, cwd: "/projA", final }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }
  async function watchPreview() {
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    await act(async () => { useStore.setState({ openFilePreview }); });
    return openFilePreview;
  }

  test("a trace becomes a card whose located items open the file", async () => {
    await render(fence("acp-trace", TRACE), true);

    const card = container.querySelector<HTMLElement>(".acp-result")!;
    expect(card.querySelector(".tkind")!.textContent).toBe("trace");
    expect(card.querySelector(".ttitle")!.textContent).toBe("resolveRef");
    // The raw JSON is kept, hidden, as the fallback and as what Copy reads.
    expect(container.querySelector("pre")!.hidden).toBe(true);
    expect(card.textContent).toContain("callers found by search");

    const hit = card.querySelector<HTMLElement>('.md-ref[data-path="src/app.ts"]')!;
    expect(hit.textContent).toBe("resolveRef · src/app.ts:12");
    expect(hit.className).toBe("md-ref resolved");
    expect(hit.dataset.end).toBe("20");
    // Unresolved stays plain, and an item with no path is never a reference.
    expect(card.querySelector<HTMLElement>('.md-ref[data-path="missing.ts"]')!.className).toBe("md-ref");
    expect(card.querySelectorAll(".md-ref")).toHaveLength(2);
    expect(card.textContent).toContain("a built-in");

    const openFilePreview = await watchPreview();
    await act(async () => { hit.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({
      abs: "/projA/src/app.ts", path: "src/app.ts", mode: "file", cwd: "/projA", line: 12, endLine: 20,
    });
  });

  test("a guide step about a whole file opens it without a line", async () => {
    await render(fence("acp-guide", GUIDE), true);

    const card = container.querySelector<HTMLElement>(".acp-result")!;
    expect(card.querySelector(".tkind")!.textContent).toBe("guide");
    expect(card.querySelector(".ttitle")!.textContent).toBe("Start with the resolver");
    const step = card.querySelector<HTMLElement>("ol li .md-ref")!;
    expect(step.textContent).toBe("the whole file · src/app.ts");

    const openFilePreview = await watchPreview();
    await act(async () => { step.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({
      abs: "/projA/src/app.ts", path: "src/app.ts", mode: "file", cwd: "/projA", line: undefined, endLine: undefined,
    });
  });

  test("JSON that never parses says so only once the turn has stopped", async () => {
    await render(fence("acp-trace", '{"symbol":'), false);
    expect(container.querySelector(".acp-result")).toBeNull();
    expect(container.querySelector(".acp-note")).toBeNull();
    expect(container.querySelector("pre")!.hidden).toBe(false);

    // Same text, the turn now finished: the raw fence stays and gains the note.
    await render(fence("acp-trace", '{"symbol":'), true);
    expect(container.querySelectorAll(".acp-note")).toHaveLength(1);
    expect(container.querySelector("pre")!.hidden).toBe(false);
  });

  test("a half-written block waits, and the finished one is asked about once", async () => {
    await render("```acp-trace\n" + TRACE.slice(0, 40), false);
    expect(container.querySelector(".acp-block")).not.toBeNull();
    expect(container.querySelector(".acp-result")).toBeNull();
    expect(container.querySelector(".acp-note")).toBeNull();
    expect(resolveWorkspaceRef).not.toHaveBeenCalled();

    await render(fence("acp-trace", TRACE), false);
    // The reply keeps growing after the block closed, so the card is rebuilt
    // from a fresh innerHTML — off the cache, without asking again.
    await render(fence("acp-trace", TRACE) + "\n\nThat is the whole path.", false);
    expect(container.querySelectorAll(".acp-result")).toHaveLength(1);
    expect(resolveWorkspaceRef).toHaveBeenCalledTimes(2);

    const btn = container.querySelector<HTMLButtonElement>(".acp-block .md-copy")!;
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(copied).toEqual([TRACE + "\n"]);
  });
});

// A diagram's nodes are made navigable by the metadata block beside it, never
// by what a node says. mermaid is faked: laying a diagram out needs getBBox and
// jsdom has none, so the renderer's half of the contract — a <g> whose id is the
// parser's domId behind this render's prefix — is what the fake reproduces.
describe("Markdown diagram nodes", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let resolveWorkspaceRef: ReturnType<typeof vi.fn>;
  let initialize: ReturnType<typeof vi.fn>;
  let draw: ReturnType<typeof vi.fn>;
  let bindFunctions: ReturnType<typeof vi.fn>;

  // The parser's own ids, and the same ids as the renderer writes them: the
  // prefix is why the mapping matches on the suffix (see nodeElement).
  const NODES = [{ id: "A", domId: "flowchart-A-0" }, { id: "B", domId: "flowchart-B-1" }];
  const SVG = '<svg viewBox="0 0 100 100">'
    + '<g class="node" id="mmd-7-flowchart-A-0"><rect></rect><text>Start</text></g>'
    + '<g class="node" id="mmd-7-flowchart-B-1"><rect></rect><text>src/app.ts</text></g></svg>';
  // The same drawing after a `click` directive: node A's href sanitized away, B's
  // kept, both marked .clickable.
  const LINKED_SVG = SVG
    .replace('<g class="node" id="mmd-7-flowchart-A-0">', '<a data-look="classic"><g class="node clickable" id="mmd-7-flowchart-A-0">')
    .replace('<text>Start</text></g>', '<text>Start</text></g></a>')
    .replace('<g class="node" id="mmd-7-flowchart-B-1">', '<a xlink:href="https://evil.example/"><g class="node clickable" id="mmd-7-flowchart-B-1">')
    .replace('<text>src/app.ts</text></g>', '<text>src/app.ts</text></g></a>');
  const source = (extra = "") =>
    ["```mermaid", "flowchart TD", "  A[Start] --> B[src/app.ts]", extra, "```"].join("\n");
  const reply = (meta: string, extra = "") =>
    [source(extra), "", "Then some prose between the two.", "", "```acp-nodes", meta, "```"].join("\n");

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp", "token": "test-token", "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    resolveWorkspaceRef = vi.fn(async (_cwd: string, p: string) =>
      p === "src/app.ts" ? { abs: "/projA/src/app.ts", path: "src/app.ts" } : null);
    vi.doMock("../lib/api.ts", () => ({ resolveWorkspaceRef }));
    initialize = vi.fn();
    bindFunctions = vi.fn();
    draw = vi.fn(async () => ({ svg: SVG, bindFunctions }));
    vi.doMock("mermaid", () => ({
      default: {
        initialize, render: draw,
        mermaidAPI: { getDiagramFromText: async () => ({ type: "flowchart-v2", db: { getData: () => ({ nodes: NODES }) } }) },
      },
    }));
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    vi.doUnmock("../lib/api.ts");
    vi.doUnmock("mermaid");
  });

  async function render(text: string, final = true) {
    const { Markdown } = await import("./Markdown.tsx");
    await act(async () => {
      root ??= createRoot(container);
      root.render(React.createElement(Markdown, { text, cwd: "/projA", diagrams: true, final }));
    });
  }
  const node = (domId: string) => container.querySelector<SVGElement>(`[id$="${domId}"]`)!;
  async function watchPreview() {
    const { useStore } = await import("../store/store.ts");
    const openFilePreview = vi.fn();
    await act(async () => { useStore.setState({ openFilePreview }); });
    return openFilePreview;
  }

  test("a mapped node opens its file, and every other node stays a picture", async () => {
    // B is labelled with a path and mapped by nobody; Z is mapped and drawn by
    // nobody.
    await render(reply(JSON.stringify({
      A: { path: "src/app.ts", line: 12, endLine: 20, label: "the resolver" },
      Z: { path: "src/app.ts", line: 3 },
    })));
    await vi.waitFor(() => expect(container.querySelector(".acp-node.resolved")).not.toBeNull());

    const mapped = node("flowchart-A-0");
    expect(mapped.dataset.path).toBe("src/app.ts");
    expect(mapped.dataset.end).toBe("20");
    expect(mapped.getAttribute("role")).toBe("link");
    expect(mapped.getAttribute("tabindex")).toBe("0");
    // A label that reads like a path is still only a label.
    expect(node("flowchart-B-1").classList.contains("acp-node")).toBe(false);
    // The mapping the diagram had no node for navigates from the list instead.
    expect(container.querySelector(".acp-node-list .loc")!.textContent).toBe("References");
    const listed = container.querySelectorAll<HTMLElement>(".acp-node-list .md-ref");
    expect([...listed].map((r) => r.textContent)).toEqual(["the resolver · src/app.ts:12", "src/app.ts:3"]);
    expect(listed[1].className).toBe("md-ref resolved");

    const openFilePreview = await watchPreview();
    // The click lands on a shape inside the node, which is what closest() is for.
    await act(async () => { mapped.querySelector("rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledWith({
      abs: "/projA/src/app.ts", path: "src/app.ts", mode: "file", cwd: "/projA", line: 12, endLine: 20,
    });
    await act(async () => { mapped.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(openFilePreview).toHaveBeenCalledTimes(2);
  });

  test("a path the gateway won't place stays inert in the node and in the list", async () => {
    // B is mapped to a path that does resolve: once its mark has landed, the one
    // beside it has been answered too, so "still plain" means it was refused.
    await render(reply(JSON.stringify({ A: { path: "../etc/passwd", line: 2 }, B: { path: "src/app.ts" } })));
    await vi.waitFor(() => expect(container.querySelector(".acp-node-list .md-ref.resolved")).not.toBeNull());

    const mapped = node("flowchart-A-0");
    expect(mapped.classList.contains("resolved")).toBe(false);
    expect(mapped.hasAttribute("tabindex")).toBe(false);
    expect(container.querySelector(".acp-node-list .md-ref")!.className).toBe("md-ref");
    expect(container.querySelectorAll(".acp-node.resolved")).toHaveLength(1);

    const openFilePreview = await watchPreview();
    await act(async () => { mapped.querySelector("rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  test("metadata that can't be read leaves the diagram drawn and says so once", async () => {
    await render(reply('{"A": {'));
    await vi.waitFor(() => expect(container.querySelector(".acp-note")).not.toBeNull());

    expect(container.querySelector(".md-mermaid")).not.toBeNull();
    expect(container.querySelector(".acp-node")).toBeNull();
    expect(container.querySelector(".acp-node-list")).toBeNull();
    expect(container.querySelector(".acp-note")!.textContent).toBe("Structured result couldn't be read — showing the raw reply");
    // The block it arrived in comes back, because now it is all there is.
    expect(container.querySelector<HTMLElement>(".acp-nodes")!.hidden).toBe(false);
  });

  test("a source that scripts its own nodes draws under strict, and binds nothing", async () => {
    // What mermaid 11 really hands back for a `click` directive under strict: the
    // callback's URL is gone, a plain href is NOT, and both nodes are .clickable
    // (confirmed in tests/e2e/mermaid-nodes.spec.ts, which is the only place a
    // diagram is drawn for real).
    draw.mockResolvedValueOnce({ svg: LINKED_SVG, bindFunctions });
    await render(reply(JSON.stringify({ A: { path: "src/app.ts" } }),
      '  click A href "javascript:alert(1)"\n  click B href "https://evil.example"'));
    await vi.waitFor(() => expect(container.querySelector(".acp-node.resolved")).not.toBeNull());

    expect(initialize.mock.calls[0][0].securityLevel).toBe("strict");
    // The source went to mermaid as written; what never happens is the bridge
    // that would turn its click directives into handlers.
    expect(draw.mock.calls[0][1]).toContain('click B href "https://evil.example"');
    expect(bindFunctions).not.toHaveBeenCalled();
    // The <a> is unwrapped rather than left inert: an agent's href is the one
    // navigation on this diagram nobody validated.
    expect(container.querySelector(".md-mermaid a")).toBeNull();
    expect(container.querySelector(".md-mermaid [href]")).toBeNull();
    expect(container.querySelector(".md-mermaid .clickable")).toBeNull();
    // Unwrapping kept the node it wrapped, mapping and all.
    expect(node("flowchart-A-0").dataset.path).toBe("src/app.ts");
  });

  // A diagram that would not draw keeps its source; what it must not lose is
  // where that source said the code was.
  test("a diagram that won't draw still says what it pointed at", async () => {
    draw.mockRejectedValueOnce(new Error("boom"));
    await render(reply(JSON.stringify({ A: { path: "src/app.ts", line: 7 } })));
    await vi.waitFor(() => expect(container.querySelector(".acp-node-list .md-ref.resolved")).not.toBeNull());

    expect(container.querySelector("pre.md-mermaid-failed")).not.toBeNull();
    expect(container.querySelector(".acp-node")).toBeNull();
    // Under the note that says why, not between it and the source it explains.
    expect(container.querySelector(".md-mermaid-error")!.nextElementSibling!.className).toBe("acp-node-list");
    expect(container.querySelector(".acp-node-list .md-ref")!.textContent).toBe("src/app.ts:7");
  });

  // The metadata is the only thing that makes a node navigable, so a reply
  // re-rendered with different metadata must not leave a node pointing where the
  // last one said.
  test("metadata replaced by a re-render leaves nothing navigating to the old place", async () => {
    await render(reply(JSON.stringify({ A: { path: "src/app.ts", line: 12 } })));
    await vi.waitFor(() => expect(container.querySelector(".acp-node.resolved")).not.toBeNull());
    const stale = node("flowchart-A-0");

    await render(reply(JSON.stringify({ A: { path: "gone.ts" }, B: { path: "src/app.ts" } })));
    await vi.waitFor(() => expect(container.querySelector(".acp-node.resolved")).not.toBeNull());

    expect(stale.isConnected).toBe(false);
    const now = node("flowchart-A-0");
    expect(now.dataset.path).toBe("gone.ts");
    expect(now.dataset.line).toBeUndefined();
    expect(now.classList.contains("resolved")).toBe(false);
    expect(container.querySelectorAll(".acp-node-list")).toHaveLength(1);

    const openFilePreview = await watchPreview();
    await act(async () => { now.querySelector("rect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(openFilePreview).not.toHaveBeenCalled();
  });
});
