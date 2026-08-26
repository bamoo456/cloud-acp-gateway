import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse } from "../test/fakeSse.ts";

// Same drain-the-transport helper store.test.ts uses: a pushed frame crosses
// several awaits before it lands in the store.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

// One live Claude session ("s1") on an open socket, nothing in flight.
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

const promptsOf = (ws: FakeSse) =>
  ws.sent.map((f) => JSON.parse(f)).filter((f) => f.method === "session/prompt");

describe("queued prompts", () => {
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

  afterEach(() => { vi.unstubAllGlobals(); });

  test("a message queued mid-turn is sent when that turn ends", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    expect(promptsOf(ws)).toHaveLength(1);

    useStore.getState().queuePrompt("s1", { text: "second" });
    // Still queued while the turn runs — the whole point.
    expect(promptsOf(ws)).toHaveLength(1);
    expect(useStore.getState().queuedPrompts["s1"]).toHaveLength(1);

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "end_turn" } });
    await first;
    await flush();

    const sent = promptsOf(ws);
    expect(sent).toHaveLength(2);
    expect(sent[1].params.prompt).toEqual([{ type: "text", text: "second" }]);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
    // The queued message becomes a real turn, so the session is busy again.
    expect(useStore.getState().busySessionIds["s1"]).toBe(true);
  });

  test("two queued messages become two consecutive turns, in order", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "second" });
    useStore.getState().queuePrompt("s1", { text: "third" });

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "end_turn" } });
    await first;
    await flush();

    // Only ONE drained: the third waits for the second's own turn to end.
    expect(promptsOf(ws)).toHaveLength(2);
    expect(useStore.getState().queuedPrompts["s1"]).toHaveLength(1);

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[1].id, result: { stopReason: "end_turn" } });
    await flush();

    const sent = promptsOf(ws);
    expect(sent).toHaveLength(3);
    expect(sent.map((p) => p.params.prompt[0].text)).toEqual(["first", "second", "third"]);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
    expect(useStore.getState().busySessionIds["s1"]).toBe(true);
  });

  test("a turn that errors still drains the queue", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "second" });

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, error: { code: -32000, message: "boom" } });
    await first;
    await flush();

    // A failed turn is still a finished turn — the queue is not stranded by it.
    expect(promptsOf(ws)).toHaveLength(2);
    expect(promptsOf(ws)[1].params.prompt).toEqual([{ type: "text", text: "second" }]);
  });

  test("a cancelled turn leaves the queue parked instead of firing it", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "second" });

    // What every cancel surface produces — the composer's stop, a running-row
    // menu, anything else that notifies session/cancel. Sending the queued message
    // straight after a deliberate stop is the one outcome the user did not ask for.
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "cancelled" } });
    await first;
    await flush();

    expect(promptsOf(ws)).toHaveLength(1);
    expect(useStore.getState().queuedPrompts["s1"]).toHaveLength(1);
  });

  test("a refusal or a token ceiling still drains — those turns ended on their own", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "second" });

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "max_tokens" } });
    await first;
    await flush();

    expect(promptsOf(ws)).toHaveLength(2);
  });

  test("interrupt cancels the running turn and sends its message as the next one", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();

    useStore.getState().interruptWith("s1", { text: "actually do this instead" });
    await flush();

    // The cancel goes out immediately; the prompt cannot, because the agent is
    // still inside the turn being cancelled.
    const cancels = ws.sent.map((f) => JSON.parse(f)).filter((f) => f.method === "session/cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].params.sessionId).toBe("s1");
    expect(promptsOf(ws)).toHaveLength(1);

    // The turn settles as cancelled — which normally parks the queue. Not this one:
    // the cancel WAS the send.
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "cancelled" } });
    await first;
    await flush();

    const sent = promptsOf(ws);
    expect(sent).toHaveLength(2);
    expect(sent[1].params.prompt).toEqual([{ type: "text", text: "actually do this instead" }]);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
  });

  test("interrupt cuts in front of the queue and the rest still follow it", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "queued earlier" });
    useStore.getState().interruptWith("s1", { text: "this one now" });

    // V1: the interrupt takes the head, the older message keeps its place behind it.
    expect(useStore.getState().queuedPrompts["s1"].map((q) => q.text)).toEqual(["this one now", "queued earlier"]);

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "cancelled" } });
    await first;
    await flush();
    expect(promptsOf(ws)[1].params.prompt[0].text).toBe("this one now");

    // And once THAT turn ends normally, the one it cut in front of goes out.
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[1].id, result: { stopReason: "end_turn" } });
    await flush();
    expect(promptsOf(ws).map((p) => p.params.prompt[0].text))
      .toEqual(["first", "this one now", "queued earlier"]);
  });

  test("the interrupt exemption is spent on one settle, not left armed", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().interruptWith("s1", { text: "now" });
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "cancelled" } });
    await first;
    await flush();
    expect(promptsOf(ws)).toHaveLength(2);

    // A plain stop of the interrupt's own turn, with something queued behind it:
    // this cancel must park, or the exemption has leaked past the turn it was for.
    useStore.getState().queuePrompt("s1", { text: "later" });
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[1].id, result: { stopReason: "cancelled" } });
    await flush();

    expect(promptsOf(ws)).toHaveLength(2);
    expect(useStore.getState().queuedPrompts["s1"]).toHaveLength(1);
  });

  test("interrupt on a turn that just finished sends straight away", async () => {
    const { useStore, ws } = await bootstrap();

    // The composer's busy flag is React state, so a phone link can land the tap
    // just after the turn settled. There is nothing to cut then — and cancelling a
    // finished turn settles nothing, so waiting for a settle would park the message
    // and leave the drain exemption armed for the next plain stop.
    const first = useStore.getState().sendPrompt("first");
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "end_turn" } });
    await first;
    await flush();

    useStore.getState().interruptWith("s1", { text: "now" });
    await flush();

    expect(ws.sent.map((f) => JSON.parse(f)).filter((f) => f.method === "session/cancel")).toHaveLength(0);
    expect(promptsOf(ws).map((p) => p.params.prompt[0].text)).toEqual(["first", "now"]);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();

    // And no exemption was left behind: plain-stopping this turn parks the queue.
    useStore.getState().queuePrompt("s1", { text: "later" });
    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[1].id, result: { stopReason: "cancelled" } });
    await flush();
    expect(promptsOf(ws)).toHaveLength(2);
    expect(useStore.getState().queuedPrompts["s1"]).toHaveLength(1);
  });

  test("an empty interrupt is not a cancel in disguise", async () => {
    const { useStore, ws } = await bootstrap();

    useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().interruptWith("s1", { text: "   " });
    await flush();

    // Nothing to send means nothing to cut the turn for.
    expect(ws.sent.map((f) => JSON.parse(f)).filter((f) => f.method === "session/cancel")).toHaveLength(0);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
  });

  test("a refused send puts the message back at the head of the queue", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "second" });

    // The conversation goes view-only mid-turn (what a Codex fork leaves behind):
    // sendPromptTo refuses it, and a pop-then-refuse would eat the message.
    useStore.setState((st) => ({ sessions: { ...st.sessions, s1: { ...st.sessions["s1"], viewOnly: true } } }));

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "end_turn" } });
    await first;
    await flush();

    expect(promptsOf(ws)).toHaveLength(1); // nothing was sent
    expect(useStore.getState().queuedPrompts["s1"]).toHaveLength(1);
    expect(useStore.getState().queuedPrompts["s1"][0].text).toBe("second");
  });

  test("a message queued against a provisional session follows it to its real id", async () => {
    const { useStore, ws } = await bootstrap();

    // A brand new conversation: sendPrompt marks a "pending-" id busy while
    // session/new is in flight, and that id is what the composer can queue on.
    useStore.getState().newSession();
    await flush();
    const provisionalId = useStore.getState().activeId!;
    expect(provisionalId.startsWith("pending-")).toBe(true);

    const sending = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt(provisionalId, { text: "second" });

    const newSess = ws.sent.map((f) => JSON.parse(f)).filter((f) => f.method === "session/new").at(-1)!;
    ws.recv({ jsonrpc: "2.0", id: newSess.id, result: { sessionId: "s2" } });
    await flush();

    expect(useStore.getState().queuedPrompts[provisionalId]).toBeUndefined();
    expect(useStore.getState().queuedPrompts["s2"]).toHaveLength(1);

    const firstPrompt = promptsOf(ws).find((p) => p.params.sessionId === "s2")!;
    ws.recv({ jsonrpc: "2.0", id: firstPrompt.id, result: { stopReason: "end_turn" } });
    await sending;
    await flush();

    // Drained under the real id — under the provisional one it would never send.
    const s2 = promptsOf(ws).filter((p) => p.params.sessionId === "s2");
    expect(s2.map((p) => p.params.prompt[0].text)).toEqual(["first", "second"]);
  });

  test("queuing keeps images and file references, and drops what the agent can't take", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();

    // This agent reported no promptCapabilities at all, so both are dropped —
    // queuing must apply the same filter the send does, not park a block the
    // agent will reject a turn later.
    useStore.getState().queuePrompt("s1", {
      text: "second",
      images: [{ mimeType: "image/png", data: "AAAA" }],
      files: [{ name: "a.ts", uri: "file:///repo/a.ts" }],
    });
    expect(useStore.getState().queuedPrompts["s1"][0].images).toBeUndefined();
    expect(useStore.getState().queuedPrompts["s1"][0].files).toBeUndefined();

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "end_turn" } });
    await first;
    await flush();
    expect(promptsOf(ws)[1].params.prompt).toEqual([{ type: "text", text: "second" }]);
  });

  test("an empty message is never queued", async () => {
    const { useStore } = await bootstrap();

    useStore.getState().queuePrompt("s1", { text: "   " });
    useStore.getState().queuePrompt("s1", { text: "", images: [], files: [] });

    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
  });

  test("removing the one queued message clears the session's entry", async () => {
    const { useStore } = await bootstrap();

    useStore.getState().queuePrompt("s1", { text: "a" });
    useStore.getState().queuePrompt("s1", { text: "b" });
    const [a] = useStore.getState().queuedPrompts["s1"];

    useStore.getState().unqueuePrompt("s1", a.id);
    expect(useStore.getState().queuedPrompts["s1"].map((q) => q.text)).toEqual(["b"]);

    useStore.getState().unqueuePrompt("s1", useStore.getState().queuedPrompts["s1"][0].id);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
  });

  test("takeQueuedPrompts hands the messages back and empties the queue", async () => {
    const { useStore } = await bootstrap();

    useStore.getState().queuePrompt("s1", { text: "a" });
    useStore.getState().queuePrompt("s1", { text: "b" });

    expect(useStore.getState().takeQueuedPrompts("s1").map((q) => q.text)).toEqual(["a", "b"]);
    expect(useStore.getState().queuedPrompts["s1"]).toBeUndefined();
    expect(useStore.getState().takeQueuedPrompts("s1")).toEqual([]);
  });

  test("a queue survives switching to another conversation and back", async () => {
    const { useStore, ws } = await bootstrap();

    const first = useStore.getState().sendPrompt("first");
    await flush();
    useStore.getState().queuePrompt("s1", { text: "second" });

    // The queue is keyed by session, not by "the one on screen" — drain goes to s1
    // even though the user walked away to another conversation meanwhile.
    const creating = useStore.getState().newSession();
    await flush();
    const newSess = ws.sent.map((f) => JSON.parse(f)).filter((f) => f.method === "session/new").at(-1)!;
    ws.recv({ jsonrpc: "2.0", id: newSess.id, result: { sessionId: "s2" } });
    await creating;
    await flush();
    expect(useStore.getState().activeId).toBe("s2");

    ws.recv({ jsonrpc: "2.0", id: promptsOf(ws)[0].id, result: { stopReason: "end_turn" } });
    await first;
    await flush();

    const sent = promptsOf(ws);
    expect(sent).toHaveLength(2);
    expect(sent[1].params.sessionId).toBe("s1");
  });
});
