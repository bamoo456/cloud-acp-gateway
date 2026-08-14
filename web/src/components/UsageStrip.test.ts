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
      "token":"t","defaultAgent":"claude","agents":[{"name":"claude","cwd":"/c"},{"name":"codex","cwd":"/c","kind":"codex"}],"fsRoot":"/"}</script>`;
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

  // The default row — the active agent's own windows, scoped away from the
  // hover/click popover so a duplicate segment there can't inflate a count.
  const strip = () => container.querySelector(".usage-strip")!;

  test("nothing to report renders nothing at all", async () => {
    // The strip is the app's bottom edge; an empty one would be a bare grey bar.
    await render({ activeId: null, sessions: {}, rateLimits: {} });
    expect(container.querySelector(".usage-strip")).toBeNull();
  });

  test("context occupancy is shown as a percentage of the window", async () => {
    await render({ ...withContext(48_000, 200_000), rateLimits: {} });
    const seg = strip().querySelector(".u-seg")!;
    expect(seg.textContent).toBe("ctx24%");
    expect(seg.querySelectorAll(".u-bar i.on")).toHaveLength(1); // 24% lights one of four
  });

  test("a context window reported over full reads 100%, not 101%", async () => {
    // Seen on the wire: used=202610 against size=200000 for a frame or two while
    // the session moved onto the 1M window.
    await render({ ...withContext(202_610, 200_000), rateLimits: {} });
    const seg = strip().querySelector(".u-seg")!;
    expect(seg.textContent).toBe("ctx100%");
    expect(seg.querySelectorAll(".u-bar i.on")).toHaveLength(4);
  });

  test("a window that grows mid-session is measured against the new size", async () => {
    // The same tokens against the 1M window are 20%, not 100%.
    await render({ ...withContext(202_610, 1_000_000), rateLimits: {} });
    expect(strip().querySelector(".u-seg")!.textContent).toBe("ctx20%");
  });

  test("windows read left to right: context, session, week, then per-model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    await render({
      ...withContext(20_000, 200_000),
      rateLimits: {
        claude: {
          // Deliberately out of display order — the component owns the order, not
          // whichever event happened to arrive first.
          seven_day_opus: { rateLimitType: "seven_day_opus", utilization: 0.1 },
          five_hour: { rateLimitType: "five_hour", utilization: 0.36, resetsAt: 1_700_000_000 + 92 * 60 },
          seven_day: { rateLimitType: "seven_day", utilization: 0.57, resetsAt: 1_700_000_000 + 33 * 3600 },
        },
      },
    });
    expect([...strip().querySelectorAll(".u-seg")].map((e) => e.textContent))
      // label, then gauge, then percent, then the countdown as one token — the
      // row reads left to right instead of as a run of loose numbers.
      .toEqual(["ctx10%", "5h36%1h32m", "wk57%1d9h", "Opus10%"]);
  });

  test("each window keeps a label of its own, since the phone layout drops the countdowns", async () => {
    // Four bare percentages don't say which quota is which.
    await render({
      activeId: null, sessions: {},
      rateLimits: {
        claude: {
          five_hour: { rateLimitType: "five_hour", utilization: 0.36, resetsAt: 1_700_000_000 },
          seven_day: { rateLimitType: "seven_day", utilization: 0.57, resetsAt: 1_700_000_000 },
        },
      },
    });
    expect([...strip().querySelectorAll(".u-seg .lb")].map((e) => e.textContent)).toEqual(["5h", "wk"]);
  });

  test("float dust doesn't cost a percent: 0.57 is 57%, not 56%", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.57 } } },
    });
    expect(strip().querySelector(".u-seg b")!.textContent).toBe("57%");
  });

  test("utilization is a fraction, floored — 0.999 is not 100%", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.999 } } },
    });
    expect(strip().querySelector(".u-seg b")!.textContent).toBe("99%");
    // The tone lives on the bar now, so the lit blocks and the percentage
    // cannot disagree about which band the number is in.
    expect(strip().querySelector(".u-bar")!.className).toContain("err");
    expect(strip().querySelectorAll(".u-bar i.on")).toHaveLength(4);
  });

  test("a window the agent hasn't reported is left out rather than shown as 0%", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: {
        claude: { five_hour: { rateLimitType: "five_hour" }, seven_day: { rateLimitType: "seven_day", utilization: 0.5 } },
      },
    });
    expect(strip().querySelectorAll(".u-seg")).toHaveLength(1);
    expect(strip().querySelector(".u-seg b")!.textContent).toBe("50%");
  });

  test("the default row shows only the active agent's own windows", async () => {
    // Codex's quota is fetched in the background regardless of which agent is
    // on screen (App.tsx) — it must not leak into the glance-view row for a
    // Claude conversation.
    await render({
      activeId: null, sessions: {},
      rateLimits: {
        claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.36 } },
        codex: { five_hour: { rateLimitType: "five_hour", utilization: 0.9 } },
      },
    });
    expect(strip().querySelectorAll(".u-seg")).toHaveLength(1);
    expect(strip().querySelector(".u-seg b")!.textContent).toBe("36%");
  });

  test("every provider with data appears in the popover, not just the active one", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: {
        claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.36 } },
        codex: { five_hour: { rateLimitType: "five_hour", utilization: 0.9 } },
      },
    });
    const rows = [...container.querySelectorAll(".usage-popover-row")];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.querySelector(".u-seg b")!.textContent)).toEqual(["36%", "90%"]);
  });

  test("the popover is closed until clicked, and a click elsewhere closes it again", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: {
        claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.36 } },
        codex: { five_hour: { rateLimitType: "five_hour", utilization: 0.9 } },
      },
    });
    const wrap = container.querySelector(".usage-strip-wrap")!;
    expect(wrap.className).not.toContain("pinned");

    await act(async () => { strip().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".usage-strip-wrap")!.className).toContain("pinned");

    await act(async () => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".usage-strip-wrap")!.className).not.toContain("pinned");
  });

  test("a single reporting provider still gets exactly one popover row", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.36 } } },
    });
    expect(container.querySelectorAll(".usage-popover-row")).toHaveLength(1);
  });

  test("a Business/unlimited account gets ∞ instead of a blank row", async () => {
    // Codex's own real shape for a business seat: rate_limit is null, so
    // normalizeCodexLimits reports empty windows — the strip must not treat
    // that as "nothing to show" once quotaUnlimited says otherwise.
    await render({
      agentName: "codex",
      activeId: null, sessions: {},
      rateLimits: { codex: {} },
      quotaUnlimited: { codex: true },
    });
    expect([...strip().querySelectorAll(".u-seg")].map((e) => e.textContent)).toEqual(["5h∞", "wk∞"]);
    const bar = strip().querySelector(".u-bar")!;
    // Full bar, but neither warn nor err — "full" isn't a warning here.
    expect(bar.className.trim()).toBe("u-bar");
    expect(bar.querySelectorAll("i.on")).toHaveLength(4);
  });

  test("unlimited only fills in the two windows this gateway actually aligns Codex onto", async () => {
    // Opus/Sonnet caps are a Claude-only concept; an unmetered Codex seat has
    // no analogue for them, so they must stay silent rather than also read ∞.
    await render({
      agentName: "codex",
      activeId: null, sessions: {},
      rateLimits: { codex: {} },
      quotaUnlimited: { codex: true },
    });
    expect(strip().querySelectorAll(".u-seg .lb").length).toBe(2);
  });

  test("a real window always wins over the unlimited fallback", async () => {
    await render({
      agentName: "codex",
      activeId: null, sessions: {},
      rateLimits: { codex: { five_hour: { rateLimitType: "five_hour", utilization: 0.2 } } },
      quotaUnlimited: { codex: true },
    });
    expect([...strip().querySelectorAll(".u-seg")].map((e) => e.textContent)).toEqual(["5h20%", "wk∞"]);
  });

  test("an unlimited provider with no windows of its own still earns a popover row", async () => {
    await render({
      activeId: null, sessions: {},
      rateLimits: { claude: { five_hour: { rateLimitType: "five_hour", utilization: 0.36 } }, codex: {} },
      quotaUnlimited: { codex: true },
    });
    const rows = [...container.querySelectorAll(".usage-popover-row")];
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector(".u-seg b")!.textContent).toBe("∞");
  });
});
