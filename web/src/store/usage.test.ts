import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

async function bootClaude() {
  document.getElementById("acpg-cfg")!.textContent = JSON.stringify({
    token: "t",
    defaultAgent: "claude",
    agents: [{ name: "claude", cwd: "/c", history: true }, { name: "codex", cwd: "/p", skin: "codex" }],
    fsRoot: "/",
  });
  const { useStore } = await import("./store.ts");
  useStore.getState().bootstrap();
  await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
  const ws = FakeSse.instances.at(-1)!;
  ws.open();
  await flush();
  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  await flush();
  const sess = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: sess.id, result: { sessionId: "s1" } });
  await flush();
  return { useStore, ws };
}

const usage = (sessionId: string, update: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  method: "session/update",
  params: { sessionId, update: { sessionUpdate: "usage_update", ...update } },
});

const rateLimit = (rateLimitType: string, utilization: number, resetsAt?: number) => ({
  _meta: { "_claude/rateLimit": { status: "allowed", rateLimitType, utilization, resetsAt } },
});

describe("usage_update", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{}</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("the context window lands on the session it names", async () => {
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { used: 48_000, size: 200_000 }));
    await flush();
    expect(useStore.getState().sessions.s1).toMatchObject({ contextUsed: 48_000, contextSize: 200_000 });
  });

  test("rate-limit windows accumulate by type instead of replacing each other", async () => {
    // Each rate_limit_event carries exactly one window, so the three the gauge
    // shows only exist together if the store merges them.
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { used: 1, size: 200_000, ...rateLimit("five_hour", 0.36, 1_700_000_000) }));
    ws.recv(usage("s1", { used: 1, size: 200_000, ...rateLimit("seven_day", 0.57, 1_700_100_000) }));
    ws.recv(usage("s1", { used: 1, size: 200_000, ...rateLimit("seven_day_opus", 0.1) }));
    await flush();
    expect(Object.keys(useStore.getState().rateLimits.claude).sort())
      .toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(useStore.getState().rateLimits.claude.five_hour).toMatchObject({ utilization: 0.36, resetsAt: 1_700_000_000 });
  });

  test("a later event for the same window replaces it", async () => {
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { ...rateLimit("five_hour", 0.36) }));
    ws.recv(usage("s1", { ...rateLimit("five_hour", 0.41) }));
    await flush();
    expect(useStore.getState().rateLimits.claude.five_hour.utilization).toBe(0.41);
  });

  test("an update carrying both halves applies both", async () => {
    // The rate-limit branch must fall through to the session reducer; an early
    // return there silently freezes the context bar on rate-limited turns.
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { used: 90_000, size: 200_000, ...rateLimit("five_hour", 0.36) }));
    await flush();
    expect(useStore.getState().sessions.s1).toMatchObject({ contextUsed: 90_000 });
    expect(useStore.getState().rateLimits.claude.five_hour.utilization).toBe(0.36);
  });

  test("an event that names a window but carries no numbers keeps what's known", async () => {
    // The adapter really does send a rate limit with no `utilization` (see
    // usage-limits.ts). Letting it replace the entry drops the window from the
    // strip, which reads as the 5h segment disappearing mid-conversation while
    // wk stays — until the next poll puts it back.
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { ...rateLimit("five_hour", 0.36, 1_700_000_000) }));
    ws.recv(usage("s1", { _meta: { "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour" } } }));
    await flush();
    expect(useStore.getState().rateLimits.claude.five_hour)
      .toMatchObject({ utilization: 0.36, resetsAt: 1_700_000_000 });
  });

  test("an event with a utilization but no reset keeps the countdown", async () => {
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { ...rateLimit("five_hour", 0.36, 1_700_000_000) }));
    ws.recv(usage("s1", { ...rateLimit("five_hour", 0.41) }));
    await flush();
    expect(useStore.getState().rateLimits.claude.five_hour)
      .toMatchObject({ utilization: 0.41, resetsAt: 1_700_000_000 });
  });

  test("limits from a session this client isn't holding still count", async () => {
    // Quotas are account-wide, so a background conversation's event is just as
    // true — and the sid check below would otherwise drop the whole frame.
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("other-session", { ...rateLimit("seven_day", 0.57) }));
    await flush();
    expect(useStore.getState().rateLimits.claude.seven_day.utilization).toBe(0.57);
  });

  test("switching agents keeps the previous account's limits", async () => {
    // Each provider's quota is polled in the background regardless of which
    // agent is active (App.tsx) — switching away from Claude must not blank
    // the Claude entry the popover still shows it under.
    const { useStore, ws } = await bootClaude();
    ws.recv(usage("s1", { ...rateLimit("five_hour", 0.36) }));
    await flush();
    useStore.getState().setAgent("codex");
    expect(useStore.getState().rateLimits.claude.five_hour.utilization).toBe(0.36);
  });
});
