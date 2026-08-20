import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Session } from "../types";

describe("Thread empty state agent icon", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp",
      "token": "test-token",
      "defaultAgent": "codex",
      "agents": [{ "name": "codex", "cwd": "/repo" }],
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

  test("shows the Codex mark instead of the robot for a Codex-skinned agent", async () => {
    const { Thread } = await import("./Thread.tsx");
    const { useStore } = await import("../store/store.ts");
    const s0 = useStore.getState();
    useStore.setState({
      agentName: "codex",
      cfg: { ...s0.cfg, agents: [{ name: "codex", cwd: "", skin: "codex" }] },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Thread, { session: null, agentReady: true }));
    });

    expect(container.querySelector(".codex-mark")).not.toBeNull();
    expect(container.querySelector(".robot")).toBeNull();
  });

  test("reveals a jump-to-latest arrow when scrolled up and hides it on tap", async () => {
    const { Thread } = await import("./Thread.tsx");

    // Thread reads its scroll container via `closest("main")`, so mount it inside one
    // and fake the geometry jsdom doesn't compute.
    const main = document.createElement("main");
    document.body.appendChild(main);
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 500 });
    main.scrollTop = 0; // parked at the top — far from the live tail

    const session: Session = {
      id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
      hasContent: true, working: false,
      curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null, seq: 1, historyStart: 0, loadingOlder: false,
      items: [{ id: "m1", kind: "assistant", text: "hello" }],
    };

    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true }));
    });

    // No scrolling yet → no button.
    expect(main.querySelector(".jump-latest")).toBeNull();

    // Scroll up off the bottom → the arrow appears. (Mount auto-pins to the tail, so
    // reset scrollTop first.)
    main.scrollTop = 0;
    await act(async () => { main.dispatchEvent(new Event("scroll")); });
    const btn = main.querySelector(".jump-latest") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    // Tapping it pins to the bottom and hides the arrow.
    await act(async () => { btn!.click(); });
    expect(main.scrollTop).toBe(1000);
    expect(main.querySelector(".jump-latest")).toBeNull();

    main.remove();
  });

  test("re-asserts the jump across frames when content settles taller after the tap", async () => {
    const { Thread } = await import("./Thread.tsx");

    // Drive requestAnimationFrame by hand so we can step through the re-assert frames.
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    const flushFrame = () => {
      const cbs = rafQueue.splice(0, rafQueue.length);
      for (const cb of cbs) cb(0);
    };

    const main = document.createElement("main");
    document.body.appendChild(main);
    // scrollHeight starts at 1000, then "grows" to 1600 as markdown/images lay out —
    // mimicking the layout shift that left a single jump stranded above the fold.
    let scrollHeight = 1000;
    Object.defineProperty(main, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 500 });
    main.scrollTop = 0;

    const session: Session = {
      id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
      hasContent: true, working: false,
      curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null, seq: 1, historyStart: 0, loadingOlder: false,
      items: [{ id: "m1", kind: "assistant", text: "hello" }],
    };

    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true }));
    });
    rafQueue.length = 0; // discard mount-time frames

    main.scrollTop = 0;
    await act(async () => { main.dispatchEvent(new Event("scroll")); });
    const btn = main.querySelector(".jump-latest") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    // First (synchronous) jump lands at the current bottom...
    await act(async () => { btn!.click(); });
    expect(main.scrollTop).toBe(1000);

    // ...then content settles taller, and the queued frames re-assert to the new bottom.
    scrollHeight = 1600;
    await act(async () => { flushFrame(); }); // raf1
    await act(async () => { flushFrame(); }); // raf2
    expect(main.scrollTop).toBe(1600);

    main.remove();
  });

  test("forces a repaint when a structural change appends an item (issue #98)", async () => {
    // Capture rAF callbacks without running them so we can observe the hint before
    // it's reverted on the next frame.
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    const { Thread } = await import("./Thread.tsx");

    const main = document.createElement("main");
    document.body.appendChild(main);
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 500 });

    const base: Session = {
      id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
      hasContent: true, working: false,
      curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null, seq: 1, historyStart: 0, loadingOlder: false,
      items: [{ id: "m1", kind: "assistant", text: "hello" }],
    };

    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session: base, agentReady: true }));
    });
    main.style.transform = ""; // clear the mount-time hint
    rafQueue.length = 0;       // discard mount-time frames

    // A tool card arrives — the structural change that left the thread blank on iOS.
    const next: Session = {
      ...base,
      items: [
        ...base.items,
        { id: "t1", kind: "tool", toolCallId: "c1", title: "Read", toolKind: "read", status: "pending", locations: [], content: [] },
      ],
    };
    await act(async () => {
      root!.render(React.createElement(Thread, { session: next, agentReady: true }));
    });

    // The compositing hint is applied synchronously, awaiting the next frame to revert.
    expect(main.style.transform).toBe("translateZ(0)");

    // The queued frame reverts it, so nothing is left promoted.
    await act(async () => {
      const cbs = rafQueue.splice(0, rafQueue.length);
      for (const cb of cbs) cb(0);
    });
    expect(main.style.transform).toBe("");

    main.remove();
  });

  test("forces a repaint when a running tool mutates in place (status + result, issue #98)", async () => {
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    const flushFrames = () => {
      const cbs = rafQueue.splice(0, rafQueue.length);
      for (const cb of cbs) cb(0);
    };

    const { Thread } = await import("./Thread.tsx");

    const main = document.createElement("main");
    document.body.appendChild(main);
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 500 });

    // A tool card is already mounted, sitting in its initial pending state.
    const base: Session = {
      id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
      hasContent: true, working: true,
      curAssistantId: null, curThoughtId: null, toolItemId: { c1: "t1" }, planItemId: null, seq: 1, historyStart: 0, loadingOlder: false,
      items: [
        { id: "m1", kind: "assistant", text: "hello" },
        { id: "t1", kind: "tool", toolCallId: "c1", title: "Read", toolKind: "read", status: "pending", locations: [], content: [] },
      ],
    };

    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session: base, agentReady: true }));
    });
    main.style.transform = ""; // clear the mount-time hint
    flushFrames();             // drain mount-time frames
    rafQueue.length = 0;

    // The tool starts running and streams a result — the item count never changes,
    // only the existing card's status and content. This must still repaint.
    const running: Session = {
      ...base,
      items: [
        base.items[0],
        { id: "t1", kind: "tool", toolCallId: "c1", title: "Read", toolKind: "read", status: "in_progress", locations: [], content: [{ type: "content", content: { type: "text", text: "partial output" } }] },
      ],
    };
    await act(async () => {
      root!.render(React.createElement(Thread, { session: running, agentReady: true }));
    });
    expect(main.style.transform).toBe("translateZ(0)");
    await act(async () => { flushFrames(); });
    expect(main.style.transform).toBe("");

    // And again when it completes (status flips, the final reflow that left it blank).
    const done: Session = {
      ...base,
      working: false,
      items: [
        base.items[0],
        { id: "t1", kind: "tool", toolCallId: "c1", title: "Read", toolKind: "read", status: "completed", locations: [], content: [{ type: "content", content: { type: "text", text: "partial output" } }] },
      ],
    };
    await act(async () => {
      root!.render(React.createElement(Thread, { session: done, agentReady: true }));
    });
    expect(main.style.transform).toBe("translateZ(0)");
    await act(async () => { flushFrames(); });
    expect(main.style.transform).toBe("");

    main.remove();
  });

  test("shows the Codex mark immediately for a Codex-skinned agent before configOptions arrive", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "test-token",
      defaultAgent: "work",
      agents: [{ name: "work", cwd: "/repo", skin: "codex" }],
      fsRoot: "/",
    });
    const { Thread } = await import("./Thread.tsx");

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Thread, { session: null, agentReady: true }));
    });

    expect(container.querySelector(".codex-mark")).not.toBeNull();
    expect(container.querySelector(".robot")).toBeNull();
  });
});

