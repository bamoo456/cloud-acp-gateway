import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Recents live on the gateway now, hydrated into an in-memory cache. Seed that
// cache (fresh per test under resetModules) before rendering the picker.
async function seedRecentFolders(list: Array<{ path: string; lastUsedAt: string }>) {
  const { hydrateRecentFolders } = await import("../lib/recentFolders.ts");
  hydrateRecentFolders(list);
}

describe("FolderPicker", () => {
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
    // Favorites come from the server now; mock the API. Pinned defaults to empty
    // and toggle to empty; individual tests override the resolved values.
    vi.doMock("../lib/api.ts", () => ({
      listDir: vi.fn().mockResolvedValue({ root: "/", path: "/", parent: null, dirs: [] }),
      getHistory: vi.fn(),
      getMessages: vi.fn(),
      renameSession: vi.fn(),
      getPinnedFolders: vi.fn().mockResolvedValue([]),
      togglePinnedFolder: vi.fn().mockResolvedValue([]),
      postRecentFolder: vi.fn().mockResolvedValue(undefined),
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

  async function api() {
    return await import("../lib/api.ts") as unknown as {
      getPinnedFolders: Mock; togglePinnedFolder: Mock; toggleHiddenFolder: Mock;
    };
  }

  async function render(onClose = vi.fn()) {
    const { FolderPicker } = await import("./FolderPicker.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(FolderPicker, { onClose }));
    });
    // Flush the on-mount getPinnedFolders() promise and its setState.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return onClose;
  }

  test("renders pinned folders loaded from the server", async () => {
    (await api()).getPinnedFolders.mockResolvedValue(["/repo"]);
    await render();
    expect(container.textContent).toContain("Pinned");
    expect(container.textContent).toContain("repo");
  });

  test("recent section hides folders that are already pinned", async () => {
    (await api()).getPinnedFolders.mockResolvedValue(["/repo"]);
    await seedRecentFolders([
      { path: "/repo", lastUsedAt: "2026-06-10T03:00:00.000Z" },
      { path: "/other", lastUsedAt: "2026-06-10T02:00:00.000Z" },
    ]);
    await render();
    const recentSection = container.querySelector(".fp-recent")!;
    expect(recentSection.textContent).toContain("other");
    expect(recentSection.querySelectorAll("button.arow")).toHaveLength(1);
  });

  test("tapping a folder row switches cwd and closes", async () => {
    (await api()).getPinnedFolders.mockResolvedValue(["/other"]);
    const onClose = await render();
    const { useStore } = await import("../store/store.ts");
    const setCwd = vi.fn();
    await act(async () => { useStore.setState({ setCwd }); });

    const row = [...container.querySelectorAll("button.arow")].find((b) => b.textContent?.includes("other"));
    await act(async () => { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(setCwd).toHaveBeenCalledWith("/other");
    expect(onClose).toHaveBeenCalled();
  });

  test("star toggle pins/unpins via the server without closing", async () => {
    const a = await api();
    a.getPinnedFolders.mockResolvedValue([]);
    a.togglePinnedFolder.mockResolvedValue(["/other"]);
    await seedRecentFolders([
      { path: "/other", lastUsedAt: "2026-06-10T02:00:00.000Z" },
    ]);
    const onClose = await render();
    const star = container.querySelector<HTMLElement>('[aria-label="Pin folder"]');
    await act(async () => {
      star?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(a.togglePinnedFolder).toHaveBeenCalledWith("/other");
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Pinned");
  });

  test("'Browse all folders' opens the drill-down browser", async () => {
    await render();
    const browse = [...container.querySelectorAll("button.arow")].find((b) => b.textContent?.includes("Browse all folders"));
    await act(async () => { browse?.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    expect(container.querySelector("#fb")).not.toBeNull();
  });

  // Hiding moved to the sidebar — the picker no longer offers a "Hide a
  // folder…" browse flow at all.
  test("has no 'Hide a folder…' row", async () => {
    await render();
    const rows = [...container.querySelectorAll("button.arow")].map((b) => b.textContent || "");
    expect(rows.some((t) => t.includes("Hide a folder"))).toBe(false);
  });

  // Hidden folders live on the store now (hydrated from the gateway, see
  // store.ts's bootstrap) — seed it directly, the way the picker's own toggle would.
  test("a hidden folder renders under Hidden, not under Pinned or Recent", async () => {
    (await api()).getPinnedFolders.mockResolvedValue(["/repo"]);
    await seedRecentFolders([{ path: "/other", lastUsedAt: "2026-06-10T02:00:00.000Z" }]);
    await render();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ hiddenFolders: ["/repo"] }); });

    const hiddenSection = container.querySelector(".fp-hidden");
    expect(hiddenSection).not.toBeNull();
    expect(hiddenSection!.textContent).toContain("repo");
    expect(container.querySelector(".fp-pinned")).toBeNull();
  });

  // Un-hiding is the only hide-affordance meaning left in the picker — hiding
  // itself moved to the sidebar (folder header / row menu).
  test("the un-hide affordance in Hidden calls the toggle without closing the picker", async () => {
    (await api()).getPinnedFolders.mockResolvedValue([]);
    const onClose = await render();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ hiddenFolders: ["/repo"] }); });

    const unhideBtn = container.querySelector<HTMLElement>('[aria-label="Unhide folder"]');
    expect(unhideBtn).not.toBeNull();
    await act(async () => {
      unhideBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect((await api()).toggleHiddenFolder).toHaveBeenCalledWith("/repo");
    expect(onClose).not.toHaveBeenCalled();
  });

  // Which sections offer the affordance, and as what: Recent hides, Hidden
  // un-hides, Pinned never offers it, and the current folder's Recent row
  // doesn't either (hideFolders exempts it, so the toggle would do nothing).
  test("Recent rows hide, Hidden rows un-hide, Pinned rows offer neither", async () => {
    (await api()).getPinnedFolders.mockResolvedValue(["/pinned-one"]);
    await seedRecentFolders([
      { path: "/other", lastUsedAt: "2026-06-10T02:00:00.000Z" },
      { path: "/repo", lastUsedAt: "2026-06-10T01:00:00.000Z" },
    ]);
    await render();
    const { useStore } = await import("../store/store.ts");
    await act(async () => { useStore.setState({ hiddenFolders: ["/hidden-one"] }); });

    expect(container.querySelector(".fp-pinned .hide")).toBeNull();
    expect(container.querySelectorAll(".fp-recent .hide[aria-label='Hide folder']")).toHaveLength(1);
    expect(container.querySelector(".fp-hidden .hide[aria-label='Unhide folder']")).not.toBeNull();
  });

  test("hiding from a Recent row calls the toggle with that folder", async () => {
    (await api()).getPinnedFolders.mockResolvedValue([]);
    await seedRecentFolders([{ path: "/other", lastUsedAt: "2026-06-10T02:00:00.000Z" }]);
    const onClose = await render();

    const hideBtn = container.querySelector<HTMLElement>('.fp-recent [aria-label="Hide folder"]');
    expect(hideBtn).not.toBeNull();
    await act(async () => {
      hideBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect((await api()).toggleHiddenFolder).toHaveBeenCalledWith("/other");
    expect(onClose).not.toHaveBeenCalled();
  });
});
