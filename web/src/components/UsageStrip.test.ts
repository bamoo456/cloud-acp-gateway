import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSession } from "../store/reducers.ts";

describe("UsageStrip", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token":"t","defaultAgent":"claude","agents":[{"name":"claude","cwd":"/c"}],"fsRoot":"/"}</script>`;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function render(state: Record<string, unknown>) {
    const { useStore } = await import("../store/store.ts");
    useStore.setState(state as never);
    const { UsageStrip } = await import("./UsageStrip.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(UsageStrip));
    });
  }

  const withContext = (used: number, size: number) => ({
    activeId: "s1",
    sessions: { s1: { ...makeSession("s1"), contextUsed: used, contextSize: size } },
  });

  test("nothing to report renders nothing at all", async () => {
    // The strip is the app's bottom edge; an empty one would be a bare grey bar.
    await render({ activeId: null, sessions: {}, rateLimits: {} });
    expect(container.querySelector(".usage-strip")).toBeNull();
  });

  test("context occupancy is shown as a percentage of the window", async () => {
    await render({ ...withContext(48_000, 200_000), rateLimits: {} });
    const seg = container.querySelector(".u-seg")!;
    expect(seg.textContent).toBe("24%context");
    expect(seg.querySelector("i")!.getAttribute("style")).toContain("width: 24%");
  });

  test("a context window reported over full reads 100%, not 101%", async () => {
    // Seen on the wire: used=202610 against size=200000 for a frame or two while
    // the session moved onto the 1M window.
    await render({ ...withContext(202_610, 200_000), rateLimits: {} });
    const seg = container.querySelector(".u-seg")!;
    expect(seg.textContent).toBe("100%context");
    expect(seg.querySelector("i")!.getAttribute("style")).toContain("width: 100%");
  });

  test("a window that grows mid-session is measured against the new size", async () => {
    // The same tokens against the 1M window are 20%, not 100%.
    await render({ ...withContext(202_610, 1_000_000), rateLimits: {} });
    expect(container.querySelector(".u-seg")!.textContent).toBe("20%context");
  });

  test("windows read left to right: context, session, week, then per-model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    await render({
      ...withContext(20_000, 200_000),
      rateLimits: {
        // Deliberately out of display order — the component owns the order, not
        // whichever event happened to arrive first.
        seven_day_opus: { rateLimitType: "seven_day_opus", utilization: 0.1 },
        five_hour: { rateLimitType: "five_hour", utilization: 0.36, resetsAt: 1_700_000_000 + 92 * 60 },
        seven_day: { rateLimitType: "seven_day", utilization: 0.57, resetsAt: 1_700_000_000 + 33 * 3600 },
      },
    });
    expect([...container.querySelectorAll(".u-seg")].map((e) => e.textContent))
      // "36%5h1h 32m" was three numbers in a row; the word says which duration
      // is the window and which is the countdown.
      .toEqual(["10%context", "36%5hin 1h 32m", "57%7din 1d 9h", "10%Opus"]);
  });

  test("each window keeps a label of its own, since the phone layout drops the countdowns", async () => {
    // Four bare percentages don't say which quota is which.
    await render({
      activeId: null, sessions: {},
      rateLimits: {
        five_hour: { rateLimitType: "five_hour", utilization: 0.36, resetsAt: 1_700_000_000 },
        seven_day: { rateLimitType: "seven_day", utilization: 0.57, resetsAt: 1_700_000_000 },
      },
    });
    expect([...container.querySelectorAll(".u-seg .lb")].map((e) => e.textContent)).toEqual(["5h", "7d"]);
  });

  test("float dust doesn't cost a percent: 0.57 is 57%, not 56%", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { five_hour: { rateLimitType: "five_hour", utilization: 0.57 } },
    });
    expect(container.querySelector(".u-seg b")!.textContent).toBe("57%");
  });

  test("utilization is a fraction, floored — 0.999 is not 100%", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { five_hour: { rateLimitType: "five_hour", utilization: 0.999 } },
    });
    expect(container.querySelector(".u-seg b")!.textContent).toBe("99%");
    expect(container.querySelector(".u-bar i")!.className).toBe("err");
  });

  test("a window the agent hasn't reported is left out rather than shown as 0%", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { five_hour: { rateLimitType: "five_hour" }, seven_day: { rateLimitType: "seven_day", utilization: 0.5 } },
    });
    expect(container.querySelectorAll(".u-seg")).toHaveLength(1);
    expect(container.querySelector(".u-seg b")!.textContent).toBe("50%");
  });
});