describe("Thread history paging", () => {
  let root: Root | null = null;

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
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
  });

  function mountWith(historyStart: number, loadOlderMessages: () => Promise<void>) {
    const main = document.createElement("main");
    document.body.appendChild(main);
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 500 });
    const session = {
      id: "s", title: "S", createdAt: 0, agentName: "claude", cwd: "/repo", lastActiveAt: 0,
      items: [
        { id: "s:1", kind: "user", text: "a" },
        { id: "s:2", kind: "assistant", text: "b" },
      ],
      hasContent: true, working: false, curAssistantId: null, curThoughtId: null,
      toolItemId: {}, planItemId: null, seq: 2, historyStart, loadingOlder: false,
    } as unknown as Session;
    return { main, session, loadOlderMessages };
  }

  test("scrolling to the top fetches an older page once the local window is exhausted", async () => {
    const { Thread } = await import("./Thread.tsx");
    const { useStore } = await import("../store/store.ts");
    const loadOlderMessages = vi.fn(() => Promise.resolve());
    useStore.setState({ loadOlderMessages } as never);

    const { main, session } = mountWith(40, loadOlderMessages);
    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true }));
    });

    await act(async () => {
      main.scrollTop = 10;
      main.dispatchEvent(new Event("scroll"));
    });

    expect(loadOlderMessages).toHaveBeenCalledWith("s");
  });

  test("a thread already at the beginning of its transcript never fetches", async () => {
    const { Thread } = await import("./Thread.tsx");
    const { useStore } = await import("../store/store.ts");
    const loadOlderMessages = vi.fn(() => Promise.resolve());
    useStore.setState({ loadOlderMessages } as never);

    const { main, session } = mountWith(0, loadOlderMessages);
    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true }));
    });

    await act(async () => {
      main.scrollTop = 10;
      main.dispatchEvent(new Event("scroll"));
    });

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });
});

