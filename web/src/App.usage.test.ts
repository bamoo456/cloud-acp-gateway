import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse } from "./test/fakeSse.ts";

// End-to-end for the gauge: mount the real App, drive it through the real store
// with a frame copied verbatim out of a live gateway ledger, and check the strip
// appears. The unit tests all inject state directly, so only this one would
// catch the wiring between App's render gate and the store.
const LIVE_FRAME = {
  jsonrpc: "2.0" as const,
  method: "session/update",
  params: { sessionId: "S", update: { sessionUpdate: "usage_update", used: 174196, size: 200000 } },
};

describe("App usage strip", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getUsageLimits: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installFakeSse();
    // No terminalEnabled: the strip has to appear on usage alone, which is the
    // path a gateway with ACPG_TERMINAL off takes.
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token":"t","defaultAgent":"claude",
      "agents":[{"name":"claude","cwd":"/c"}],"fsRoot":"/"}</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
    getUsageLimits = vi.fn().mockResolvedValue(null);
    vi.doMock("./lib/api.ts", () => ({
      getRunning: vi.fn().mockResolvedValue([]),
      getInboxPending: vi.fn().mockResolvedValue([]),
      getUsageLimits,
      answerInbox: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue([]),
      getDiscoveredHistory: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, truncated: false }),
      renameSession: vi.fn(),
      listDir: vi.fn().mockResolvedValue({ root: "/", path: "/", parent: null, dirs: [] }),
      getPrefs: vi.fn().mockResolvedValue({ textSize: null, lock: null, recentSessions: [], recentFolders: [], hiddenFolders: [] }),
      putTextSize: vi.fn().mockResolvedValue(undefined),
      // The status bar's diffstat: the file panel reads the checkout even
      // while it is shut, so App-level renders touch this route too.
      getWorkspaceChanges: vi.fn().mockResolvedValue({ repo: null, files: [], truncated: false }),
    }));
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.unstubAllGlobals();
    vi.doUnmock("./lib/api.ts");
    document.body.innerHTML = "";
  });

  async function mountAndConnect() {
    const { App } = await import("./App.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
    const ws = FakeSse.instances.at(-1)!;
    await act(async () => {
      ws.open();
      await Promise.resolve();
    });
    const init = JSON.parse(ws.sent[0]);
    await act(async () => {
      ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      await Promise.resolve();
    });
    const sess = JSON.parse(ws.sent[1]);
    await act(async () => {
      ws.recv({ jsonrpc: "2.0", id: sess.id, result: { sessionId: "S" } });
      await Promise.resolve();
    });
    return ws;
  }

  test("a live usage_update makes the strip appear on a terminal-less gateway", async () => {
    const ws = await mountAndConnect();
    // The status bar is the app's bottom edge now, so it is always mounted —
    // but the usage segments still wait for an agent to report something.
    expect(container.querySelector(".statusbar")).not.toBeNull();
    expect(container.querySelector(".usage-strip")).toBeNull(); // nothing to report yet

    await act(async () => {
      ws.recv(LIVE_FRAME);
      await Promise.resolve();
    });

    const strip = container.querySelector(".statusbar .usage-strip");
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toBe("ctx87%");
  });

  test("the quota poll fills the strip with no session usage at all", async () => {
    // The point of the /usage/limits route: 5h and weekly appear without anyone
    // having sent a prompt, which is exactly what the ACP path cannot do.
    getUsageLimits.mockResolvedValue({
      windows: {
        five_hour: { utilization: 0.13, resetsAt: Math.floor(Date.now() / 1000) + 92 * 60 },
        seven_day: { utilization: 0.59, resetsAt: Math.floor(Date.now() / 1000) + 30 * 3600 },
        "weekly_scoped:Fable": { utilization: 0.1, label: "Fable" },
      },
    });
    await mountAndConnect();
    await vi.waitFor(() => expect(container.querySelector(".usage-strip")).not.toBeNull());

    // Percentages and labels only: the countdown text is a function of the wall
    // clock, and formatUntil already has exact coverage in format.test.ts.
    // Scoped to the default row — the same windows also appear in the
    // hover/click popover now that every provider's quota is polled in the
    // background, and that duplicate isn't what this test is checking.
    const row = container.querySelector(".usage-strip")!;
    expect([...row.querySelectorAll(".u-seg b")].map((e) => e.textContent)).toEqual(["13%", "59%", "10%"]);
    expect([...row.querySelectorAll(".u-seg .lb")].map((e) => e.textContent)).toEqual(["5h", "wk", "Fable"]);
  });

  test("a gateway that can't report quota leaves the strip alone", async () => {
    // Older gateway, no Claude credential, offline: null, not an empty set of
    // windows — nothing should render, and nothing should throw.
    getUsageLimits.mockResolvedValue(null);
    await mountAndConnect();
    expect(container.querySelector(".usage-strip")).toBeNull();
  });

  // Distinct from the null case above: the gateway answered, and the answer was
  // "this account's credential is stale". That is the user's move to make, so
  // the strip has to say it instead of staying empty and looking broken.
  test("an expired credential surfaces as a re-auth, not as an empty strip", async () => {
    getUsageLimits.mockResolvedValue({ windows: {}, unavailable: "expired" });
    await mountAndConnect();
    await vi.waitFor(() => expect(container.querySelector(".usage-strip .u-seg")).not.toBeNull());
    expect(container.querySelector(".usage-strip")!.textContent).toBe("quotare-auth");
  });
});
