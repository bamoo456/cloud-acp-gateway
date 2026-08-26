import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSse, installFakeSse, setHistoryFetch } from "../test/fakeSse.ts";
import type { ThreadItem } from "../types.ts";

// Same drain-the-transport helper queue.test.ts uses.
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

describe("the composer's \"!\" shell escape", () => {
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

  test("runShell shows the transcript and the next prompt carries it, once", async () => {
    const { useStore, ws } = await bootstrap();
    const execCalls: string[] = [];
    setHistoryFetch(async (url, init) => {
      expect(url).toContain("/terminal/exec");
      execCalls.push(String(init?.body));
      return { ok: true, json: async () => ({ code: 0, stdout: "hi\n", stderr: "" }) };
    });

    await useStore.getState().runShell("s1", "echo hi");
    // The command ran against the session's own cwd, no agent turn fired.
    expect(JSON.parse(execCalls[0])).toEqual({ cmd: "echo hi", cwd: "/repo" });
    expect(promptsOf(ws)).toHaveLength(0);
    // Thread shows the command and what it printed.
    const items = useStore.getState().sessions["s1"].items as ThreadItem[];
    const notes = items.filter((it) => it.kind === "note" && it.variant === "shell");
    expect(notes.map((n) => (n as { text: string }).text)).toEqual(["! echo hi", "hi"]);

    // The next real message rides behind the transcript block…
    void useStore.getState().sendPromptTo("s1", "what did that print?");
    await flush();
    const [p1] = promptsOf(ws);
    expect(p1.params.prompt).toEqual([
      { type: "text", text: "<bash-input>echo hi</bash-input>\n<bash-stdout>hi\n</bash-stdout>" },
      { type: "text", text: "what did that print?" },
    ]);

    // …and the stash is spent: settle the turn, send again, no shell block.
    ws.recv({ jsonrpc: "2.0", id: p1.id, result: { stopReason: "end_turn" } });
    await flush();
    void useStore.getState().sendPromptTo("s1", "again");
    await flush();
    expect(promptsOf(ws)[1].params.prompt).toEqual([{ type: "text", text: "again" }]);
  });

  test("a failed exec lands as an error note and stashes nothing", async () => {
    const { useStore, ws } = await bootstrap();
    setHistoryFetch(async () => ({ ok: false, status: 404 }));

    await useStore.getState().runShell("s1", "ls");
    const items = useStore.getState().sessions["s1"].items as ThreadItem[];
    expect(items.some((it) => it.kind === "note" && it.variant === "error" && /exec failed \(404\)/.test(it.text))).toBe(true);

    void useStore.getState().sendPromptTo("s1", "hello");
    await flush();
    expect(promptsOf(ws)[0].params.prompt).toEqual([{ type: "text", text: "hello" }]);
  });
});
