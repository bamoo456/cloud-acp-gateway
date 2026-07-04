// Init script injected into the page BEFORE the app boots. The gateway speaks a
// single transport: a downstream SSE stream (GET /acp/sse) plus upstream POSTs
// (POST /acp/rpc). We fake it by overriding window.fetch — the SSE GET returns a
// live ReadableStream we control, and each upstream POST's JSON-RPC reply is
// pushed back onto that stream, exactly as the real gateway relays it. After
// session/new we stream a long alternating conversation as session/update
// notifications — enough to overflow the viewport — so the real app renders a
// realistic long thread with no gateway/agent backend.
//
// The store processes identical JSON-RPC frames regardless of transport, so this
// is a faithful port of the old window.WebSocket seed onto SSE+POST delivery.
// Non-transport fetches (/history, /fs, …) fall through to the real fetch, so
// Playwright's page.route() still intercepts them.
//
// Exported as a string because Playwright's addInitScript serializes it into the
// page; keeping it as a standalone function body avoids closure/scope surprises.
export const SEED_SSE = (turns: number): string => `
(() => {
  const TURNS = ${turns};
  const PARA = "The current branch is feature/LA-70449-design-accumulative-review-strategy-1. " +
    "Based on the branch name and recent commit, the focus is designing an accumulative review strategy " +
    "under Jira ticket LA-70449. The latest work added a draft design doc for it.";
  const enc = new TextEncoder();
  let controller = null;
  let seq = 0;
  const push = (obj) => {
    if (!controller) return;
    seq += 1;
    controller.enqueue(enc.encode("id:" + seq + "\\ndata:" + JSON.stringify(obj) + "\\n\\n"));
  };
  const note = (sid, kind, text) => push({ jsonrpc: "2.0", method: "session/update",
    params: { sessionId: sid, update: { sessionUpdate: kind, content: { type: "text", text } } } });
  const seedConv = (sid) => {
    for (let i = 0; i < TURNS; i++) {
      note(sid, "user_message_chunk", "what's the branch focus on now? (#" + i + ")");
      note(sid, "agent_message_chunk", PARA + " " + PARA);
    }
    // Rich finale (shown at the bottom after auto-scroll) for visual previews:
    // user bubble, serif reply, a tool card, and a markdown table.
    note(sid, "user_message_chunk", "Help me check which models in the LLM-GW may be deprecated soon?");
    note(sid, "agent_message_chunk", "I'll check the gateway config, then verify the live provider retirement schedules.");
    push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: {
      sessionUpdate: "tool_call", toolCallId: "tc1", title: "Bash", kind: "execute", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "$ grep -rl 'model:' service-config/virtual-models/\\n→ 18 virtual models across 4 providers" } }],
    } } });
    note(sid, "agent_message_chunk", "Here are the models retiring within **~6 months** — act on these first:\\n\\n| Model | Retires | Replace with |\\n|---|---|---|\\n| gemini-2.0-flash | 2026-06-24 | gemini-2.5-flash |\\n| imagen-3.0-capability-001 | 2026-08-01 | imagen-4.0-generate-001 |\\n\\nWant me to open the config PR to bump these, or post the full table to Slack?");
  };
  let nextSession = 0;
  const handle = (m) => {
    if (m.id == null || !m.method) return; // notifications need no reply
    let result = {};
    if (m.method === "session/new") {
      nextSession += 1;
      const sid = "sess-" + nextSession;
      result = { sessionId: sid,
        // a deliberately long model name — exercises composer-row truncation on narrow screens
        models: { availableModels: [{ modelId: "m", name: "Default (recommended)" }], currentModelId: "m" },
        modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" } };
      if (nextSession === 1) setTimeout(() => seedConv(sid), 0); // seed conversation for first session only
    } else if (m.method === "session/load") {
      const sid = (m.params && m.params.sessionId) || "sess-1";
      result = { sessionId: sid,
        models: { availableModels: [{ modelId: "m", name: "Default (recommended)" }], currentModelId: "m" },
        modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" } };
    }
    push({ jsonrpc: "2.0", id: m.id, result });
  };
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    if (method === "POST" && url.indexOf("/acp/rpc") >= 0) {
      let m = null; try { m = JSON.parse((init && init.body) || "{}"); } catch (e) {}
      if (m) handle(m);
      return Promise.resolve(new Response("", { status: 202 }));
    }
    if (url.indexOf("/acp/sse") >= 0) {
      const stream = new ReadableStream({ start(c) {
        controller = c;
        c.enqueue(enc.encode("event: ready\\ndata:{\\"conn\\":\\"c0\\"}\\n\\n"));
      } });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }
    return _fetch(input, init);
  };
})();
`;