// A turn is folded at RENDER time only — `items` and the structuralSig derived
// from it must be untouched, because forceRepaint is keyed on that string and
// that key is the iOS/PWA blank-thread fix (issue #98). See plan §2.1.
describe("Thread turn grouping", () => {
  let root: Root | null = null;
  let main: HTMLElement;

  const session = (items: Session["items"]): Session => ({
    id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
    hasContent: true, working: false,
    curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null,
    seq: 1, historyStart: 0, loadingOlder: false, items,
  });

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token": "t", "defaultAgent": "claude", "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    main = document.createElement("main");
    document.body.appendChild(main);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    main.remove();
    vi.unstubAllGlobals();
  });

  async function render(items: Session["items"], working = false) {
    const { Thread } = await import("./Thread.tsx");
    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session: { ...session(items), working }, agentReady: true }));
    });
  }

  // Re-render the same mounted Thread with more items, the way a streamed reply
  // lands — component state (which turn is open) survives.
  async function rerender(items: Session["items"], working = false) {
    const { Thread } = await import("./Thread.tsx");
    await act(async () => {
      root?.render(React.createElement(Thread, { session: { ...session(items), working }, agentReady: true }));
    });
  }

  const peeks = () => Array.from(main.querySelectorAll("button.reply-peek")) as HTMLButtonElement[];
  const openReplies = () => main.querySelectorAll(".turn.agent .replies");

  test("the newest turn is open and every turn before it is a peek line", async () => {
    await render([
      { id: "a1", kind: "assistant", text: "older answer\nand a second line" },
      { id: "x1", kind: "tool", toolCallId: "c1", title: "src/a.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a2", kind: "assistant", text: "newest answer" },
    ]);

    expect(openReplies()).toHaveLength(1);
    expect(main.textContent).toContain("newest answer");
    expect(peeks()).toHaveLength(1);
    expect(peeks()[0].querySelector(".pk")?.textContent).toBe("older answer");
    expect(peeks()[0].querySelector(".n")?.textContent).toBe("2 lines");
  });

  test("a new answer takes focus back from an older turn you opened", async () => {
    await render([
      { id: "a1", kind: "assistant", text: "older answer" },
      { id: "x1", kind: "tool", toolCallId: "c1", title: "src/a.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a2", kind: "assistant", text: "newest answer" },
    ]);

    // Pin the older one...
    await act(async () => { peeks()[0].click(); });
    expect(main.querySelector(".turn.agent .replies")?.textContent).toContain("older answer");

    // ...then a reply arrives: the newest turn takes it back.
    await rerender([
      { id: "a1", kind: "assistant", text: "older answer" },
      { id: "x1", kind: "tool", toolCallId: "c1", title: "src/a.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a2", kind: "assistant", text: "newest answer" },
      { id: "x2", kind: "tool", toolCallId: "c2", title: "src/b.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a3", kind: "assistant", text: "newer still" },
    ]);
    expect(openReplies()).toHaveLength(1);
    expect(main.querySelector(".turn.agent .replies")?.textContent).toContain("newer still");
  });

  test("opening one reply folds whichever was open before it", async () => {
    await render([
      { id: "a1", kind: "assistant", text: "first answer" },
      { id: "x1", kind: "tool", toolCallId: "c1", title: "src/a.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a2", kind: "assistant", text: "second answer" },
    ]);

    // The newest is open, the older one is a peek.
    expect(peeks()).toHaveLength(1);

    await act(async () => { peeks()[0].click(); });
    expect(openReplies()).toHaveLength(1);
    expect(main.querySelector(".turn.agent .replies")?.textContent).toContain("first answer");

    // The open turn's own toggle folds it — and now nothing is open.
    const collapse = main.querySelector("button.reply-fold") as HTMLButtonElement;
    await act(async () => { collapse.click(); });
    expect(openReplies()).toHaveLength(0);
    expect(peeks()).toHaveLength(2);
  });

  test("the turn still streaming stays open, with no way to fold it", async () => {
    await render([{ id: "a1", kind: "assistant", text: "still arriving" }], true);

    expect(main.querySelector(".turn.agent .replies")).not.toBeNull();
    expect(peeks()).toHaveLength(0);
    expect(main.querySelector("button.reply-fold")).toBeNull();
  });

  test("the peek line reads as prose, not as markdown", async () => {
    await render([
      { id: "a1", kind: "assistant", text: "## **Bold** heading with a [link](http://x) and `code`" },
      { id: "x1", kind: "tool", toolCallId: "c1", title: "src/a.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a2", kind: "assistant", text: "newest" },
    ]);

    expect(peeks()[0].querySelector(".pk")?.textContent).toBe("Bold heading with a link and code");
  });

  test("a reply that is only an image says so rather than folding to nothing", async () => {
    await render([
      { id: "a1", kind: "assistant", text: "", images: [{ mimeType: "image/png", data: "x" }] },
      { id: "x1", kind: "tool", toolCallId: "c1", title: "src/a.ts", toolKind: "read", status: "completed", locations: [], content: [] },
      { id: "a2", kind: "assistant", text: "newest" },
    ]);

    expect(peeks()[0].querySelector(".pk")?.textContent).toBe("1 image");
  });

  test("a user message is plain text under a YOU label, with no bubble", async () => {
    await render([{ id: "u1", kind: "user", text: "do the thing" }]);

    expect(main.querySelector(".turn.user .lbl .you")?.textContent).toBe("you");
    expect(main.querySelector(".bubble")).toBeNull();
    expect(main.querySelector(".turn.user .body")?.textContent).toContain("do the thing");
  });
});

