import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { HistorySession, InboxItem } from "../lib/api.ts";

// The unread marker on a conversation row: a finished turn nobody has opened yet.
// Its own file rather than a block in Sidebar.test.ts because the subject is the
// inbox-fed dot, and seeding inboxItems is the whole setup.

const historyItems: HistorySession[] = [
  { sessionId: "s-done", title: "Finished while you were away", updatedAt: "2026-06-10T03:58:00.000Z" },
  { sessionId: "s-quiet", title: "Nothing happened here", updatedAt: "2026-06-10T03:00:00.000Z" },
];

// The rows the default (folder) view lists come from the gateway's recents, not
// from /history — seed that cache before importing the store.
const recents = [
  { agentName: "claude", cwd: "/repo", sessionId: "s-done", title: "Finished while you were away", lastActiveAt: "2026-06-10T03:58:00.000Z" },
  { agentName: "claude", cwd: "/repo", sessionId: "s-quiet", title: "Nothing happened here", lastActiveAt: "2026-06-10T03:00:00.000Z" },
];

const inboxItem = (over: Partial<InboxItem>): InboxItem => ({
  id: 1, type: "task_done", agentName: "claude", sessionId: "s-done", reqId: null,
  title: "", options: [], status: "pending", createdAt: "2026-06-10T03:58:00.000Z", ...over,
});

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("Sidebar unread marker", () => {
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
    localStorage.clear();
    vi.doMock("../lib/api.ts", () => ({
      getHistory: vi.fn().mockResolvedValue(historyItems),
      getDiscoveredHistory: vi.fn().mockResolvedValue([]),
      searchSessions: vi.fn(),
      getMessages: vi.fn(),
      renameSession: vi.fn(),
      listDir: vi.fn(),
      toggleHiddenFolder: vi.fn().mockResolvedValue([]),
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
  });

  async function renderWith(inboxItems: InboxItem[]) {
    const { hydrateRecentSessions } = await import("../lib/recentSessions.ts");
    hydrateRecentSessions(recents);
    const { Sidebar } = await import("./Sidebar.tsx");
    const { useStore } = await import("../store/store.ts");
    const { makeSession } = await import("../store/reducers.ts");
    useStore.setState({
      agentName: "claude", cwd: "/repo", agentReady: true,
      sessions: { "s-quiet": { ...makeSession("s-quiet"), title: "Nothing happened here" } },
      activeId: "s-quiet",
      recentSessions: recents,
      openHistorySession: vi.fn(),
      newSession: vi.fn(),
      historyNonce: 0,
      inboxItems,
    } as never);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Sidebar, { open: true, onClose: vi.fn(), onOpenPicker: vi.fn() }));
      await flush();
    });
  }

  // The row is found by its title, so the assertion can't drift onto some other
  // row's dot if the list order changes.
  const rowFor = (title: string) =>
    [...container.querySelectorAll<HTMLElement>(".sess-item")].find((el) => el.textContent?.includes(title));

  test("a finished turn nobody opened marks its row", async () => {
    await renderWith([inboxItem({})]);

    expect(rowFor("Finished while you were away")?.querySelector(".run-dot.unread")).toBeTruthy();
    expect(rowFor("Nothing happened here")?.querySelector(".run-dot")).toBeFalsy();
  });

  test("the folder header carries the unread dot too", async () => {
    // A collapsed folder is the only place its conversations' state can show,
    // and the header dot follows the rows' own precedence.
    await renderWith([inboxItem({})]);

    const header = container.querySelector(".fgroup")!;
    expect(header.querySelector(".run-dot.unread")).toBeTruthy();
    expect(header.querySelector(".run-dot.awaiting")).toBeFalsy();
  });

  test("a prompt waiting on an answer stays amber, not unread", async () => {
    // Both rows exist in the inbox; only the one that can be answered is amber,
    // because amber is the colour that means the turn is blocked on you.
    await renderWith([inboxItem({ id: 2, type: "permission", reqId: "9" })]);

    const row = rowFor("Finished while you were away");
    expect(row?.querySelector(".run-dot.awaiting")).toBeTruthy();
    expect(row?.querySelector(".run-dot.unread")).toBeFalsy();
  });
});
