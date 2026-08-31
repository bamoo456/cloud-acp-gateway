import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

// One live Claude session ("s1") on an open socket — same bootstrap the queue
// tests use.
async function bootstrap() {
  const { useStore } = await import("./store.ts");
  useStore.getState().bootstrap();
  await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
  const ws = FakeSse.instances.at(-1)!;
  ws.open();
  await flush();

  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  await flush();

  const sess = JSON.parse(ws.sent[1]);
  ws.recv({ jsonrpc: "2.0", id: sess.id, result: { sessionId: "s1" } });
  await flush();
  expect(useStore.getState().activeId).toBe("s1");

  return { useStore, ws };
}

// Capture only the attention beats, so bootstrap's own requests (prefs, inbox)
// don't have to be modelled.
function watchAttention() {
  const beats: string[] = [];
  vi.stubGlobal("fetch", (url: unknown, opts?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/attention")) beats.push(`${opts?.method} ${u.slice(u.indexOf("/attention"))}`);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as Response);
  });
  return beats;
}

describe("attention beat", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  test("beats once per session, then throttles until the session changes", async () => {
    const { useStore } = await bootstrap();
    const beats = watchAttention();

    useStore.getState().beatAttention();
    await flush();
    expect(beats).toEqual(["POST /attention?agent=claude&session=s1"]);

    // The caller is a 5s poll tick; the throttle is what keeps that from being 12
    // requests a minute.
    useStore.getState().beatAttention();
    useStore.getState().beatAttention();
    await flush();
    expect(beats).toHaveLength(1);

    // A different conversation is a different claim — it beats immediately rather
    // than waiting out the previous session's interval.
    useStore.setState((st) => ({
      sessions: { ...st.sessions, s2: { ...st.sessions.s1, id: "s2" } },
      activeId: "s2",
    }));
    useStore.getState().beatAttention();
    await flush();
    expect(beats).toEqual([
      "POST /attention?agent=claude&session=s1",
      "POST /attention?agent=claude&session=s2",
    ]);
  });

  test("a conversation opened out of history is never attended", async () => {
    const { useStore } = await bootstrap();
    const beats = watchAttention();

    // No CLI stands behind a view-only conversation, and attending one would spawn
    // a resume for a reader who only opened it to read.
    useStore.setState((st) => ({ sessions: { ...st.sessions, s1: { ...st.sessions.s1, viewOnly: true } } }));
    useStore.getState().beatAttention();
    await flush();
    expect(beats).toEqual([]);

    // Replying resumed it — from here it has a CLI worth keeping warm.
    useStore.setState((st) => ({ sessions: { ...st.sessions, s1: { ...st.sessions.s1, viewOnly: false } } }));
    useStore.getState().beatAttention();
    await flush();
    expect(beats).toEqual(["POST /attention?agent=claude&session=s1"]);
  });

  test("a hidden tab has no reader, so it does not beat", async () => {
    const { useStore } = await bootstrap();
    const beats = watchAttention();

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    useStore.getState().beatAttention();
    await flush();
    expect(beats).toEqual([]);

    hidden.mockRestore();
    useStore.getState().beatAttention();
    await flush();
    expect(beats).toEqual(["POST /attention?agent=claude&session=s1"]);
  });
});
