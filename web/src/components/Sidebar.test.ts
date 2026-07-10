import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { HistorySession } from "../lib/api.ts";

const now = new Date("2026-06-10T04:00:00.000Z");

// Recents live on the gateway now, hydrated into an in-memory cache the store
// reads at init. Seed that cache (fresh per test under resetModules) before
// importing the store/Sidebar.
async function seedRecentSessions(list: Array<Record<string, string>>) {
  const { hydrateRecentSessions } = await import("../lib/recentSessions.ts");
  hydrateRecentSessions(list);
}

const historyItems: HistorySession[] = [
  { sessionId: "s-recent", title: "Recent conversation sidebar", updatedAt: "2026-06-10T03:58:00.000Z" },
  { sessionId: "s-busy", title: "Fix session scoped busy state", updatedAt: "2026-06-10T03:00:00.000Z" },
  { sessionId: "s-perms", title: "Pending permission notifications", updatedAt: "2026-06-09T04:00:00.000Z" },
  { sessionId: "s-text", title: "Text size preference menu", updatedAt: "2026-06-08T04:00:00.000Z" },
  { sessionId: "s-share", title: "Share link deep-link testing", updatedAt: "2026-06-07T04:00:00.000Z" },
  { sessionId: "s-folder", title: "Folder browser polish", updatedAt: "2026-06-06T04:00:00.000Z" },
];

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Sidebar recent conversations", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getHistory: ReturnType<typeof vi.fn>;
  let openHistorySession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(now);
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
    localStorage.clear();
    getHistory = vi.fn().mockResolvedValue(historyItems);
    openHistorySession = vi.fn();
    vi.doMock("../lib/api.ts", () => ({
      getHistory,
      getMessages: vi.fn(),
      renameSession: vi.fn(),
      listDir: vi.fn(),
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderSidebar() {
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "claude",
      cwd: "/repo",
      agentReady: true,
      sessions: {
        "s-recent": { ...makeSession("s-recent"), title: "Recent conversation sidebar" },
      },
      activeId: "s-recent",
      openHistorySession,
      newSession: vi.fn(),
      historyNonce: 0,
    } as any);

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });
  }

  async function clickConversationsTab() {
    const tabBtn = container.querySelector<HTMLButtonElement>('[data-tab="conversations"]');
    expect(tabBtn).not.toBeNull();
    await act(async () => { tabBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  }

  test("shows the latest five sessions in a Recent section", async () => {
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-busy", title: "Fix session scoped busy state", lastActiveAt: "2026-06-10T03:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-perms", title: "Pending permission notifications", lastActiveAt: "2026-06-09T04:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-text", title: "Text size preference menu", lastActiveAt: "2026-06-08T04:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-share", title: "Share link deep-link testing", lastActiveAt: "2026-06-07T04:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-folder", title: "Folder browser polish", lastActiveAt: "2026-06-06T04:00:00.000Z" },
    ]);
    await renderSidebar();

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    const rows = recent!.querySelectorAll(".sess-item");
    expect(rows).toHaveLength(5);
    expect(recent!.textContent).toContain("Cross folder work");
    expect(recent!.textContent).toContain("other-repo");
    expect(recent!.textContent).toContain("Share link deep-link testing");
    expect(recent!.textContent).not.toContain("Folder browser polish");
  });

  test("reveals the rest of the recents when See more is clicked", async () => {
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-busy", title: "Fix session scoped busy state", lastActiveAt: "2026-06-10T03:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-perms", title: "Pending permission notifications", lastActiveAt: "2026-06-09T04:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-text", title: "Text size preference menu", lastActiveAt: "2026-06-08T04:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-share", title: "Share link deep-link testing", lastActiveAt: "2026-06-07T04:00:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-folder", title: "Folder browser polish", lastActiveAt: "2026-06-06T04:00:00.000Z" },
    ]);
    await renderSidebar();

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    expect(recent!.querySelectorAll(".sess-item")).toHaveLength(5);
    expect(recent!.textContent).not.toContain("Folder browser polish");

    const seeMore = recent!.querySelector<HTMLButtonElement>(".see-more");
    expect(seeMore).not.toBeNull();
    await act(async () => {
      seeMore!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(recent!.querySelectorAll(".sess-item")).toHaveLength(6);
    expect(recent!.textContent).toContain("Folder browser polish");
    expect(recent!.textContent).toContain("Show less");
  });

  test("a current-folder recent mirrors the Conversations title, not its stale cached one", async () => {
    // s-busy carries a stale, slash-command-derived title in localStorage, while
    // the gateway history serves the real (renamed) title. The two lists must agree.
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "s-busy", title: "<local-command-caveat>do the thing", lastActiveAt: "2026-06-10T03:00:00.000Z" },
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    // The gateway title wins for the current-folder session…
    expect(recent!.textContent).toContain("Fix session scoped busy state");
    expect(recent!.textContent).not.toContain("<local-command-caveat>");
    // …but a recent entry from another folder keeps its own cached title.
    expect(recent!.textContent).toContain("Cross folder work");
  });

  test("limits Conversations to the last two days until See more is clicked", async () => {
    await renderSidebar();
    await clickConversationsTab();

    const conversations = container.querySelector(".all-section");
    expect(conversations).not.toBeNull();
    expect(conversations!.textContent).toContain("Text size preference menu");
    expect(conversations!.textContent).not.toContain("Share link deep-link testing");
    expect(conversations!.textContent).toContain("See more");

    const seeMore = conversations!.querySelector<HTMLButtonElement>(".see-more");
    expect(seeMore).not.toBeNull();
    await act(async () => {
      seeMore!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(conversations!.textContent).toContain("Share link deep-link testing");
    expect(conversations!.textContent).toContain("Folder browser polish");
    expect(conversations!.textContent).toContain("Show recent only");
  });

  test("opens a recent conversation without bumping recent activity", async () => {
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();

    const recentRows = container.querySelectorAll<HTMLButtonElement>(".recent-section .sess-item");
    await act(async () => {
      recentRows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openHistorySession).not.toHaveBeenCalled();
    const { useStore } = await import("../store/store.ts");
    expect(useStore.getState().recentSessions[0].lastActiveAt).toBe("2026-06-10T03:59:00.000Z");
  });

  test("hides history for agents without gateway history support", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "test-token",
      defaultAgent: "gemini",
      agents: [{ name: "gemini", cwd: "/repo", history: false }],
      fsRoot: "/",
    });
    await seedRecentSessions([
      { agentName: "gemini", cwd: "/repo", sessionId: "g1", title: "Gemini recent work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "gemini",
      cwd: "/repo",
      agentReady: true,
      sessions: {},
      activeId: null,
      openHistorySession,
      newSession: vi.fn(),
      historyNonce: 0,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    expect(getHistory).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Conversation history isn't available for this agent.");
    expect(container.querySelector(".search")).toBeNull();
    expect(container.querySelector(".recent-section")).toBeNull();
    expect(container.textContent).not.toContain("Gemini recent work");
  });

  test("hides local recent sessions for agents without session/load support", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "test-token",
      defaultAgent: "codex",
      agents: [{ name: "codex", cwd: "/repo", history: true, sessionLoad: false }],
      fsRoot: "/",
    });
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "codex", cwd: "/repo", sessionId: "live-codex", title: "Live Codex work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "codex",
      cwd: "/repo",
      agentReady: true,
      sessions: {},
      activeId: null,
      openHistorySession,
      newSession: vi.fn(),
      historyNonce: 0,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    await clickConversationsTab();
    expect(getHistory).toHaveBeenCalledWith("codex", "/repo");
    expect(container.querySelector(".recent-section")).toBeNull();
    expect(container.textContent).not.toContain("Live Codex work");
    expect(container.textContent).toContain("No conversations in this folder yet.");
  });

  test("shows in-memory current sessions for agents without session/load support", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "test-token",
      defaultAgent: "codex",
      agents: [{ name: "codex", cwd: "/repo", history: true, sessionLoad: false }],
      fsRoot: "/",
    });
    getHistory.mockResolvedValue([]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "codex",
      cwd: "/repo",
      agentReady: true,
      sessions: {
        "live-codex": { ...makeSession("live-codex"), title: "Live Codex work", hasContent: true },
      },
      activeId: "live-codex",
      openHistorySession,
      newSession: vi.fn(),
      historyNonce: 0,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    const current = container.querySelector(".current-section");
    expect(current).not.toBeNull();
    expect(current!.textContent).toContain("Current");
    expect(current!.textContent).toContain("Live Codex work");
    expect(openHistorySession).not.toHaveBeenCalled();
  });

  test("marks a running conversation with a pulsing dot", async () => {
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "claude",
      cwd: "/repo",
      agentReady: true,
      sessions: { "s-recent": { ...makeSession("s-recent"), title: "Recent conversation sidebar" } },
      activeId: "s-recent",
      openHistorySession,
      newSession: vi.fn(),
      historyNonce: 0,
      // s-busy is running on this agent; s-perms (and others) are idle.
      runningTasks: [{ agentName: "claude", sessionId: "s-busy", state: "awaiting-input", cwd: "/repo" }],
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    await clickConversationsTab();
    const dots = container.querySelectorAll(".run-dot");
    expect(dots.length).toBe(1);
    expect(dots[0].classList.contains("awaiting")).toBe(true);
    // The dot sits on the running conversation's row.
    const busyRow = Array.from(container.querySelectorAll(".sess-item")).find((el) => el.textContent?.includes("Fix session scoped busy state"));
    expect(busyRow?.querySelector(".run-dot")).not.toBeNull();
  });

  test("merges Recent across agents and marks each row with its agent glyph", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp", token: "test-token", defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/repo" },
        { name: "codex", cwd: "/repo", skin: "codex", history: true, sessionLoad: true },
      ],
      fsRoot: "/",
    });
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "codex", cwd: "/repo", sessionId: "cx1", title: "Codex thread", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "cl1", title: "Claude thread", lastActiveAt: "2026-06-10T03:00:00.000Z" },
    ]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    // Both agents' recents are listed in one place, newest first.
    expect(recent!.textContent).toContain("Codex thread");
    expect(recent!.textContent).toContain("Claude thread");
    // …each carrying its owning agent's mark, even when it isn't the active one.
    expect(recent!.querySelector(".mark.codex")).not.toBeNull();
    expect(recent!.querySelector(".mark.claude")).not.toBeNull();
  });

  test("merges Conversations across every history-capable agent for the folder", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp", token: "test-token", defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/repo" },
        { name: "codex", cwd: "/repo", skin: "codex", history: true, sessionLoad: false },
      ],
      fsRoot: "/",
    });
    getHistory.mockImplementation((agent: string) => Promise.resolve(
      agent === "claude"
        ? [{ sessionId: "cl-conv", title: "Claude conversation", updatedAt: "2026-06-10T03:58:00.000Z" }]
        : [{ sessionId: "cx-conv", title: "Codex conversation", updatedAt: "2026-06-10T03:30:00.000Z" }],
    ));

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    await clickConversationsTab();
    expect(getHistory).toHaveBeenCalledWith("claude", "/repo");
    expect(getHistory).toHaveBeenCalledWith("codex", "/repo");
    const all = container.querySelector(".all-section");
    expect(all!.textContent).toContain("Claude conversation");
    expect(all!.textContent).toContain("Codex conversation");
  });

  test("clicking a foreign-agent conversation opens it under its own agent", async () => {
    document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp", token: "test-token", defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/repo" },
        { name: "codex", cwd: "/repo", skin: "codex", history: true, sessionLoad: false },
      ],
      fsRoot: "/",
    });
    getHistory.mockImplementation((agent: string) => Promise.resolve(
      agent === "codex"
        ? [{ sessionId: "cx-conv", title: "Codex conversation", updatedAt: "2026-06-10T03:30:00.000Z" }]
        : [],
    ));

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    await clickConversationsTab();
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".all-section .sess-item"))
      .find((el) => el.textContent?.includes("Codex conversation"));
    expect(row).toBeDefined();
    await act(async () => { row!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(openHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "cx-conv", agentName: "codex", cwd: "/repo" }),
    );
  });

  test("folder bar opens the folder picker and closes the overlay panel", async () => {
    const { Sidebar } = await import("./Sidebar.tsx");
    const onOpenPicker = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose, onOpenPicker }));
      await flush();
    });
    const bar = container.querySelector<HTMLElement>(".folder-bar");
    await act(async () => { bar?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onOpenPicker).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test("defaults to the Recent tab and hides the Conversations list", async () => {
    await renderSidebar();
    const recentTab = container.querySelector('[data-tab="recent"]');
    const convTab = container.querySelector('[data-tab="conversations"]');
    expect(recentTab?.getAttribute("aria-selected")).toBe("true");
    expect(convTab?.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector(".all-section")).toBeNull();
  });

  test("shows the search box only on the Conversations tab", async () => {
    await renderSidebar();
    expect(container.querySelector(".search")).toBeNull();
    await clickConversationsTab();
    expect(container.querySelector(".search")).not.toBeNull();
  });

  test("has no New chat button inside the panel", async () => {
    await renderSidebar();
    expect(container.querySelector(".list-new")).toBeNull();
  });

  test("an empty Recent tab shows its empty state and does not fall back to Conversations", async () => {
    await renderSidebar();
    const recentTab = container.querySelector('[data-tab="recent"]');
    expect(recentTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("No recent conversations yet.");
    expect(container.querySelector(".all-section")).toBeNull();
    expect(container.querySelector(".search")).toBeNull();
  });

  test("reopening the panel resets to the Recent tab", async () => {
    await renderSidebar();
    await clickConversationsTab();
    expect(container.querySelector('[data-tab="conversations"]')?.getAttribute("aria-selected")).toBe("true");
    const { Sidebar } = await import("./Sidebar.tsx");
    await act(async () => {
      root!.render(React.createElement(Sidebar, { open: false, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });
    await act(async () => {
      root!.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });
    expect(container.querySelector('[data-tab="recent"]')?.getAttribute("aria-selected")).toBe("true");
  });
});
