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

  test("renders nothing unless the branch is open, its parent is active, and its session is live", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      sessions: { "parent-1": makeSession("parent-1", "Parent") },
      branch: null,
    });
    await render();
    expect(container.querySelector(".branch-win")).toBeNull();

    // The branch exists, but a different conversation is on screen — the
    // window follows its parent, so it stays hidden rather than closing.
    act(() => {
      useStore.setState({
        sessions: {
          "parent-1": makeSession("parent-1", "Parent"),
          "branch-1": makeSession("branch-1", "Parent (Branch)"),
        },
        branch: { parentId: "parent-1", sessionId: "branch-1" },
        activeId: "other",
      });
    });
    expect(container.querySelector(".branch-win")).toBeNull();

    // Back on the parent, but the branch's own live session has been evicted.
    act(() => {
      useStore.setState((st) => {
        const sessions = { ...st.sessions };
        delete sessions["branch-1"];
        return { sessions, activeId: "parent-1" };
      });
    });
    expect(container.querySelector(".branch-win")).toBeNull();
  });

  test("renders the branch's thread and its own composer once branch, parent and session line up", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
      },
      branch: { parentId: "parent-1", sessionId: "branch-1" },
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
      branch: { parentId: "parent-1", sessionId: "pending-x" },
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
        return { sessions, branch: { parentId: "parent-1", sessionId: "branch-1" } };
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
        branch: { parentId: "parent-2", sessionId: "branch-1" },
      }));
    });
    expect(container.querySelector<HTMLElement>(".branch-win")!.style.left).toBe("");
  });

  test("the close button forgets the pairing but leaves the branch session live", async () => {
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      activeId: "parent-1",
      agentReady: true,
      sessions: {
        "parent-1": makeSession("parent-1", "Parent"),
        "branch-1": makeSession("branch-1", "Parent (Branch)"),
      },
      branch: { parentId: "parent-1", sessionId: "branch-1" },
    });
    await render();

    const closeBtn = container.querySelector<HTMLButtonElement>(".branch-win-head button");
    expect(closeBtn).not.toBeNull();
    await act(async () => { closeBtn!.click(); });

    expect(useStore.getState().branch).toBeNull();
    expect(useStore.getState().sessions["branch-1"]).toBeDefined();
  });
});
