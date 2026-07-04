import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { installFakeSse, FakeSse } from "./test/fakeSse.ts";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const savedPinLock = { saltB64: "AQ==", hashB64: "Ag==", iterations: 1 };

describe("screen lock — connection-driven (no idle/visibility timer)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token":"t","defaultAgent":"claude",
      "agents":[{"name":"claude","cwd":"/c"}],"fsRoot":"/"}</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    setVisibility("visible");
    vi.doMock("./lib/api.ts", () => ({
      getRunning: vi.fn().mockResolvedValue([]),
      getInboxPending: vi.fn().mockResolvedValue([]),
      answerInbox: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue([]),
      getDiscoveredHistory: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, truncated: false }),
      renameSession: vi.fn(),
      listDir: vi.fn().mockResolvedValue({ root: "/", path: "/", parent: null, dirs: [] }),
      // lock enabled with a stored PIN hash
      getPrefs: vi.fn().mockResolvedValue({ textSize: null, lock: savedPinLock, recentSessions: [], recentFolders: [] }),
      putTextSize: vi.fn().mockResolvedValue(undefined),
      putLockConfig: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.unstubAllGlobals();
    vi.doUnmock("./lib/api.ts");
    document.body.innerHTML = "";
  });

  async function renderApp() {
    const { App } = await import("./App.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await flush();                            // bootstrap()'s getPrefs settles
  }

  async function renderUnlockedConnected() {
    await renderApp();
    const { useStore } = await import("./store/store.ts");
    await vi.waitFor(() => expect(useStore.getState().lockEnabled).toBe(true));
    if (useStore.getState().locked) {
      await act(async () => { useStore.getState().unlock(); });
    }
    await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
    await act(async () => { FakeSse.instances.at(-1)?.open(); }); // SSE up → connected
    await vi.waitFor(() => expect(useStore.getState().conn).toBe("connected"));
  }

  test("the lock hydrates enabled", async () => {
    const { useStore } = await import("./store/store.ts");
    await renderApp();
    expect(useStore.getState().lockEnabled).toBe(true);
  });

  test("initial load with a saved PIN lock shows the PIN screen before connecting", async () => {
    const { App } = await import("./App.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await flush();

    const { useStore } = await import("./store/store.ts");
    await vi.waitFor(() => expect(useStore.getState().lockEnabled).toBe(true));
    await vi.waitFor(() => expect(useStore.getState().locked).toBe(true));
    expect(container.textContent).toContain("Enter your PIN to reconnect");
    expect(FakeSse.instances.length).toBe(0);
  });

  test("backgrounding and returning does NOT lock while the socket stays alive", async () => {
    const { useStore } = await import("./store/store.ts");
    await renderUnlockedConnected();
    expect(useStore.getState().conn).toBe("connected");

    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();

    // No drop occurred, so the connection-driven lock must NOT engage — the old
    // idle/visibility timer is gone.
    expect(useStore.getState().locked).toBe(false);
  });
});
