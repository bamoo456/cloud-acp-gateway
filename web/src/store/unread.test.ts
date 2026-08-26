import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { InboxItem } from "../lib/api.ts";

// The tab badge counts the gateway's inbox, so these drive the store the way the
// poll does — ingest items, then let readActiveSession decide what the reader has
// actually seen.
const item = (over: Partial<InboxItem>): InboxItem => ({
  id: 1, type: "task_done", agentName: "claude", sessionId: "sA", reqId: null,
  title: "", options: [], status: "pending", createdAt: "2026-06-10T01:00:00.000Z", ...over,
});

function setFocus(focused: boolean) {
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
}

async function load(items: InboxItem[], activeId: string | null) {
  document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
    token: "t", defaultAgent: "claude", agents: [{ name: "claude", cwd: "/c" }], fsRoot: "/",
  });
  const { useStore } = await import("./store.ts");
  if (activeId) useStore.getState().setActive(activeId);
  useStore.getState().ingestInboxItems(items, useStore.getState().promptStateRevision);
  return useStore;
}

describe("tab unread badge", () => {
  let fetched: string[];

  beforeEach(() => {
    vi.resetModules();
    fetched = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(String(url));
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{}</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
    setFocus(true);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  test("opening the conversation with the tab focused marks it read on the gateway", async () => {
    const useStore = await load([item({ id: 1 }), item({ id: 2, sessionId: "sB" })], "sA");

    useStore.getState().readActiveSession();

    expect(useStore.getState().inboxItems.map((it) => it.sessionId)).toEqual(["sB"]);
    expect(fetched.some((u) => u.includes("/inbox/read") && u.includes("sessionId=sA"))).toBe(true);
  });

  test("a conversation open in a tab nobody is looking at stays unread", async () => {
    setFocus(false);
    const useStore = await load([item({ id: 1 })], "sA");

    useStore.getState().readActiveSession();

    expect(useStore.getState().inboxItems).toHaveLength(1);
    expect(fetched.some((u) => u.includes("/inbox/read"))).toBe(false);
  });

  test("reading a conversation leaves its pending permission alone", async () => {
    // The agent is still blocked on it — being looked at is not an answer, and
    // dropping it here would hide the prompt from the sidebar badge.
    const useStore = await load([item({ id: 1, type: "permission", reqId: "9" })], "sA");

    useStore.getState().readActiveSession();

    expect(useStore.getState().inboxItems.map((it) => it.type)).toEqual(["permission"]);
    expect(fetched.some((u) => u.includes("/inbox/read"))).toBe(false);
  });
});
