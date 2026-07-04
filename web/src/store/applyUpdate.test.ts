import { describe, test, expect } from "vitest";
import { makeSession, applyUpdate, addUserBubble } from "./reducers.ts";
import type { Session, SessionUpdate } from "../types.ts";

const up = (u: Partial<SessionUpdate> & { sessionUpdate: string }): SessionUpdate => u as SessionUpdate;
function run(s: Session, ...updates: SessionUpdate[]): Session {
  return updates.reduce(applyUpdate, s);
}

describe("applyUpdate", () => {
  test("agent_message_chunk appends then concatenates into one assistant item", () => {
    let s = makeSession("S");
    s = run(s,
      up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } }),
      up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } }),
    );
    const asst = s.items.filter((i) => i.kind === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0]).toMatchObject({ kind: "assistant", text: "Hello" });
    expect(s.hasContent).toBe(true);
    expect(s.working).toBe(false);
  });

  test("a tool_call between chunks breaks the assistant flow (new bubble after)", () => {
    let s = makeSession("S");
    s = run(s,
      up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A" } }),
      up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read", status: "pending" }),
      up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } }),
    );
    expect(s.items.filter((i) => i.kind === "assistant").map((i: any) => i.text)).toEqual(["A", "B"]);
  });

  test("agent_thought_chunk builds a thought item separate from assistant", () => {
    let s = makeSession("S");
    s = run(s, up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }));
    expect(s.items.find((i) => i.kind === "thought")).toMatchObject({ text: "hmm" });
  });

  test("tool_call then tool_call_update merges by toolCallId (status + content)", () => {
    let s = makeSession("S");
    s = run(s,
      up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit", kind: "edit", status: "in_progress" }),
      up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
           content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }] } as any),
    );
    const tools = s.items.filter((i) => i.kind === "tool") as any[];
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("completed");
    expect(tools[0].content[0]).toMatchObject({ type: "diff", path: "a.ts" });
  });

  test("tool_call_update keeps prior status when update omits it", () => {
    let s = makeSession("S");
    s = run(s,
      up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress" }),
      up({ sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Run (npm test)" } as any),
    );
    const tool = s.items.find((i) => i.kind === "tool") as any;
    expect(tool.status).toBe("in_progress");
    expect(tool.title).toBe("Run (npm test)");
  });

  test("plan upserts a single plan item (latest entries win)", () => {
    let s = makeSession("S");
    s = run(s,
      up({ sessionUpdate: "plan", entries: [{ content: "step1", status: "pending" }] }),
      up({ sessionUpdate: "plan", entries: [{ content: "step1", status: "completed" }, { content: "step2" }] }),
    );
    const plans = s.items.filter((i) => i.kind === "plan") as any[];
    expect(plans).toHaveLength(1);
    expect(plans[0].entries).toHaveLength(2);
    expect(plans[0].entries[0].status).toBe("completed");
  });

  test("current_mode_update sets session.mode", () => {
    let s = makeSession("S");
    s = run(s, up({ sessionUpdate: "current_mode_update", currentModeId: "plan" }));
    expect(s.mode).toBe("plan");
  });

  test("user_message_chunk renders a user bubble (history replay)", () => {
    let s = makeSession("S");
    s = run(s, up({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }));
    expect(s.items.find((i) => i.kind === "user")).toMatchObject({ text: "hi" });
  });

  test("user_message_chunk does not duplicate the local prompt replayed from the gateway ledger", () => {
    let s = { ...addUserBubble(makeSession("S"), "hi"), working: true };
    s = run(s, up({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }));
    expect(s.items.filter((i) => i.kind === "user")).toHaveLength(1);
  });

  test("agent_message_chunk with an image attaches it to the assistant bubble", () => {
    let s = makeSession("S");
    s = run(s,
      up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "here:" } }),
      up({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" } as any }),
    );
    const asst = s.items.filter((i) => i.kind === "assistant") as any[];
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toBe("here:");
    expect(asst[0].images).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  test("an image-only agent chunk creates an assistant bubble with no text", () => {
    let s = makeSession("S");
    s = run(s, up({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/jpeg", data: "BBBB" } as any }));
    const asst = s.items.filter((i) => i.kind === "assistant") as any[];
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toBe("");
    expect(asst[0].images).toEqual([{ mimeType: "image/jpeg", data: "BBBB" }]);
  });

  test("user_message_chunk with an image renders an image bubble", () => {
    let s = makeSession("S");
    s = run(s, up({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "CCCC" } as any }));
    const user = s.items.find((i) => i.kind === "user") as any;
    expect(user.images).toEqual([{ mimeType: "image/png", data: "CCCC" }]);
  });

  test("suppressReplay drops replayed chunks/tools/plan", () => {
    let s: Session = { ...makeSession("S"), suppressReplay: true };
    s = run(s,
      up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }),
      up({ sessionUpdate: "tool_call", toolCallId: "t", title: "T", kind: "read", status: "pending" }),
      up({ sessionUpdate: "plan", entries: [{ content: "p" }] }),
    );
    expect(s.items).toHaveLength(0);
  });

  test("unknown update kind is a no-op", () => {
    const s0 = makeSession("S");
    const s1 = applyUpdate(s0, up({ sessionUpdate: "something_new" }));
    expect(s1.items).toHaveLength(0);
  });
});