// Find in this conversation. The window mounts only the last handful of items
// and folds every reply but one, so the two things worth pinning are that a
// match outside the window pulls it into the DOM, and that a match inside a
// folded reply unfolds it.
describe("Thread find-in-conversation", () => {
  let root: Root | null = null;
  let main: HTMLElement;

  const longSession = (): Session => ({
    id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
    hasContent: true, working: false,
    curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null, seq: 1,
    historyStart: 0, loadingOlder: false,
    items: [
      { id: "old-q", kind: "user", text: "how do we handle the zzyzx token?" },
      { id: "old-a", kind: "assistant", text: "The zzyzx token is minted in auth.ts." },
      // Well past INITIAL_VISIBLE (10), so the pair above starts off-window.
      ...Array.from({ length: 30 }, (_, i) => (
        i % 2 === 0
          ? { id: "u" + i, kind: "user" as const, text: "later question " + i }
          : { id: "a" + i, kind: "assistant" as const, text: "later answer " + i }
      )),
    ],
  });

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
    main = document.createElement("main");
    document.body.appendChild(main);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    main.remove();
    vi.unstubAllGlobals();
  });

  async function typeQuery(q: string) {
    const input = main.querySelector<HTMLInputElement>(".thread-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, q);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("reveals and unfolds a match that was outside the mounted window", async () => {
    const { Thread } = await import("./Thread.tsx");
    const session = longSession();

    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true, findOpen: true, onCloseFind: () => {} }));
    });

    // The old exchange is off-window before the search.
    expect(main.querySelector('[data-id="old-a"]')).toBeNull();

    await typeQuery("zzyzx");

    // Two occurrences (the question and the reply), starting at the first.
    expect(main.querySelector(".thread-find .n")?.textContent).toBe("1/2");
    expect(main.querySelector('[data-id="old-q"]')).not.toBeNull();

    // Stepping to the reply's occurrence unfolds that turn — a folded one shows
    // only its peek line, never the body the match is in.
    const next = main.querySelectorAll<HTMLButtonElement>(".thread-find .icon-btn")[1];
    await act(async () => { next.click(); });
    expect(main.querySelector(".thread-find .n")?.textContent).toBe("2/2");
    expect(main.querySelector('[data-id="old-a"]')?.textContent).toContain("minted in auth.ts");
  });

  test("no match reads 0/0 and leaves the window alone", async () => {
    const { Thread } = await import("./Thread.tsx");
    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session: longSession(), agentReady: true, findOpen: true, onCloseFind: () => {} }));
    });
    await typeQuery("nothinghere");
    expect(main.querySelector(".thread-find .n")?.textContent).toBe("0/0");
    expect(main.querySelector('[data-id="old-q"]')).toBeNull();
  });
});

