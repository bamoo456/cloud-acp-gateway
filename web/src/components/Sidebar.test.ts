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

// The view is read once, on mount (useState(readSessionsView)), so a test whose
// SUBJECT is something other than the view switcher itself should seed the
// preference before rendering rather than clicking through the menu — that
// keeps the test's subject the thing it is actually testing.
function seedLatestView() {
  localStorage.setItem("acpg.sessionsView", "latest");
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
      toggleHiddenFolder: vi.fn().mockResolvedValue([]),
      togglePinnedSession: vi.fn().mockResolvedValue([]),
      toggleArchivedSession: vi.fn().mockResolvedValue([]),
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

  // The click-through path, for the handful of tests whose subject IS the
  // view switcher itself. Everything else should call seedLatestView() before
  // rendering instead (see its own comment).
  async function showLatestView() {
    const viewBtn = container.querySelector<HTMLButtonElement>(".view-btn");
    expect(viewBtn).not.toBeNull();
    await act(async () => { viewBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const latestItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".view-item"))
      .find((b) => b.textContent?.includes("Latest updated"));
    expect(latestItem).not.toBeUndefined();
    await act(async () => { latestItem!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
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
    // Isolated from current-folder history, which now shares this same list:
    // this test's subject is the recents-cache cap, not the merge.
    getHistory.mockResolvedValue([]);
    seedLatestView();
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
    getHistory.mockResolvedValue([]);
    seedLatestView();
    await seedRecentSessions(sixteenRecents());
    await renderSidebar();

    // All 15 visible recents are within the hour, so only "Last hour" renders —
    // "Folder browser polish" (from 2026-06-06) is both past RECENT_LIMIT and,
    // once revealed, old enough to land in "Earlier" instead.
    const sections = () => container.querySelectorAll(".recent-section:not(.running-section)");
    expect(sections()).toHaveLength(1);
    expect(sections()[0].querySelectorAll(".sess-item")).toHaveLength(15);
    expect(container.textContent).not.toContain("Folder browser polish");

    // .see-more is a sibling of .recent-section, not nested inside it.
    const seeMore = container.querySelector<HTMLButtonElement>(".see-more");
    expect(seeMore).not.toBeNull();
    await act(async () => {
      seeMore!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Earlier");
    expect(container.textContent).toContain("Folder browser polish");
    const allRows = container.querySelectorAll(".recent-section:not(.running-section) .sess-item");
    expect(allRows).toHaveLength(16);
    expect(container.textContent).toContain("Show less");
  });

  test("a current-folder recent mirrors the Conversations title, not its stale cached one", async () => {
    // s-busy carries a stale, slash-command-derived title in localStorage, while
    // the gateway history serves the real (renamed) title. The two lists must agree.
    seedLatestView();
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
    // …and an entry no fetched list covers (another folder, discovery empty here)
    // falls back to its cached title.
    expect(recent!.textContent).toContain("Cross folder work");
  });

  test("a renamed conversation in another folder shows the gateway's title, not the cached one", async () => {
    // The rename was made from another device/folder, so this browser's recents row
    // still holds the title from when it last touched the conversation. Discovery
    // spans folders and carries renames, so it — not the snapshot — is the answer.
    seedLatestView();
    getDiscoveredHistory.mockResolvedValue([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "My renamed chat", updatedAt: "2026-06-10T03:59:00.000Z", source: "claude-cli" },
    ]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "the first prompt it ever saw", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();

    const recent = container.querySelector(".recent-section");
    expect(recent).not.toBeNull();
    // Still ONE row — the recents row, retitled, not a second discovered copy.
    const row = recent!.querySelector(".sess-item");
    expect(row!.textContent).toContain("My renamed chat");
    expect(recent!.textContent).not.toContain("the first prompt it ever saw");
  });

  test("folds discovered Claude CLI sessions into Recent (no separate section) and opens them with their recovered cwd", async () => {
    getHistory.mockResolvedValue([]);
    seedLatestView();
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

  test("limits current-folder history to the last two days until See more is clicked", async () => {
    await renderSidebar();

    expect(container.textContent).toContain("Text size preference menu");
    expect(container.textContent).not.toContain("Share link deep-link testing");
    expect(container.textContent).toContain("See more");

    const seeMore = container.querySelector<HTMLButtonElement>(".see-more");
    expect(seeMore).not.toBeNull();
    await act(async () => {
      seeMore!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Share link deep-link testing");
    expect(container.textContent).toContain("Folder browser polish");
    expect(container.textContent).toContain("Show less");
  });

  test("opens a recent conversation without bumping recent activity", async () => {
    seedLatestView();
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

    expect(getHistory).toHaveBeenCalledWith("codex", "/repo");
    expect(container.querySelector(".sess-item")).toBeNull();
    expect(container.textContent).not.toContain("Live Codex work");
    // history is empty and recents are hidden, so nothing feeds the merged
    // list — the non-search empty state applies, not the search one.
    expect(container.textContent).toContain("No recent conversations yet.");
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

    // No dedicated "Current" section any more — the in-memory fallback session
    // rides in the same merged list as everything else (lowest merge priority).
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"))
      .find((el) => el.textContent?.includes("Live Codex work"));
    expect(row).not.toBeUndefined();
    expect(openHistorySession).not.toHaveBeenCalled();
  });

  // Several conversations are open in memory at once; only the one the main view
  // is showing may wear the marker. Marking every open session (what the row
  // renderers used to do) is indistinguishable from marking none.
  test("marks only the conversation the main view is showing, not every open session", async () => {
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "s-recent", title: "Recent conversation sidebar", lastActiveAt: "2026-06-10T03:58:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "s-busy", title: "Fix session scoped busy state", lastActiveAt: "2026-06-10T03:00:00.000Z" },
    ]);
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "claude",
      cwd: "/repo",
      agentReady: true,
      // Both open and neither view-only — s-busy is a background session.
      sessions: {
        "s-recent": { ...makeSession("s-recent"), title: "Recent conversation sidebar" },
        "s-busy": { ...makeSession("s-busy"), title: "Fix session scoped busy state" },
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

    const marked = container.querySelectorAll(".sess-item.active");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain("Recent conversation sidebar");
    expect(marked[0].getAttribute("aria-current")).toBe("true");

    // Same after switching views — a view change regroups the same rows, and
    // must not duplicate or drop the marker while doing it.
    await showLatestView();
    const markedAll = container.querySelectorAll(".sess-item.active");
    expect(markedAll).toHaveLength(1);
    expect(markedAll[0].textContent).toContain("Recent conversation sidebar");
  });

  test("marks a running conversation with a pulsing dot", async () => {
    // Folder view also puts an aggregated dot on the folder header itself;
    // latest view keeps this test to the one dot on the row.
    seedLatestView();
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
    seedLatestView();
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

  // KNOWN FAILING — encodes intended behavior, not a stale assertion. Sidebar.tsx:531
  // pushes cooling tasks with running=false, so sessionGroups.ts's latestWithPinned
  // (pins only needsYou||running) drops the cooling row out of .running-section and
  // into the plain recency list — contradicting Sidebar.tsx's own comment a few lines
  // up ("Keeping both [active and cooling] OUT of the recency-sorted list below").
  // See the task report for the fix pointer; do not weaken this test to hide it.
  test("keeps a just-finished session in Running (cooling) for the grace window, deduped from Recent", async () => {
    // run-a is no longer live (not in runningTasks) but was seen running 1 min ago
    // — inside the 2-min grace window — so it lingers in Running as "cooling".
    seedLatestView();
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
    seedLatestView();
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
    seedLatestView();
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

  test("a working conversation shows the renamed title, not the first-prompt label", async () => {
    // Everything the Running row could otherwise draw on is a snapshot from before
    // the rename: the recents row is what the conversation was called when last
    // touched, and the /running label is the text of its first prompt, captured
    // once by the gateway. The rename landed in the titles sidecar, which only the
    // listings read back — so the fetched list has to reach the Running row, and a
    // working conversation is drawn ONLY there (it's excluded from Recent below).
    seedLatestView();
    getHistory.mockResolvedValue([
      { sessionId: "run-r", title: "My renamed chat", updatedAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "run-r", title: "old name", lastActiveAt: "2026-06-10T03:00:00.000Z" },
    ]);
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: {}, activeId: null, openHistorySession, newSession: vi.fn(), historyNonce: 0,
      jumpToTask: vi.fn(),
      runningTasks: [{ agentName: "claude", sessionId: "run-r", state: "active", cwd: "/repo", title: "fix the flaky test please" }],
    } as any);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });

    const running = container.querySelector(".running-section");
    expect(running!.textContent).toContain("My renamed chat");
    expect(running!.textContent).not.toContain("old name");
    expect(running!.textContent).not.toContain("fix the flaky test please");
  });

  test("clicking a running task jumps to it and closes the panel", async () => {
    seedLatestView();
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
    seedLatestView();
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

  test("merges current-folder history across every history-capable agent", async () => {
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

    expect(getHistory).toHaveBeenCalledWith("claude", "/repo");
    expect(getHistory).toHaveBeenCalledWith("codex", "/repo");
    expect(container.textContent).toContain("Claude conversation");
    expect(container.textContent).toContain("Codex conversation");
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

    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"))
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

  test("defaults to the folder view and hides the search results list", async () => {
    await renderSidebar();
    expect(container.querySelector(".view-btn .vlabel")?.textContent).toBe("folder");
    expect(container.querySelector(".folder-group")).not.toBeNull();
    expect(container.querySelector(".all-section")).toBeNull();
  });

  test("shows the search box in both views", async () => {
    await renderSidebar();
    expect(container.querySelector(".search")).not.toBeNull();
    await showLatestView();
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

  test("typing in the search box also queries the server", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();

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

  test("the clear button drops the term and hands the panel back to the list", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    // Absent with an empty box: nothing to clear.
    expect(container.querySelector(".search-clear")).toBeNull();

    await typeInSearchBox("liquid");
    const clear = container.querySelector<HTMLButtonElement>(".search-clear")!;
    expect(clear).not.toBeNull();

    await act(async () => { clear.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });

    expect(container.querySelector<HTMLInputElement>(".search input")!.value).toBe("");
    expect(container.querySelector(".search-clear")).toBeNull();
    // The results list gives way to the sessions list again.
    expect(container.querySelector(".sb-head")).not.toBeNull();
  });

  test("a one-character query does not reach the server", async () => {
    await renderSidebar();

    await typeInSearchBox("l");

    expect(searchSessions).not.toHaveBeenCalled();
  });

  test("narrowing the query back below two characters clears the results and the spinner", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();

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

    // The reopen dropped the query along with the filters (same rationale), so
    // the filters only re-mount once a new term is typed.
    expect(container.querySelector<HTMLInputElement>(".search input")!.value).toBe("");
    await typeInSearchBox("liquid");
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
    await typeInSearchBox("liquid");

    expect(container.textContent).toContain("No messages match.");
    expect(container.querySelector(".search-more")!.textContent).toBe("搜尋全部");
    await clickSearchMore();

    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { all: true });
  });

  // A term takes over the panel, so its results can never be hidden behind a
  // tab — a folder change while one is showing re-runs the search against the
  // new folder's scope instead of leaving stale hits on screen.
  test("changing folders while a term is showing re-runs the search", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    await typeInSearchBox("liquid");
    const folderOnly = container.querySelectorAll<HTMLInputElement>(".search-filters input[type=checkbox]")[0];
    await act(async () => { folderOnly.click(); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });
    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { cwd: "/repo" });

    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ cwd: "/other-repo" } as any); await flush(); });
    await act(async () => { vi.advanceTimersByTime(300); await flush(); });

    expect(searchSessions).toHaveBeenLastCalledWith("liquid", { cwd: "/other-repo" });
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
    // No local title matches "liquid" — the title filter's own list is empty.
    await typeInSearchBox("liquid");

    expect(container.textContent).toContain("Liquid glass timeline");
    expect(container.textContent).not.toContain("No conversations in this folder yet.");
  });

  test("has no New chat button inside the panel", async () => {
    await renderSidebar();
    expect(container.querySelector(".list-new")).toBeNull();
  });

  test("an empty list shows its empty state and does not fall back to search results", async () => {
    getHistory.mockResolvedValue([]);
    await renderSidebar();
    expect(container.textContent).toContain("No recent conversations yet.");
    expect(container.querySelector(".all-section")).toBeNull();
    expect(container.querySelector(".search")).not.toBeNull();
  });

  test("typing in the search box runs the server search and shows hits", async () => {
    searchSessions.mockResolvedValue({
      results: [{
        sessionId: "hit-1", source: "claude-cli", agentName: "claude", cwd: "/elsewhere",
        title: "Liquid glass timeline", updatedAt: "2026-06-10T03:00:00.000Z", hitCount: 1,
        hits: [{ index: 42, role: "user", snippet: "make it liquid", offsets: [[8, 14]] }],
      }],
      truncated: false, cursor: null, skipped: [], scanned: { files: 1, bytes: 1, ms: 1 },
    });
    await renderSidebar();
    // Reachable straight from the default view, no view switch needed.
    await typeInSearchBox("liquid");

    expect(searchSessions).toHaveBeenCalledWith("liquid", {});
    expect(container.textContent).toContain("Liquid glass timeline");
  });

  test("a term replaces the sessions list; clearing it restores the previous list", async () => {
    searchSessions.mockResolvedValue({
      results: [], truncated: false, cursor: null, skipped: [], scanned: { files: 0, bytes: 0, ms: 0 },
    });
    await renderSidebar();
    expect(container.querySelector(".sb-head")).not.toBeNull();
    expect(container.querySelector(".all-section")).toBeNull();

    await typeInSearchBox("liquid");
    expect(container.querySelector(".sb-head")).toBeNull();
    expect(container.querySelector(".all-section")).not.toBeNull();

    await typeInSearchBox("");
    expect(container.querySelector(".sb-head")).not.toBeNull();
    expect(container.querySelector(".all-section")).toBeNull();
  });

  // The view is a saved preference, not transient UI state — unlike showMore/
  // query/filters (see the `open` effect), reopening must NOT reset it.
  test("reopening the panel keeps the chosen view", async () => {
    await renderSidebar();
    await showLatestView();
    expect(container.querySelector(".view-btn .vlabel")?.textContent).toBe("latest");
    const { Sidebar } = await import("./Sidebar.tsx");
    await act(async () => {
      root!.render(React.createElement(Sidebar, { open: false, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });
    await act(async () => {
      root!.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });
    expect(container.querySelector(".view-btn .vlabel")?.textContent).toBe("latest");
  });

  test("a conversation row's trash asks for confirmation before deleting", async () => {
    const deleteSession = vi.fn(async () => {});
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ deleteSession } as any);

    const del = container.querySelector<HTMLButtonElement>(".sess-list .sess-row .sess-del");
    expect(del).not.toBeNull();
    await act(async () => { del!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("can't be undone");

    // Cancel closes without deleting.
    const cancel = [...container.querySelectorAll<HTMLButtonElement>(".sess-confirm .btn")]
      .find((b) => b.textContent === "Cancel")!;
    await act(async () => { cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(container.querySelector(".sess-confirm")).toBeNull();

    // Confirming deletes the ROW's conversation, by id.
    await act(async () => { del!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const danger = container.querySelector<HTMLButtonElement>(".sess-confirm .btn.danger")!;
    await act(async () => { danger.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(deleteSession).toHaveBeenCalledWith("s-recent");
    expect(container.querySelector(".sess-confirm")).toBeNull();
  });

  // The Running row shape (renderRunningItem) keeps the trash and disables it,
  // the same treatment every other running row gets: the button is hover-only,
  // so it costs no layout, and it says "not now" instead of vanishing when a
  // turn starts. A running session's key is claimed by the running source
  // before any other renderer sees it (the merge's dedup priority puts running
  // ahead of recents/discovered/history), so this is the only row for it.
  test("a running conversation's delete affordance is disabled, not dropped", async () => {
    await renderSidebar();
    // Other rows (the default history fixture) keep their own delete buttons —
    // check that exactly s-recent's turns off, not that any one disappears.
    const before = container.querySelectorAll(".sess-del").length;
    expect(before).toBeGreaterThan(0);
    expect(container.querySelectorAll(".sess-del:disabled").length).toBe(0);
    const { useStore } = await import("../store/store.ts");
    await act(async () => {
      useStore.setState({
        runningTasks: [{ agentName: "claude", sessionId: "s-recent", state: "active", cwd: "/repo" }],
      } as any);
    });
    expect(container.querySelectorAll(".sess-del").length).toBe(before);
    expect(container.querySelectorAll(".sess-del:disabled").length).toBe(1);
  });

  test("Running rows carry a disabled trash and a menu without Delete", async () => {
    seedLatestView();
    await seedRecentSessions(sixteenRecents());
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    await act(async () => {
      useStore.setState({
        runningTasks: [{ agentName: "claude", sessionId: "run-a", state: "active", cwd: "/repo", title: "Running task" }],
      } as any);
    });
    const running = container.querySelector(".running-section");
    expect(running).not.toBeNull();
    // The affordance exists (hover-only, so no layout shift when a turn starts)
    // but refuses the click: the gateway declines a delete mid-turn anyway.
    expect(running!.querySelector<HTMLButtonElement>(".sess-del")!.disabled).toBe(true);
    // …while ordinary idle Recent rows next to it delete normally.
    expect(container.querySelector<HTMLButtonElement>(".recent-section:not(.running-section) .sess-del")!.disabled).toBe(false);
    // The row still reaches its menu — renaming or pairing a conversation is
    // exactly what you want while it works — minus the destructive row.
    const rowBtn = running!.querySelector<HTMLButtonElement>(".sess-item")!;
    await act(async () => { rowBtn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row")].map((b) => b.textContent);
    expect(rows.some((t) => t?.includes("Rename conversation"))).toBe(true);
    expect(rows.some((t) => t?.includes("Delete conversation"))).toBe(false);
  });

  test("right-clicking a row offers Delete conversation in a menu", async () => {
    const deleteSession = vi.fn(async () => {});
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ deleteSession } as any);

    const rowBtn = container.querySelector<HTMLButtonElement>(".sess-list .sess-row .sess-item")!;
    await act(async () => { rowBtn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });

    const menuRow = container.querySelector<HTMLButtonElement>(".wf-menu .wf-menu-row.danger");
    expect(menuRow?.textContent).toContain("Delete conversation");
    await act(async () => { menuRow!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // The menu hands over to the same confirm card; nothing is deleted yet.
    expect(container.querySelector(".wf-menu")).toBeNull();
    expect(container.textContent).toContain("can't be undone");
    expect(deleteSession).not.toHaveBeenCalled();
  });

  // Reach a row's rename box the way a phone has to: the long-press/right-click
  // menu, then a TAP on its Rename row.
  async function openRenameFromMenu(rowBtn: HTMLButtonElement) {
    await act(async () => { rowBtn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const renameRow = [...container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row")]
      .find((b) => b.textContent?.includes("Rename conversation"));
    expect(renameRow).not.toBeUndefined();
    await act(async () => { renameRow!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    return container.querySelector<HTMLInputElement>(".sess-confirm .rename-input")!;
  }

  // A Recent row can name a conversation in a folder this client isn't in, and the
  // rename sidecar is per-cwd — so the row's OWN agent and folder have to travel
  // with it, not the active ones.
  test("renaming a Recent row posts that row's own agent and folder", async () => {
    seedLatestView();
    await seedRecentSessions(sixteenRecents());
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    const renameSession = vi.fn();
    useStore.setState({ renameSession } as any);

    const rowBtn = container.querySelector<HTMLButtonElement>(".recent-list .sess-row .sess-item")!;
    expect(rowBtn.textContent).toContain("Cross folder work");

    const input = await openRenameFromMenu(rowBtn);
    expect(input.value).toBe("Cross folder work");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed elsewhere");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>(".sess-confirm .btn")]
      .find((b) => b.textContent === "Save")!;
    await act(async () => { save.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(renameSession).toHaveBeenCalledWith("Renamed elsewhere", {
      sessionId: "x1", agentName: "claude", cwd: "/other-repo",
    });
    expect(container.querySelector(".sess-confirm")).toBeNull();
  });

  // An unnamed row displays a short session id. Prefilling the box with it would
  // persist the id as the conversation's name on the very next Save.
  test("an unnamed row opens the rename box empty, not with its short id", async () => {
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "abcdef123456", title: "", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();

    const rowBtn = container.querySelector<HTMLButtonElement>(".recent-list .sess-row .sess-item")!;
    expect(rowBtn.textContent).toContain("abcdef12");

    const input = await openRenameFromMenu(rowBtn);
    expect(input.value).toBe("");
  });

  test("the desktop column collapses and expands via sidebarOpen", async () => {
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    // No matchMedia in jsdom → sidebarOpen initializes false, like a phone.
    expect(container.querySelector("#panel")?.classList.contains("collapsed")).toBe(true);

    await act(async () => { useStore.setState({ sidebarOpen: true }); });
    expect(container.querySelector("#panel")?.classList.contains("collapsed")).toBe(false);

    await act(async () => { useStore.getState().toggleSidebar(); });
    expect(container.querySelector("#panel")?.classList.contains("collapsed")).toBe(true);
  });

  test("the column is draggable to a new width, and remembers it", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    await renderSidebar();

    const panel = container.querySelector<HTMLElement>("#panel");
    const handle = container.querySelector<HTMLElement>(".sb-resize");
    expect(handle).not.toBeNull();
    const before = panel!.style.width;

    // Drag the right edge 100px right — the column is left-anchored, so that
    // makes it wider.
    await act(async () => {
      handle!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 300 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent("pointerup", {}) as PointerEvent);
    });

    expect(panel!.style.width).not.toBe(before);
    expect(parseInt(panel!.style.width, 10)).toBe(parseInt(before, 10) + 100);
    // Committed on release, so the next visit opens at the chosen width.
    expect(localStorage.getItem("acpg.sidebarWidth")).toBe(String(parseInt(panel!.style.width, 10)));
    // The drag must not leave the whole page unselectable.
    expect(document.body.classList.contains("resizing")).toBe(false);
  });

  test("below the column breakpoint there is nothing to drag", async () => {
    await renderSidebar();
    // No matchMedia in jsdom → the sheet: no handle, no inline width — the
    // sheet's layout is the stylesheet's to own.
    expect(container.querySelector(".sb-resize")).toBeNull();
    expect(container.querySelector<HTMLElement>("#panel")!.style.width).toBe("");
  });

  test("the folder view groups rows under a folder header carrying the row count", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/other-repo", sessionId: "o2", title: "Other repo work 2", lastActiveAt: "2026-06-10T03:50:00.000Z" },
    ]);
    await renderSidebar();

    const group = Array.from(container.querySelectorAll(".folder-group"))
      .find((g) => g.textContent?.includes("other-repo"));
    expect(group).not.toBeUndefined();
    expect(group!.querySelector(".fcount")?.textContent).toBe("2");
  });

  test("the folder you are in comes first, even when another folder is more recently active", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "r1", title: "Current repo work", lastActiveAt: "2026-06-10T02:00:00.000Z" },
    ]);
    await renderSidebar();

    const groups = container.querySelectorAll(".folder-group");
    expect(groups.length).toBeGreaterThan(1);
    // /other-repo is the more recently active folder, but /repo is where the
    // app is working right now, so it leads regardless of recency.
    expect(groups[0].querySelector(".fname")?.textContent).toBe("repo");
  });

  test("a folder with nothing running starts collapsed, and clicking its header expands it", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();

    const group = Array.from(container.querySelectorAll(".folder-group"))
      .find((g) => g.textContent?.includes("other-repo"))!;
    const header = group.querySelector<HTMLButtonElement>(".fgroup")!;
    expect(header.classList.contains("closed")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(group.querySelector(".fkids")).toBeNull();

    await act(async () => { header.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(header.classList.contains("closed")).toBe(false);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(group.querySelector(".fkids")).not.toBeNull();
    expect(group.textContent).toContain("Other repo work");
  });

  test("the view choice persists to localStorage", async () => {
    await renderSidebar();
    expect(localStorage.getItem("acpg.sessionsView")).toBeNull();

    await showLatestView();

    expect(localStorage.getItem("acpg.sessionsView")).toBe("latest");
  });

  // The latest view's flat recency list is now two groups, not one — a session
  // straddling the hour boundary must land in the right one, not just "somewhere".
  test("splits the latest view's Recent list into Last hour and Earlier", async () => {
    getHistory.mockResolvedValue([]);
    seedLatestView();
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "fresh-1", title: "Fresh one", lastActiveAt: "2026-06-10T03:30:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "old-1", title: "Old one", lastActiveAt: "2026-06-10T02:00:00.000Z" },
    ]);
    await renderSidebar();

    const heads = Array.from(container.querySelectorAll(".listhead span")).map((h) => h.textContent);
    expect(heads).toEqual(expect.arrayContaining(["Last hour", "Earlier"]));

    const sections = Array.from(container.querySelectorAll(".recent-section:not(.running-section)"));
    const lastHour = sections.find((sec) => sec.querySelector(".listhead")?.textContent === "Last hour")!;
    const earlier = sections.find((sec) => sec.querySelector(".listhead")?.textContent === "Earlier")!;
    expect(lastHour.textContent).toContain("Fresh one");
    expect(lastHour.textContent).not.toContain("Old one");
    expect(earlier.textContent).toContain("Old one");
    expect(earlier.textContent).not.toContain("Fresh one");
  });

  // Hidden folders are filtered before the qty count and both views, per
  // sessionGroups.ts's hideFolders — this exercises the wiring end to end.
  // The list itself now lives on the store (hydrated from the gateway), not
  // in localStorage — seed it directly the way the folder picker would.
  test("hides sessions from a folder chosen in the picker and shows the non-silent count", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "r1", title: "Current repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo work", lastActiveAt: "2026-06-10T03:58:00.000Z" },
    ]);
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ hiddenFolders: ["/other-repo"] }); });

    expect(container.textContent).toContain("Current repo work");
    expect(container.textContent).not.toContain("Other repo work");
    const hiddenBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".sb-head button"))
      .find((b) => b.textContent?.includes("hidden"));
    expect(hiddenBtn?.textContent).toBe("1 hidden");
  });

  // The latest view has no folders to hang a per-project button on, so there the
  // whole list gets one toggle in the header. Revealed, archived rows are dimmed
  // (.archived) and sunk to the bottom. The transcript itself is untouched, so
  // search keeps finding them without any extra wiring.
  test("latest view: archived conversations hide behind the header toggle, then sink to the bottom, dimmed", async () => {
    getHistory.mockResolvedValue([]);
    seedLatestView();
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "a1", title: "Finished task", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "a2", title: "Ongoing task", lastActiveAt: "2026-06-10T03:58:00.000Z" },
    ]);
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ archivedSessions: ["claude\na1"] }); });

    // Cut from the default list, but not silently: the count says so.
    const listed = () => Array.from(container.querySelectorAll<HTMLElement>(".sess-item .name"))
      .map((el) => el.textContent);
    expect(listed()).toEqual(["Ongoing task"]);
    const archivedBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".sb-head button"))
      .find((b) => b.textContent?.includes("archived"))!;
    expect(archivedBtn.textContent).toBe("show archived");

    // Expanding brings it back — last, though it is the more recent of the two.
    await act(async () => { archivedBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(listed()).toEqual(["Ongoing task", "Finished task"]);
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"))
      .find((el) => el.textContent?.includes("Finished task"))!;
    expect(row.classList.contains("archived")).toBe(true);

    // Its menu offers the way back out…
    const { toggleArchivedSession } = await import("../lib/api.ts") as unknown as { toggleArchivedSession: ReturnType<typeof vi.fn> };
    await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const unarchive = Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Unarchive conversation"));
    expect(unarchive).not.toBeUndefined();
    await act(async () => { unarchive!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleArchivedSession).toHaveBeenCalledWith("claude", "a1");
    expect(container.querySelector(".wf-menu")).toBeNull();

    // …and an unarchived row's menu offers Archive.
    const other = Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"))
      .find((el) => el.textContent?.includes("Ongoing task"))!;
    await act(async () => { other.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const archive = Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Archive conversation"));
    expect(archive).not.toBeUndefined();
  });

  // Two projects, one archive each: opening one must not open the other, and a
  // project with nothing BUT archived conversations still has to appear — it is
  // the only place its own reveal button can live.
  test("folder view: each project's archive opens on its own, including an all-archived one", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "r1", title: "Current repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "r2", title: "Repo archive", lastActiveAt: "2026-06-10T03:58:00.000Z" },
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo archive", lastActiveAt: "2026-06-10T03:57:00.000Z" },
    ]);
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ archivedSessions: ["claude\nr2", "claude\no1"] }); });

    const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".see-more.in-folder"));
    expect(buttons().map((b) => b.textContent)).toEqual(["Show archived"]);
    expect(container.textContent).not.toContain("Repo archive");
    expect(container.textContent).not.toContain("Other repo archive");

    // Opening one project's archive leaves the other project's shut.
    await act(async () => { buttons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("Repo archive");
    expect(container.textContent).not.toContain("Other repo archive");

    // The folder with nothing BUT an archive is still listed (a folder that
    // vanished would take its own way back with it) — expanding it finds the
    // button, and that button its one conversation.
    const otherHead = Array.from(container.querySelectorAll<HTMLButtonElement>(".fgroup"))
      .find((b) => b.textContent?.includes("other-repo"))!;
    await act(async () => { otherHead.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const otherBtn = buttons().find((b) => b.closest(".folder-group")!.textContent!.includes("other-repo"))!;
    expect(otherBtn.textContent).toBe("Show archived");
    await act(async () => { otherBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("Other repo archive");
  });

  // By folder, the reveal is per project: the folder's own "N archived" button
  // brings back that folder's archive and nobody else's, to the bottom of the
  // folder however recently the conversation was touched.
  test("folder view: a folder's own archived button reveals its archive, sorted to the bottom", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "a1", title: "Archived but newest", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/repo", sessionId: "a2", title: "Ongoing task", lastActiveAt: "2026-06-10T03:58:00.000Z" },
    ]);
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ archivedSessions: ["claude\na1"] }); });

    // Hidden until this folder is asked, then back in it, at the bottom. The
    // header carries no toggle here — the reveal belongs to the project.
    const titles = () => Array.from(container.querySelectorAll<HTMLElement>(".fkids .sess-item .name"))
      .map((el) => el.textContent);
    expect(titles()).toEqual(["Ongoing task"]);
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>(".sb-head button"))
      .find((b) => b.textContent?.includes("archived"))).toBeUndefined();
    // The button sits under that folder's own children; the folder count is what
    // says how many rows are on screen, so the button doesn't repeat a number.
    const archivedBtn = container.querySelector<HTMLButtonElement>(".fkids .see-more.in-folder")!;
    expect(archivedBtn.textContent).toBe("Show archived");
    expect(container.querySelector(".fgroup .fcount")!.textContent).toBe("1");
    await act(async () => { archivedBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(titles()).toEqual(["Ongoing task", "Archived but newest"]);
    expect(container.querySelector<HTMLElement>(".fkids .see-more.in-folder")!.textContent).toBe("Hide archived");
    expect(container.querySelector(".fgroup .fcount")!.textContent).toBe("2");

    // The hover affordance beside the trash is the other way in and out, and it
    // says which way it goes.
    const { toggleArchivedSession } = await import("../lib/api.ts") as unknown as { toggleArchivedSession: ReturnType<typeof vi.fn> };
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".fkids .sess-row"));
    expect(rows[0].querySelector(".sess-arch")!.getAttribute("aria-label")).toBe("Archive conversation");
    expect(rows[1].querySelector(".sess-arch")!.getAttribute("aria-label")).toBe("Unarchive conversation");
    await act(async () => {
      rows[0].querySelector(".sess-arch")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggleArchivedSession).toHaveBeenCalledWith("claude", "a2");
  });

  // Hiding now starts here, at the folder header — the picker only manages
  // (un-hides) folders already hidden this way.
  test("folder view: a folder group's hide affordance toggles that folder hidden", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();
    const { toggleHiddenFolder } = await import("../lib/api.ts") as unknown as { toggleHiddenFolder: ReturnType<typeof vi.fn> };

    const group = Array.from(container.querySelectorAll(".folder-group"))
      .find((g) => g.textContent?.includes("other-repo"))!;
    const header = group.querySelector<HTMLButtonElement>(".fgroup")!;
    const hideBtn = header.querySelector<HTMLElement>(".hide")!;
    expect(hideBtn).not.toBeNull();

    await act(async () => { hideBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(toggleHiddenFolder).toHaveBeenCalledWith("/other-repo");
    // The click must not also expand/collapse the header underneath it.
    expect(header.classList.contains("closed")).toBe(true);
  });

  // New chat straight from a folder header: the current folder uses the
  // optimistic newSession; any other adopts that folder via setCwd (which
  // starts a fresh session there itself).
  test("folder view: a folder group's + starts a new chat in that folder", async () => {
    getHistory.mockResolvedValue([]);
    await seedRecentSessions([
      { agentName: "claude", cwd: "/repo", sessionId: "r1", title: "Current repo work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
      { agentName: "claude", cwd: "/other-repo", sessionId: "o1", title: "Other repo work", lastActiveAt: "2026-06-10T03:58:00.000Z" },
    ]);
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    const newSession = vi.fn(async () => {});
    const setCwd = vi.fn();
    await act(async () => { useStore.setState({ newSession, setCwd } as any); });

    const groups = Array.from(container.querySelectorAll(".folder-group"));
    const otherHeader = groups.find((g) => g.textContent?.includes("other-repo"))!
      .querySelector<HTMLButtonElement>(".fgroup")!;
    await act(async () => { otherHeader.querySelector<HTMLElement>(".new")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(setCwd).toHaveBeenCalledWith("/other-repo");
    expect(newSession).not.toHaveBeenCalled();
    // The click must not also expand/collapse the header underneath it.
    expect(otherHeader.classList.contains("closed")).toBe(true);

    const curHeader = groups.find((g) => g.textContent?.includes("repo") && !g.textContent?.includes("other-repo"))!
      .querySelector<HTMLButtonElement>(".fgroup")!;
    await act(async () => { curHeader.querySelector<HTMLElement>(".new")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(newSession).toHaveBeenCalled();
    expect(setCwd).toHaveBeenCalledTimes(1);
  });

  test("folder view: the current folder's group has no hide affordance", async () => {
    await renderSidebar();

    const group = Array.from(container.querySelectorAll(".folder-group"))
      .find((g) => g.textContent?.includes("repo") && !g.textContent?.includes("other-repo"))!;
    const header = group.querySelector<HTMLButtonElement>(".fgroup")!;
    expect(header.querySelector(".hide")).toBeNull();
  });

  test("latest view: a row's context menu offers Hide folder for another folder, not for the current one", async () => {
    seedLatestView();
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();
    const { toggleHiddenFolder } = await import("../lib/api.ts") as unknown as { toggleHiddenFolder: ReturnType<typeof vi.fn> };

    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"));
    const otherRow = rows().find((el) => el.textContent?.includes("Cross folder work"))!;
    await act(async () => { otherRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });

    const hideItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Hide folder"));
    expect(hideItem).not.toBeUndefined();
    expect(hideItem!.textContent).toContain("other-repo");
    await act(async () => { hideItem!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleHiddenFolder).toHaveBeenCalledWith("/other-repo");
    expect(container.querySelector(".wf-menu")).toBeNull();

    // The current-folder row (s-recent, cwd /repo) offers no such item.
    const curRow = rows().find((el) => el.textContent?.includes("Recent conversation sidebar"))!;
    await act(async () => { curRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const hideItemForCurrent = Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Hide folder"));
    expect(hideItemForCurrent).toBeUndefined();
  });
  // The repro for "I right-clicked a row and there was no Open as side chat":
  // the row's own agent and the conversation on screen are both part of whether
  // the item can appear at all, so both cases are pinned here.
  test("latest view: a row's context menu offers Open as side chat, except for the conversation already open", async () => {
    const openSideChat = vi.fn(async () => {});
    seedLatestView();
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T03:59:00.000Z" },
    ]);
    await renderSidebar();
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ openSideChat } as any);

    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"));
    const otherRow = rows().find((el) => el.textContent?.includes("Cross folder work"))!;
    await act(async () => { otherRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const sideItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Open as side chat"));
    expect(sideItem).not.toBeUndefined();
    await act(async () => { sideItem!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // The row's OWN folder travels with it: session/load is asked about that cwd,
    // not the one on screen.
    expect(openSideChat).toHaveBeenCalledWith({
      sessionId: "x1", agentName: "claude", cwd: "/other-repo", title: "Cross folder work",
    });

    // The open conversation can't sit beside itself.
    const curRow = rows().find((el) => el.textContent?.includes("Recent conversation sidebar"))!;
    await act(async () => { curRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Open as side chat"))).toBeUndefined();
  });

  test("latest view: pinning a row toggles through the gateway and hoists it above a fresher one", async () => {
    seedLatestView();
    await seedRecentSessions([
      { agentName: "claude", cwd: "/other-repo", sessionId: "x1", title: "Cross folder work", lastActiveAt: "2026-06-10T00:00:00.000Z" },
    ]);
    await renderSidebar();
    const { togglePinnedSession } = await import("../lib/api.ts") as unknown as { togglePinnedSession: ReturnType<typeof vi.fn> };
    const { useStore } = await import("../store/store.ts");

    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".sess-item"));
    const stale = rows().find((el) => el.textContent?.includes("Cross folder work"))!;
    expect(stale.querySelector(".sess-pin")).toBeNull();

    await act(async () => { stale.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    const pinItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Pin conversation"))!;
    expect(pinItem).not.toBeUndefined();
    await act(async () => { pinItem.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(togglePinnedSession).toHaveBeenCalledWith("claude", "x1");
    expect(container.querySelector(".wf-menu")).toBeNull();

    // The gateway is the source of truth for the list, so mirror what it would
    // return — that is what the badge and the ordering both read.
    await act(async () => { useStore.setState({ pinnedSessions: ["claude\nx1"] } as any); });
    const pinned = rows().find((el) => el.textContent?.includes("Cross folder work"))!;
    expect(pinned.querySelector(".sess-pin")).not.toBeNull();
    // Oldest row in the list, yet first on screen: the pin outranks recency.
    expect(rows()[0].textContent).toContain("Cross folder work");

    // And the menu now offers the way back out.
    await act(async () => { pinned.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>(".wf-menu .wf-menu-row"))
      .find((b) => b.textContent?.includes("Unpin conversation"))).not.toBeUndefined();
  });
});
