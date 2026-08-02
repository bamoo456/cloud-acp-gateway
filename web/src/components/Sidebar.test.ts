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
  let getDiscoveredHistory: ReturnType<typeof vi.fn>;
  let searchSessions: ReturnType<typeof vi.fn>;
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
    getDiscoveredHistory = vi.fn().mockResolvedValue([]);
    searchSessions = vi.fn();
    openHistorySession = vi.fn();
    vi.doMock("../lib/api.ts", () => ({
      getHistory,
      getDiscoveredHistory,
      searchSessions,
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

  // 16 recents: one past RECENT_LIMIT, so the collapsed cut and "See more" are
  // both exercised. Only the newest and the one that falls off are named.
  function sixteenRecents() {
    return [
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      ...Array.from({ length: 14 }, (_, i) => ({
        agentName: "claude",
        cwd: "/repo",
        sessionId: `s-${i}`,
        title: `Filler conversation ${i}`,
        lastActiveAt: `2026-06-10T03:${String(58 - i).padStart(2, "0")}:00.000Z`,
      })),
      { agentName: "claude", cwd: "/repo", sessionId: "s-folder", title: "Folder browser polish", lastActiveAt: "2026-06-06T04:00:00.000Z" },
    ];
  }

  test("shows the latest RECENT_LIMIT sessions in a Recent section", async () => {
    await seedRecentSessions(sixteenRecents());
    await renderSidebar();

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    const rows = recent!.querySelectorAll(".sess-item");
    expect(rows).toHaveLength(15);
    expect(recent!.textContent).toContain("Cross folder work");
    expect(recent!.textContent).toContain("other-repo");
    expect(recent!.textContent).not.toContain("Folder browser polish");
  });

  test("reveals the rest of the recents when See more is clicked", async () => {
    await seedRecentSessions(sixteenRecents());
    await renderSidebar();

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    expect(recent!.querySelectorAll(".sess-item")).toHaveLength(15);
    expect(recent!.textContent).not.toContain("Folder browser polish");

    const seeMore = recent!.querySelector<HTMLButtonElement>(".see-more");
    expect(seeMore).not.toBeNull();
    await act(async () => {
      seeMore!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(recent!.querySelectorAll(".sess-item")).toHaveLength(16);
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

  test("folds discovered Claude CLI sessions into Recent (no separate section) and opens them with their recovered cwd", async () => {
    getDiscoveredHistory.mockResolvedValue([
      { agentName: "claude", cwd: "/already", sessionId: "already-recent", title: "Already recent CLI", updatedAt: "2026-06-10T03:59:00.000Z", source: "claude-cli" },
      { agentName: "claude", cwd: "/cli-repo", sessionId: "cli-only", title: "CLI only work", updatedAt: "2026-06-10T03:30:00.000Z", source: "claude-cli" },
    ]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/already", sessionId: "already-recent", title: "Already recent CLI", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();

    // No dedicated CLI section — discovered sessions ride in the Recent list.
    expect(container.querySelector(".cli-section")).toBeNull();
    expect(container.textContent).not.toContain("From Claude CLI");

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    const rows = recent!.querySelectorAll<HTMLButtonElement>(".sess-item");
    // One recent + one CLI-only session, interleaved by activity time; the CLI
    // copy of the existing recent is deduped away.
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Already recent CLI");
    expect(rows[1].textContent).toContain("CLI only work");
    expect(rows[1].textContent).toContain("cli-repo");

    await act(async () => {
      rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openHistorySession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "cli-only",
      title: "CLI only work",
      agentName: "claude",
      cwd: "/cli-repo",
    }));
  });

  // Discovery used to be gated on `kind === "claude"` here, so a codex session
  // was only ever reachable from the folder the console happened to be in. The
  // gateway now advertises the capability and the sidebar just reads it.
  test("discovers sessions for every agent the gateway marks discoverable, not just claude", async () => {
    document.body.querySelector("#acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "test-token",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/repo", kind: "claude", discover: true },
        { name: "codex", cwd: "/repo", kind: "codex", discover: true },
        { name: "opencode", cwd: "/repo", kind: "opencode", discover: false },
      ],
      fsRoot: "/",
    });
    await renderSidebar();

    expect(getDiscoveredHistory.mock.calls.map((c) => c[0]).sort()).toEqual(["claude", "codex"]);
  });

  // Older gateways don't send `discover` at all; absent must not read as false
  // for claude, whose discovery those gateways do support.
  test("falls back to the claude kind check when the gateway sends no discover flag", async () => {
    document.body.querySelector("#acpg-cfg")!.textContent = JSON.stringify({
      wsPath: "/acp",
      token: "test-token",
      defaultAgent: "claude",
      agents: [
        { name: "claude", cwd: "/repo", kind: "claude" },
        { name: "codex", cwd: "/repo", kind: "codex" },
      ],
      fsRoot: "/",
    });
    await renderSidebar();

    expect(getDiscoveredHistory.mock.calls.map((c) => c[0])).toEqual(["claude"]);
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

  test("pins running conversations in a stable Running section, out of the recency-sorted Recent list", async () => {
    // run-a is the most-recently-active recent, so an activity sort would float it
    // to the top; the Running section must instead follow the /running array order
    // (run-b first) so concurrent streams don't make the list flap.
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "run-a", title: "Task A", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "idle-1", title: "Idle One", lastActiveAt: "2026-06-10T03:00:00.000Z" },
    ]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
      jumpToTask: vi.fn(),
      runningTasks: [
        { agentName: "claude", sessionId: "run-b", state: "active", cwd: "/repo", title: "Task B" },
        { agentName: "claude", sessionId: "run-a", state: "active", cwd: "/repo", title: "Task A" },
      ],
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    const running = container.querySelector(".running-section");
    expect(running).not.toBeNull();
    expect(running!.textContent).toContain("Running");
    const runningRows = running!.querySelectorAll<HTMLButtonElement>(".sess-item");
    expect(runningRows).toHaveLength(2);
    // Stable start order (the /running array), NOT recency order.
    expect(runningRows[0].textContent).toContain("Task B");
    expect(runningRows[1].textContent).toContain("Task A");

    // The running session is deduped out of the plain Recent list below; only the
    // idle recent remains there.
    const recent = container.querySelector(".recent-section:not(.running-section)");
    expect(recent).not.toBeNull();
    expect(recent!.textContent).toContain("Idle One");
    expect(recent!.textContent).not.toContain("Task A");
  });

  test("keeps a just-finished session in Running (cooling) for the grace window, deduped from Recent", async () => {
    // run-a is no longer live (not in runningTasks) but was seen running 1 min ago
    // — inside the 2-min grace window — so it lingers in Running as "cooling".
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "run-a", title: "Task A", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "idle-1", title: "Idle One", lastActiveAt: "2026-06-10T03:00:00.000Z" },
    ]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
      jumpToTask: vi.fn(),
      runningTasks: [{ agentName: "claude", sessionId: "run-b", state: "active", cwd: "/repo", title: "Task B" }],
      runningSeen: {
        "claude\nrun-b": { task: { agentName: "claude", sessionId: "run-b", state: "active", cwd: "/repo", title: "Task B" }, at: now.getTime() },
        "claude\nrun-a": { task: { agentName: "claude", sessionId: "run-a", state: "active", cwd: "/repo", title: "Task A" }, at: now.getTime() - 60_000 },
      },
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    const running = container.querySelector(".running-section");
    expect(running).not.toBeNull();
    const rows = running!.querySelectorAll<HTMLButtonElement>(".sess-item");
    // Live task first, then the cooling one.
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Task B");
    expect(rows[1].textContent).toContain("Task A");
    // The live row spins; the cooling row shows a muted ring, not the spinner.
    expect(rows[0].querySelector(".run-working")).not.toBeNull();
    expect(rows[1].querySelector(".run-dot.cooling")).not.toBeNull();
    expect(rows[1].querySelector(".run-working")).toBeNull();

    // The cooling session is deduped out of the plain Recent list below.
    const recent = container.querySelector(".recent-section:not(.running-section)");
    expect(recent!.textContent).toContain("Idle One");
    expect(recent!.textContent).not.toContain("Task A");
  });

  test("drops a session from Running once it's been idle past the grace window", async () => {
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "run-a", title: "Task A", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);

    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
      jumpToTask: vi.fn(),
      runningTasks: [],
      // Seen running 3 minutes ago — past the 2-minute grace window.
      runningSeen: {
        "claude\nrun-a": { task: { agentName: "claude", sessionId: "run-a", state: "active", cwd: "/repo", title: "Task A" }, at: now.getTime() - 3 * 60_000 },
      },
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    // No Running section — it aged out — and the session reappears in plain Recent.
    expect(container.querySelector(".running-section")).toBeNull();
    const recent = container.querySelector(".recent-section:not(.running-section)");
    expect(recent!.textContent).toContain("Task A");
  });

  test("shows the Running section and suppresses the empty state when only running tasks exist", async () => {
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
      jumpToTask: vi.fn(),
      runningTasks: [{ agentName: "claude", sessionId: "only-run", state: "active", cwd: "/repo", title: "Only running" }],
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    expect(container.querySelector(".running-section")).not.toBeNull();
    expect(container.textContent).toContain("Only running");
    expect(container.textContent).not.toContain("No recent conversations yet.");
  });

  test("clicking a running task jumps to it and closes the panel", async () => {
    const jumpToTask = vi.fn();
    const onClose = vi.fn();
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
      jumpToTask,
      runningTasks: [{ agentName: "claude", sessionId: "run-x", state: "active", cwd: "/repo", title: "Jumpable" }],
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose, onOpenPicker: vi.fn() }));
      await flush();
    });

    const row = container.querySelector<HTMLButtonElement>(".running-section .sess-item");
    expect(row).not.toBeNull();
    await act(async () => { row!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(jumpToTask).toHaveBeenCalledWith(expect.objectContaining({ agentName: "claude", sessionId: "run-x" }));
    expect(onClose).toHaveBeenCalled();
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

  // The one search box drives two tiers: the instant local title filter (above)
  // and the debounced server content search (below).
  async function typeInSearchBox(text: string) {
    const box = container.querySelector<HTMLInputElement>(".search input")!;
    await act(async () => {
      // go through the native setter so React's value tracker sees the change
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });
  }

  test("typing in the Conversations search box also queries the server", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await clickConversationsTab();

    await typeInSearchBox("liquid");

    // Default filters send no bounds: the server's own 14-day default applies.
    expect(searchSessions).toHaveBeenCalledWith("liquid", {});
  });

  // Every keystroke re-arms the debounce, so the half-typed prefixes must never
  // reach the network — only the term the user stopped on.
  test("keystrokes inside the debounce window coalesce into one query", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await clickConversationsTab();

    const box = container.querySelector<HTMLInputElement>(".search input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const term of ["li", "liq", "liquid"]) {
      await act(async () => {
        setValue.call(box, term);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { vi.advanceTimersByTime(100); });
    }
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });

    expect(searchSessions).toHaveBeenCalledTimes(1);
    expect(searchSessions).toHaveBeenCalledWith("liquid", {});
  });

  test("a one-character query does not reach the server", async () => {
    await renderSidebar();
    await clickConversationsTab();

    await typeInSearchBox("l");

    expect(searchSessions).not.toHaveBeenCalled();
  });

  test("narrowing the query back below two characters clears the results and the spinner", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await clickConversationsTab();

    await typeInSearchBox("liquid");
    expect(container.textContent).toContain("No messages match.");

    await typeInSearchBox("l");
    // Neither the previous answer nor a spinner stranded by the early return.
    expect(container.textContent).not.toContain("No messages match.");
    expect(container.textContent).not.toContain("Searching…");
  });

  test("opening a content hit opens the conversation at the matched message", async () => {
    searchSessions.mockResolvedValue({
      results: [{
        sessionId: "hit-1", source: "claude-cli", agentName: "claude", cwd: "/repo",
        title: "Liquid glass timeline", updatedAt: "2026-06-10T03:00:00.000Z", hitCount: 1,
        hits: [{ index: 42, role: "user", snippet: "make it liquid", offsets: [[8, 14]] }],
      }],
      truncated: false, cursor: null, skipped: [], scanned: { files: 1, bytes: 1, ms: 1 },
    });
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");

    const hit = container.querySelector<HTMLButtonElement>(".search-hit");
    expect(hit).not.toBeNull();
    await act(async () => { hit!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(openHistorySession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "hit-1", agentName: "claude", cwd: "/repo", atMessage: 42,
    }));
  });

  test("an advanced filter re-runs the search with the narrowed options", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");

    const folderOnly = container.querySelectorAll<HTMLInputElement>(".search-filters input[type=checkbox]")[0];
    expect(folderOnly).toBeDefined();
    await act(async () => { folderOnly.click(); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });

    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { cwd: "/repo" });
  });

  // The panel doesn't unmount on close (desktop keeps it mounted as a column), so
  // the filters have to be dropped explicitly — a narrowed scope that silently
  // survives into the next search is the thing we refused to persist at all.
  test("reopening the panel drops the advanced filters", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    const folderOnly = () => container.querySelectorAll<HTMLInputElement>(".search-filters input[type=checkbox]")[0];
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");
    await act(async () => { folderOnly().click(); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });
    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { cwd: "/repo" });

    const { Sidebar } = await import("./Sidebar.tsx");
    for (const open of [false, true]) {
      await act(async () => {
        root!.render(React.createElement(Sidebar, { open, onClose: vi.fn(), onOpenPicker: vi.fn() }));
        await flush();
      });
    }
    await clickConversationsTab();

    expect(folderOnly().checked).toBe(false);
  });

  // A truncated response is the only way the resume cursor is ever reachable, so
  // both escape buttons need coverage: without it, swapping or deleting either
  // handler passes the whole suite.
  const truncatedPage = (over: Record<string, unknown> = {}) => ({
    results: [{
      sessionId: "hit-1", source: "claude-cli", agentName: "claude", cwd: "/repo",
      title: "Liquid glass timeline", updatedAt: "2026-06-10T03:00:00.000Z", hitCount: 1,
      hits: [{ index: 42, role: "user", snippet: "make it liquid", offsets: [[8, 14]] }],
    }],
    truncated: true, cursor: "cursor-1", skipped: [], scanned: { files: 1, bytes: 1, ms: 1 },
    ...over,
  });
  const clickWindowChip = async (label: string) => {
    const chip = Array.from(container.querySelectorAll<HTMLButtonElement>(".search-filters .chip"))
      .find((b) => b.textContent === label)!;
    expect(chip).toBeDefined();
    await act(async () => { chip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });
  };
  const clickSearchMore = async () => {
    const more = container.querySelector<HTMLButtonElement>(".search-more");
    expect(more).not.toBeNull();
    await act(async () => { more!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); await flush(); });
    return more!;
  };

  test("a truncated default search offers to widen the window to everything", async () => {
    searchSessions.mockResolvedValue(truncatedPage());
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");

    expect(container.querySelector(".search-more")!.textContent).toBe("搜尋全部");
    await clickSearchMore();

    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { all: true });
  });

  // Truncation inside the widest possible window can only be escaped by resuming
  // from the cursor — there is nothing left to widen to.
  test("a truncated all-window search resumes from the cursor instead of re-running", async () => {
    searchSessions.mockResolvedValue(truncatedPage());
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");
    await clickWindowChip("全部");

    expect(container.querySelector(".search-more")!.textContent).toBe("繼續搜更早");
    searchSessions.mockResolvedValue(truncatedPage({
      results: [{
        sessionId: "hit-2", source: "claude-cli", agentName: "claude", cwd: "/repo",
        title: "Older liquid work", updatedAt: "2026-05-01T00:00:00.000Z", hitCount: 1,
        hits: [{ index: 7, role: "user", snippet: "still liquid", offsets: [[6, 12]] }],
      }],
      truncated: false, cursor: null,
    }));
    await clickSearchMore();

    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { all: true, cursor: "cursor-1" });
    // The resumed page appends; it does not replace what was already on screen.
    expect(container.textContent).toContain("Liquid glass timeline");
    expect(container.textContent).toContain("Older liquid work");
  });

  test("a resumed page that lands after the query was erased is discarded", async () => {
    searchSessions.mockResolvedValue(truncatedPage());
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");
    await clickWindowChip("全部");

    // Hold page 2 open, click 繼續搜更早, then erase the query underneath it.
    let releasePage2!: (v: unknown) => void;
    searchSessions.mockReturnValue(new Promise((r) => { releasePage2 = r; }));
    const more = container.querySelector<HTMLButtonElement>(".search-more")!;
    await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await typeInSearchBox("l");
    expect(container.querySelector(".search-hit")).toBeNull();

    await act(async () => {
      releasePage2(truncatedPage({ truncated: false, cursor: null }));
      await flush(); await flush(); await flush();
    });

    // The stale page must not resurrect results under a one-character query.
    expect(container.querySelector(".search-hit")).toBeNull();
    expect(container.textContent).not.toContain("Searching…");
  });

  test("a resumed page that lands after a newer query cannot overwrite it", async () => {
    searchSessions.mockResolvedValue(truncatedPage());
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");
    await clickWindowChip("全部");

    let releasePage2!: (v: unknown) => void;
    searchSessions.mockReturnValue(new Promise((r) => { releasePage2 = r; }));
    const more = container.querySelector<HTMLButtonElement>(".search-more")!;
    await act(async () => { more.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // A new term resolves while page 2 is still scanning.
    searchSessions.mockResolvedValue(truncatedPage({
      results: [{
        sessionId: "hit-3", source: "claude-cli", agentName: "claude", cwd: "/repo",
        title: "Widget work", updatedAt: "2026-06-01T00:00:00.000Z", hitCount: 1,
        hits: [{ index: 3, role: "user", snippet: "the widget", offsets: [[4, 10]] }],
      }],
      truncated: false, cursor: null,
    }));
    await typeInSearchBox("widget");
    expect(container.textContent).toContain("Widget work");

    await act(async () => {
      releasePage2(truncatedPage({ truncated: false, cursor: null }));
      await flush(); await flush(); await flush();
    });

    expect(container.textContent).toContain("Widget work");
    expect(container.textContent).not.toContain("Liquid glass timeline");
  });

  // The default window is the server's own 14 days, so a term older than that
  // answers "No messages match." with nothing truncated — no escape would be
  // offered at all. The window is a scan budget, not a corpus boundary.
  test("a zero-result default search offers to widen the window to everything", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");

    expect(container.textContent).toContain("No messages match.");
    expect(container.querySelector(".search-more")!.textContent).toBe("搜尋全部");
    await clickSearchMore();

    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { all: true });
  });

  // A content search reads transcripts off disk. Only the Conversations tab
  // renders its results, so a folder change with that tab hidden must not spend
  // a full scan on a term nobody can see.
  test("changing folders with the Conversations tab hidden does not scan", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await clickConversationsTab();
    await typeInSearchBox("liquid");
    expect(searchSessions).toHaveBeenCalledTimes(1);

    const recentTab = container.querySelector<HTMLButtonElement>('[data-tab="recent"]')!;
    await act(async () => { recentTab.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ cwd: "/other-repo" } as any); await flush(); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });

    expect(searchSessions).toHaveBeenCalledTimes(1);
  });

  // The local title filter and the server content search share one box and one
  // column, so their empty states must not contradict each other on screen.
  test("the local empty state stays hidden while server results are showing", async () => {
    searchSessions.mockResolvedValue({
      results: [{
        sessionId: "hit-1", source: "claude-cli", agentName: "claude", cwd: "/elsewhere",
        title: "Liquid glass timeline", updatedAt: "2026-06-10T03:00:00.000Z", hitCount: 1,
        hits: [{ index: 42, role: "user", snippet: "make it liquid", offsets: [[8, 14]] }],
      }],
      truncated: false, cursor: null, skipped: [], scanned: { files: 1, bytes: 1, ms: 1 },
    });
    await renderSidebar();
    await clickConversationsTab();
    // No local title matches "liquid" — the title filter's own list is empty.
    await typeInSearchBox("liquid");

    expect(container.textContent).toContain("Liquid glass timeline");
    expect(container.textContent).not.toContain("No conversations in this folder yet.");
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
