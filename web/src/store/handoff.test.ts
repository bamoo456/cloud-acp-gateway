import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function lastSent(ws: FakeSse, method: string) {
  const hits = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.method === method);
  return hits.at(-1);
}
function countSent(ws: FakeSse, method: string) {
  return ws.sent.map((s) => JSON.parse(s)).filter((f) => f.method === method).length;
}

// Answer whichever channel is live: initialize, then session/new.
async function ready(ws: FakeSse, sessionId: string) {
  ws.open();
  await flush();
  const init = JSON.parse(ws.sent[0]);
  ws.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
  await flush();
  const sess = lastSent(ws, "session/new");
  ws.recv({ jsonrpc: "2.0", id: sess.id, result: { sessionId } });
  await flush();
}

// One connected Claude conversation with something actually said in it — a
// handoff of an empty session is refused, so the fixture has to have a turn.
async function bootstrap() {
  const { useStore } = await import("./store.ts");
  useStore.getState().bootstrap();
  await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
  const ws = FakeSse.instances.at(-1)!;
  await ready(ws, "claude-session");

  useStore.getState().sendPrompt("plan the badge");
  await flush();
  const prompt = lastSent(ws, "session/prompt");
  ws.recv({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
  await flush();
  expect(useStore.getState().sessions["claude-session"].hasContent).toBe(true);
  return { useStore, ws };
}

describe("hand a conversation to another agent", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }, { "name": "codex", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
    history.replaceState(null, "", "/");
    localStorage.clear();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  test("switches to the target agent and sends the retold conversation as its first turn", async () => {
    const { useStore } = await bootstrap();
    const before = FakeSse.instances.length;

    expect(await useStore.getState().handoffSession("codex", "implement the last item")).toBe(true);
    await flush();
    // A handoff is a reconnect: the old channel goes, a new one is opened for the
    // agent being handed to. The folder rides along untouched.
    expect(FakeSse.instances.length).toBe(before + 1);
    expect(useStore.getState().agentName).toBe("codex");
    expect(useStore.getState().cwd).toBe("/repo");

    const codex = FakeSse.instances.at(-1)!;
    await ready(codex, "codex-session");
    expect(lastSent(codex, "session/new").params).toMatchObject({ cwd: "/repo" });

    const prompt = lastSent(codex, "session/prompt");
    expect(prompt.params.sessionId).toBe("codex-session");
    const text = prompt.params.prompt.map((b: any) => b.text).join("");
    expect(text).toContain("## Handoff from claude");
    expect(text).toContain("plan the badge");
    expect(text.trimEnd().endsWith("implement the last item")).toBe(true);
  });

  test("the handoff wins the activation race — one session, and it is the new one", async () => {
    // handleStatus has three other ways to decide what to open on a fresh
    // connection (a pending resync, a deep link, the conversation last read under
    // this agent). If any of them went first the retelling would be delivered into
    // a conversation it has nothing to do with, or a second session would be built
    // alongside it and left empty.
    const { useStore } = await bootstrap();
    await useStore.getState().handoffSession("codex", "take it from here");
    await flush();

    const codex = FakeSse.instances.at(-1)!;
    await ready(codex, "codex-session");
    expect(countSent(codex, "session/new")).toBe(1);
    expect(countSent(codex, "session/load")).toBe(0);
    expect(useStore.getState().activeId).toBe("codex-session");
    // Where the retelling ends and this conversation's own turns begin.
    expect(useStore.getState().sessions["codex-session"].items.some(
      (i) => i.kind === "note" && i.text.includes("handed over from"))).toBe(true);
  });

  test("switching back lands on the conversation that was handed over, not a blank one", async () => {
    const { useStore } = await bootstrap();
    await useStore.getState().handoffSession("codex", "go");
    await flush();
    await ready(FakeSse.instances.at(-1)!, "codex-session");

    useStore.getState().setAgent("claude");
    await flush();
    const back = FakeSse.instances.at(-1)!;
    back.open();
    await flush();
    const init = JSON.parse(back.sent[0]);
    back.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
    await flush();
    expect(useStore.getState().activeId).toBe("claude-session");
  });

  test("refuses mid-turn, with nothing to say, and to an agent that isn't there", async () => {
    const { useStore, ws } = await bootstrap();
    const before = FakeSse.instances.length;

    expect(await useStore.getState().handoffSession("codex", "   ")).toBe(false);
    expect(await useStore.getState().handoffSession("nope", "go")).toBe(false);
    expect(await useStore.getState().handoffSession("claude", "go")).toBe(false);

    // Mid-turn the reply isn't in the transcript yet, so the retelling would hand
    // over half an answer.
    useStore.getState().sendPrompt("and now?");
    await flush();
    expect(useStore.getState().busySessionIds["claude-session"]).toBe(true);
    expect(await useStore.getState().handoffSession("codex", "go")).toBe(false);
    expect(useStore.getState().tip).toContain("Wait for this turn to finish");

    expect(FakeSse.instances.length).toBe(before);
    expect(ws.closed).not.toBe(true);
  });

  test("a target that can't open a session says so, and names where the original still is", async () => {
    const { useStore } = await bootstrap();
    await useStore.getState().handoffSession("codex", "go");
    await flush();

    const codex = FakeSse.instances.at(-1)!;
    codex.open();
    await flush();
    const init = JSON.parse(codex.sent[0]);
    codex.recv({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
    await flush();
    const sess = lastSent(codex, "session/new");
    codex.recv({ jsonrpc: "2.0", id: sess.id, error: { code: -32603, message: "no agent" } });
    await flush();

    expect(useStore.getState().tip).toContain("Couldn't hand over");
    expect(useStore.getState().tip).toContain("still under its own agent");
    expect(countSent(codex, "session/prompt")).toBe(0);
  });
});
