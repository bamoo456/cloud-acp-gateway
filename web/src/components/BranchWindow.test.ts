import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Session } from "../types.ts";

function makeSession(id: string, title: string): Session {
  return {
    id, title, items: [], seq: 0,
    createdAt: Date.now(), lastActiveAt: Date.now(),
    agentName: "codex", cwd: "/p",
    hasContent: true, working: false,
    curAssistantId: null, curThoughtId: null,
    toolItemId: {}, planItemId: null, historyStart: 0, loadingOlder: false,
  };
}

describe("BranchWindow", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp", "token": "t", "defaultAgent": "codex",
      "agents": [{ "name": "codex", "cwd": "/p" }], "fsRoot": "/"
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

  async function render() {
    const { BranchWindow } = await import("./BranchWindow.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(BranchWindow));
    });
  }

  test("renders nothing without a window, or when the window's session is gone", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      sessions: { "parent-1": makeSession("parent-1", "Parent") },
      sideWindows: [],
    });
    await render();
    expect(container.querySelector(".branch-win")).toBeNull();

    // A window whose live session has been evicted has nothing to render.
    act(() => {
      useStore.setState({
        sessions: { "parent-1": makeSession("parent-1", "Parent") },
        sideWindows: [{ parentId: "parent-1", sessionId: "branch-1", slot: 0 }],
      });
    });
    expect(container.querySelector(".branch-win")).toBeNull();
  });

  test("the window stays up when the main column moves to another conversation", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "other": makeSession("other", "Something else"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
      },
      sideWindows: [{ parentId: "parent-1", sessionId: "branch-1", slot: 0 }],
    });
    await render();
    expect(container.querySelector(".branch-win")).not.toBeNull();

    // Switching the sidebar to a different conversation used to take the window
    // down with it. It is a second conversation, not an attachment to the first.
    act(() => { useStore.setState({ activeId: "other" }); });
    expect(container.querySelector(".branch-win")).not.toBeNull();

    // …but the conversation IS the one on screen now: hidden rather than shown
    // twice, and back again when the main column moves on.
    act(() => { useStore.setState({ activeId: "branch-1" }); });
    expect(container.querySelector(".branch-win")).toBeNull();
    act(() => { useStore.setState({ activeId: "other" }); });
    expect(container.querySelector(".branch-win")).not.toBeNull();
  });

  test("several windows render at once, cascaded and stacked in list order", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true, media, addEventListener() {}, removeEventListener() {},
    }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
        "side-1": makeSession("side-1", "Another thread"),
      },
      sideWindows: [
        { parentId: "parent-1", sessionId: "branch-1", slot: 0 },
        { parentId: null, sessionId: "side-1", slot: 1 },
      ],
    });
    await render();

    const cards = container.querySelectorAll<HTMLElement>(".branch-win");
    expect(cards).toHaveLength(2);
    // Slot 1 is offset from the default corner, so the two are both grabbable…
    expect(cards[0].style.right).toBe("20px");
    expect(cards[1].style.right).toBe("42px");
    // …and the later entry is the front-most.
    expect(Number(cards[1].style.zIndex)).toBeGreaterThan(Number(cards[0].style.zIndex));

    // Closing one leaves the other alone.
    await act(async () => { cards[0].querySelector<HTMLButtonElement>(".branch-win-head button")!.click(); });
    expect(useStore.getState().sideWindows.map((w) => w.sessionId)).toEqual(["side-1"]);
    expect(container.querySelectorAll(".branch-win")).toHaveLength(1);
  });

  test("touching a window raises it above the others", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true, media, addEventListener() {}, removeEventListener() {},
    }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
        "side-1": makeSession("side-1", "Another thread"),
      },
      sideWindows: [
        { parentId: "parent-1", sessionId: "branch-1", slot: 0 },
        { parentId: null, sessionId: "side-1", slot: 1 },
      ],
    });
    await render();

    const back = container.querySelectorAll<HTMLElement>(".branch-win")[0];
    const zBefore = Number(back.style.zIndex);
    await act(async () => {
      back.querySelector<HTMLElement>(".branch-win-body")!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    });
    expect(useStore.getState().sideWindows.map((w) => w.sessionId)).toEqual(["side-1", "branch-1"]);
    // Same card (keyed on its parent, so it did not remount), now on top.
    const raised = container.querySelectorAll<HTMLElement>(".branch-win")[1];
    expect(raised.querySelector(".branch-win-title")!.textContent).toBe("Parent (Branch)");
    expect(Number(raised.style.zIndex)).toBeGreaterThan(zBefore);
  });

  test("renders the window's thread and its own composer", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
      },
      sideWindows: [{ parentId: "parent-1", sessionId: "branch-1", slot: 0 }],
    });
    await render();

    expect(container.querySelector(".branch-win")).not.toBeNull();
    expect(container.querySelector(".branch-win .thread")).not.toBeNull();
    expect(container.querySelector(".branch-win .composer.compact")).not.toBeNull();
  });

  test("a dragged window keeps its place when the fork swaps the provisional id in", async () => {
    // jsdom answers every media query with `matches: false`, which is the phone
    // sheet — and a sheet is deliberately not draggable. Say "desktop" so the
    // card, and its drag handle, are what renders.
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true, media, addEventListener() {}, removeEventListener() {},
    }));
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "pending-x": makeSession("pending-x", "Parent (Branch)"),
      },
      sideWindows: [{ parentId: "parent-1", sessionId: "pending-x", slot: 0 }],
    });
    await render();

    // While the fork is still in flight the composer is a waiting strip, not an
    // input the agent could not answer.
    expect(container.querySelector(".branch-win-wait")).not.toBeNull();
    expect(container.querySelector(".branch-win .composer")).toBeNull();

    // Drag it somewhere.
    // MouseEvent, not PointerEvent: jsdom has no PointerEvent constructor, and
    // neither React's synthetic layer nor the handler reads anything a plain
    // mouse event lacks (it wants the type name and clientX/clientY).
    const head = container.querySelector<HTMLElement>(".branch-win-head")!;
    await act(async () => {
      head.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 80 }));
      window.dispatchEvent(new MouseEvent("pointerup", {}));
    });
    const card = container.querySelector<HTMLElement>(".branch-win")!;
    expect(card.style.left).toBe("120px");
    expect(card.style.top).toBe("80px");

    // session/fork answers: same window, real id. The place it was dragged to
    // has to survive that swap — it used to snap back to the default corner.
    await act(async () => {
      useStore.setState((st) => {
        const sessions = { ...st.sessions };
        delete sessions["pending-x"];
        sessions["branch-1"] = makeSession("branch-1", "Parent (Branch)");
        return { sessions, sideWindows: [{ parentId: "parent-1", sessionId: "branch-1", slot: 0 }] };
      });
    });
    const swapped = container.querySelector<HTMLElement>(".branch-win")!;
    expect(swapped.style.left).toBe("120px");
    expect(swapped.style.top).toBe("80px");
    // …and the real session can be typed into.
    expect(container.querySelector(".branch-win .composer.compact")).not.toBeNull();

    // A branch of a DIFFERENT conversation is a new window: back to default.
    await act(async () => {
      useStore.setState((st) => ({
        activeId: "parent-2",
        sessions: { ...st.sessions, "parent-2": makeSession("parent-2", "Other") },
        sideWindows: [{ parentId: "parent-2", sessionId: "branch-1", slot: 0 }],
      }));
    });
    expect(container.querySelector<HTMLElement>(".branch-win")!.style.left).toBe("");
  });

  test("the close button closes the window but leaves its session live", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
      },
      sideWindows: [{ parentId: "parent-1", sessionId: "branch-1", slot: 0 }],
    });
    await render();

    const closeBtn = container.querySelector<HTMLButtonElement>(".branch-win-head button");
    expect(closeBtn).not.toBeNull();
    await act(async () => { closeBtn!.click(); });

    expect(useStore.getState().sideWindows).toEqual([]);
    expect(useStore.getState().sessions["branch-1"]).toBeDefined();
  });
});