// The half of the conversation the client does not hold: matches before
// historyStart exist only on the gateway, and it is asked once, debounced, and
// only when there is unfetched history to ask about.
describe("Thread find beyond the fetched history", () => {
  let root: Root | null = null;
  let main: HTMLElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp", "token": "test-token", "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }], "fsRoot": "/"
    }</script>`;
    main = document.createElement("main");
    document.body.appendChild(main);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    main.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("counts only the matches older than what is loaded, and skips the call when nothing is older", async () => {
    const searchSessions = vi.fn().mockResolvedValue({
      // index 3 and 7 are before historyStart (10); 12 is already in hand.
      results: [{ hits: [{ index: 3 }, { index: 7 }, { index: 12 }] }],
      truncated: false, cursor: null, skipped: [], scanned: { files: 1, bytes: 0, ms: 1 },
    });
    vi.doMock("../lib/api.ts", async () => ({ ...(await vi.importActual<object>("../lib/api.ts")), searchSessions }));
    const { Thread } = await import("./Thread.tsx");

    const session: Session = {
      id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
      hasContent: true, working: false,
      curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null, seq: 1,
      historyStart: 10, loadingOlder: false,
      items: [{ id: "m1", kind: "assistant", text: "the zzyzx token" }],
    };

    vi.useFakeTimers();
    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true, findOpen: true, onCloseFind: () => {} }));
    });

    const input = main.querySelector<HTMLInputElement>(".thread-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zzyzx");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Debounced: nothing has gone out yet.
    expect(searchSessions).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    expect(searchSessions).toHaveBeenCalledWith("zzyzx", { session: "S", limit: 1 });
    expect(main.querySelector(".find-older")?.textContent).toContain("2 more messages match earlier");

    // A conversation held whole in memory has nothing to ask about.
    searchSessions.mockClear();
    await act(async () => {
      root!.render(React.createElement(Thread, {
        session: { ...session, historyStart: 0 }, agentReady: true, findOpen: true, onCloseFind: () => {},
      }));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(searchSessions).not.toHaveBeenCalled();
    expect(main.querySelector(".find-older")).toBeNull();
  });

  // One click has to reach the match, not advance one page toward it: the store
  // pages 50 messages at a time and a hit can be hundreds back (measured on a
  // real conversation: 237 → 0 took five pages).
  test("pages back until the earliest matching message is loaded, then stops", async () => {
    const searchSessions = vi.fn().mockResolvedValue({
      results: [{ hits: [{ index: 12 }, { index: 140 }] }],
      truncated: false, cursor: null, skipped: [], scanned: { files: 1, bytes: 0, ms: 1 },
    });
    // Each page hands back its own start, which is what stops the loop.
    const getMessages = vi.fn(async (_a: string, _c: string, _s: string, page: { from?: number }) =>
      ({ start: page.from ?? 0, messages: [], controls: {} }));
    vi.doMock("../lib/api.ts", async () => ({
      ...(await vi.importActual<object>("../lib/api.ts")), searchSessions, getMessages,
    }));
    const { Thread } = await import("./Thread.tsx");
    const { useStore } = await import("../store/store.ts");

    const session: Session = {
      id: "S", title: "t", createdAt: 0, agentName: "claude", cwd: "/tmp", lastActiveAt: 0,
      hasContent: true, working: false,
      curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null, seq: 1,
      historyStart: 150, loadingOlder: false,
      items: [{ id: "m1", kind: "assistant", text: "the zzyzx token" }],
    };
    // The click reads the session from the store, not from props.
    useStore.setState({ agentName: "claude", cwd: "/tmp", activeId: "S", sessions: { S: session } });

    await act(async () => {
      root = createRoot(main);
      root.render(React.createElement(Thread, { session, agentReady: true, findOpen: true, onCloseFind: () => {} }));
    });
    const input = main.querySelector<HTMLInputElement>(".thread-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zzyzx");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });

    await act(async () => { main.querySelector<HTMLButtonElement>(".find-older")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 150 → 100 → 50 → 0: it stops as soon as index 12 is in hand, and does not
    // keep paging past the beginning.
    expect(getMessages.mock.calls.map((c) => c[3])).toEqual([
      { from: 100, to: 150 }, { from: 50, to: 100 }, { from: 0, to: 50 },
    ]);
    expect(useStore.getState().sessions.S.historyStart).toBe(0);
  });
});
