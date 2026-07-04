import { describe, test, expect } from "vitest";
import { makeSession, addUserBubble, setTitle, applyModelsModes, applyHistoryMessages, applyUpdate, contentText, contentImage, contentFile, evictExcess } from "./reducers.ts";
import type { NewSessionResult, ThreadItem } from "../types.ts";

test("evictExcess drops the least-recently-active non-active session over the cap", () => {
  const mk = (id: string, t: number) => ({ ...makeSession(id, 0), lastActiveAt: t });
  const sessions = { a: mk("a", 10), b: mk("b", 20), c: mk("c", 30) } as any;
  const out = evictExcess(sessions, "c", 2);
  expect(Object.keys(out).sort()).toEqual(["b", "c"]); // "a" (oldest, non-active) evicted
  // never evicts the active session even if it's the oldest
  const out2 = evictExcess(sessions, "a", 2);
  expect(out2).toHaveProperty("a");
  expect(Object.keys(out2)).toHaveLength(2);
});

describe("session helpers", () => {
  test("makeSession defaults", () => {
    const s = makeSession("S");
    expect(s).toMatchObject({ id: "S", title: "Untitled", hasContent: false, items: [] });
  });

  test("makeSession stamps agent/cwd/lastActiveAt", () => {
    const s = makeSession("S", 1234, { agentName: "claude", cwd: "/repo" });
    expect(s).toMatchObject({ id: "S", agentName: "claude", cwd: "/repo", lastActiveAt: 1234 });
    const bare = makeSession("T");
    expect(bare).toMatchObject({ agentName: "", cwd: "", lastActiveAt: 0 });
  });

  test("addUserBubble titles the session from first message (truncated at 40)", () => {
    let s = makeSession("S");
    s = addUserBubble(s, "Implement the thing");
    expect(s.title).toBe("Implement the thing");
    expect(s.items[0]).toMatchObject({ kind: "user", text: "Implement the thing" });

    let s2 = addUserBubble(makeSession("S2"), "x".repeat(50));
    expect(s2.title).toBe("x".repeat(40) + "…");
  });

  test("setTitle truncates at 40 with ellipsis", () => {
    const s = setTitle(makeSession("S"), "y".repeat(50));
    expect(s.title).toBe("y".repeat(40) + "…");
  });

  test("applyModelsModes pulls lists + current ids from a session/new result", () => {
    const res: NewSessionResult = {
      sessionId: "S",
      models: { availableModels: [{ modelId: "m1", name: "M1" }], currentModelId: "m1" },
      modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" },
    };
    const { session, models, modes } = applyModelsModes(makeSession("S"), res);
    expect(models).toHaveLength(1);
    expect(modes).toHaveLength(1);
    expect(session.modelId).toBe("m1");
    expect(session.mode).toBe("default");
  });

  test("applyHistoryMessages renders tool blocks as tool cards (status + output), not notes", () => {
    let s = makeSession("S");
    s = applyHistoryMessages(s, [
      { role: "user", blocks: [{ type: "text", text: "do it" }] },
      { role: "assistant", blocks: [
        { type: "text", text: "on it" },
        { type: "tool", name: "Bash", toolCallId: "t1", status: "completed", output: "hello world" },
      ] },
    ]);
    const tool = s.items.find((i) => i.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ kind: "tool", title: "Bash", status: "completed", toolCallId: "t1" });
    // output is surfaced as expandable content (was previously dropped to a "· used X" note)
    expect((tool as Extract<typeof tool, { kind: "tool" }>).content[0].content).toMatchObject({ type: "text", text: "hello world" });
    expect(s.items.some((i) => i.kind === "note" && /used/.test((i as { text: string }).text))).toBe(false);
  });

  test("applyHistoryMessages tool without output has empty content (no crash)", () => {
    let s = applyHistoryMessages(makeSession("S"), [
      { role: "assistant", blocks: [{ type: "tool", name: "Read", toolCallId: "t2" }] },
    ]);
    const tool = s.items.find((i) => i.kind === "tool") as Extract<ThreadItem, { kind: "tool" }>;
    expect(tool.title).toBe("Read");
    expect(tool.status).toBe("completed");
    expect(tool.content).toEqual([]);
  });

  test("contentText extracts text / resource_link / resource / fallback", () => {
    expect(contentText({ type: "text", text: "hi" })).toBe("hi");
    expect(contentText({ type: "resource_link", name: "n" })).toBe("n");
    expect(contentText({ type: "resource", resource: { text: "rt" } })).toBe("rt");
    expect(contentText({ type: "image" })).toBe("[image]");
    expect(contentText(undefined)).toBe("");
  });

  test("contentImage extracts inline / uri image blocks (else null)", () => {
    expect(contentImage({ type: "image", mimeType: "image/png", data: "AAAA" })).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(contentImage({ type: "image", uri: "https://x/y.png" })).toEqual({ mimeType: "image/png", uri: "https://x/y.png" });
    expect(contentImage({ type: "text", text: "hi" })).toBeNull();
    expect(contentImage({ type: "image" })).toBeNull();
    expect(contentImage(undefined)).toBeNull();
  });

  test("contentFile extracts resource_link / embedded resource (else null)", () => {
    expect(contentFile({ type: "resource_link", name: "src/App.tsx", uri: "file:///r/src/App.tsx" }))
      .toEqual({ name: "src/App.tsx", uri: "file:///r/src/App.tsx" });
    expect(contentFile({ type: "resource_link", uri: "file:///r/x" })).toEqual({ name: "file:///r/x", uri: "file:///r/x" });
    expect(contentFile({ type: "resource", resource: { uri: "file:///r/y" } })).toEqual({ name: "file:///r/y", uri: "file:///r/y" });
    expect(contentFile({ type: "text", text: "hi" })).toBeNull();
    expect(contentFile(undefined)).toBeNull();
  });

  test("addUserBubble carries referenced files on the bubble", () => {
    const s = addUserBubble(makeSession("S"), "check this", undefined, [{ name: "src/App.tsx", uri: "file:///r/src/App.tsx" }]);
    expect(s.items[0]).toMatchObject({ kind: "user", text: "check this", files: [{ name: "src/App.tsx", uri: "file:///r/src/App.tsx" }] });
  });

  test("user_message_chunk with a resource_link renders a file chip, not a path string", () => {
    const s = applyUpdate(makeSession("S"), {
      sessionUpdate: "user_message_chunk",
      content: { type: "resource_link", name: "src/App.tsx", uri: "file:///r/src/App.tsx" },
    } as any);
    const user = s.items.find((i) => i.kind === "user") as Extract<ThreadItem, { kind: "user" }>;
    expect(user.files).toEqual([{ name: "src/App.tsx", uri: "file:///r/src/App.tsx" }]);
    expect(user.text).toBe("");
  });

  test("addUserBubble carries attached images on the bubble", () => {
    const s = addUserBubble(makeSession("S"), "look at this", [{ mimeType: "image/png", data: "AAAA" }]);
    expect(s.items[0]).toMatchObject({ kind: "user", text: "look at this", images: [{ mimeType: "image/png", data: "AAAA" }] });
  });

  test("addUserBubble with only an image still creates a bubble", () => {
    const s = addUserBubble(makeSession("S"), "", [{ mimeType: "image/png", data: "AAAA" }]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "user", images: [{ mimeType: "image/png", data: "AAAA" }] });
  });

  test("applyHistoryMessages renders image blocks on user and assistant turns", () => {
    let s = makeSession("S");
    s = applyHistoryMessages(s, [
      { role: "user", blocks: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
      { role: "assistant", blocks: [{ type: "image", mimeType: "image/jpeg", data: "BBBB" }] },
    ]);
    const user = s.items.find((i) => i.kind === "user") as Extract<ThreadItem, { kind: "user" }>;
    expect(user.text).toBe("what is this");
    expect(user.images).toEqual([{ mimeType: "image/png", data: "AAAA", uri: undefined }]);
    const asst = s.items.find((i) => i.kind === "assistant") as Extract<ThreadItem, { kind: "assistant" }>;
    expect(asst.images).toEqual([{ mimeType: "image/jpeg", data: "BBBB", uri: undefined }]);
  });
});
