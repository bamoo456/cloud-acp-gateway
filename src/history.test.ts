import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readClaudeHistoryMessages, stripCommandMarkup, listAgentHistory, readAgentHistoryMessages, discoverClaudeHistory, findClaudeSessionFile } from "./gateway.ts";

// Write a Claude Code transcript (one JSON object per line) to a temp file.
function writeTranscript(lines: unknown[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acpb-hist-")), "S.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function writeClaudeProjectTranscript(projectsRoot: string, projectName: string, sessionId: string, lines: unknown[], mtimeMs: number): string {
  const dir = path.join(projectsRoot, projectName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + ".jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const when = new Date(mtimeMs);
  fs.utimesSync(file, when, when);
  return file;
}

// Build a minimal opencode.db under a temp XDG_DATA_HOME and return its root.
// opencode stores a conversation in a SQLite DB: `session` rows carry the
// metadata as columns, while `message`/`part` rows keep their payload as JSON in
// a `data` column. The fixture only defines the columns the reader queries (so
// part ids needn't be globally unique the way the real schema requires); time is
// optional and defaults to 0, leaving id as the tiebreak the assertions rely on.
const OPENCODE_CMD = "/usr/local/bin/opencode";
function writeOpenCodeStorage(spec: {
  sessions: Array<Record<string, unknown> & { id: string; projectID: string }>;
  messages?: Array<{ sessionID: string; id: string } & Record<string, unknown>>;
  parts?: Array<{ messageID: string; id: string } & Record<string, unknown>>;
}): string {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-opencode-"));
  const dir = path.join(xdg, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  const timeOf = (o: Record<string, unknown>) => (o.time as { created?: number } | undefined)?.created ?? 0;
  const insS = db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)");
  for (const s of spec.sessions) {
    const t = s.time as { created?: number; updated?: number } | undefined;
    insS.run(s.id, (s.parentID as string) ?? null, (s.directory as string) ?? null, (s.title as string) ?? "", t?.created ?? 0, t?.updated ?? 0);
  }
  const insM = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
  for (const m of spec.messages ?? []) insM.run(m.id, m.sessionID, timeOf(m), JSON.stringify(m));
  const insP = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)");
  for (const pt of spec.parts ?? []) insP.run(pt.id, pt.messageID, (pt.sessionID as string) ?? "", timeOf(pt), JSON.stringify(pt));
  db.close();
  return xdg;
}
async function withXdgDataHome<T>(xdg: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
  }
}

test("history drops Claude Code's interrupt markers but keeps real turns", async () => {
  // A turn with 6 parallel tool calls that the user interrupted writes one
  // tool_result + one "[Request interrupted by user for tool use]" per call —
  // exactly the run of identical bubbles seen on mobile.
  const lines: unknown[] = [
    { type: "user", sessionId: "S", message: { role: "user", content: "do the thing" } },
    { type: "assistant", sessionId: "S", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
  ];
  for (const id of ["toolu_1", "toolu_2", "toolu_3", "toolu_4", "toolu_5", "toolu_6"]) {
    lines.push({ type: "user", sessionId: "S", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] } });
    lines.push({ type: "user", sessionId: "S", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
  }
  lines.push({ type: "user", sessionId: "S", message: { role: "user", content: "next prompt" } });

  const file = writeTranscript(lines);
  const { messages } = await readClaudeHistoryMessages(file, "S", 0);

  const texts = messages.flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text ?? ""));
  assert.ok(!texts.some((t) => t.includes("Request interrupted")), "interrupt markers are dropped");
  assert.deepEqual(texts, ["do the thing", "on it", "next prompt"], "real user/assistant turns survive in order");
});

test("Claude discovery recovers cwd from CLI transcripts and filters outside the filesystem root", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const inCwd = path.join(fsRoot, "repo");
  const newerCwd = path.join(fsRoot, "newer");
  const outCwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-outside-"));
  fs.mkdirSync(inCwd, { recursive: true });
  fs.mkdirSync(newerCwd, { recursive: true });

  writeClaudeProjectTranscript(projectsRoot, "-encoded-repo", "session-old", [
    { type: "summary", cwd: inCwd, sessionId: "session-old" },
    { type: "user", cwd: inCwd, sessionId: "session-old", message: { role: "user", content: "older cli prompt" } },
  ], 1000);
  writeClaudeProjectTranscript(projectsRoot, "-encoded-newer", "session-new", [
    { type: "user", cwd: newerCwd, sessionId: "session-new", message: { role: "user", content: "newer cli prompt" } },
  ], 3000);
  writeClaudeProjectTranscript(projectsRoot, "-encoded-outside", "session-out", [
    { type: "user", cwd: outCwd, sessionId: "session-out", message: { role: "user", content: "outside prompt" } },
  ], 5000);
  writeClaudeProjectTranscript(projectsRoot, "-encoded-agent", "agent-sidechain", [
    { type: "user", cwd: inCwd, sessionId: "agent-sidechain", message: { role: "user", content: "ignore sidechain" } },
  ], 7000);

  const sessions = await discoverClaudeHistory({ projectsRoot, fsRoot, limit: 10 });

  assert.deepEqual(sessions, [
    { sessionId: "session-new", title: "newer cli prompt", updatedAt: new Date(3000).toISOString(), cwd: fs.realpathSync(newerCwd), source: "claude-cli" },
    { sessionId: "session-old", title: "older cli prompt", updatedAt: new Date(1000).toISOString(), cwd: fs.realpathSync(inCwd), source: "claude-cli" },
  ]);
});

test("history surfaces image content blocks (base64 + url sources)", async () => {
  const file = writeTranscript([
    { type: "user", sessionId: "S", message: { role: "user", content: [
      { type: "text", text: "what's this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] } },
    { type: "assistant", sessionId: "S", message: { role: "assistant", content: [
      { type: "image", source: { type: "url", url: "https://x/y.jpg" } },
    ] } },
  ]);
  const { messages } = await readClaudeHistoryMessages(file, "S", 0);

  const user = messages.find((m) => m.role === "user")!;
  assert.deepEqual(user.blocks, [
    { type: "text", text: "what's this?" },
    { type: "image", mimeType: "image/png", data: "AAAA" },
  ]);

  const asst = messages.find((m) => m.role === "assistant")!;
  assert.deepEqual(asst.blocks, [{ type: "image", mimeType: "image/png", uri: "https://x/y.jpg" }]);
});

test("stripCommandMarkup removes slash-command wrapper blocks but keeps real text", () => {
  // The invocation markup + its stdout, as Claude Code stores it for `/model default`.
  const expanded = [
    "<command-message>model</command-message>",
    "<command-name>/model</command-name>",
    "<command-args>default</command-args>",
    "<local-command-stdout>Set model to claude-opus-4-8[1m]</local-command-stdout>",
  ].join("\n");
  assert.equal(stripCommandMarkup(expanded), "", "pure command markup collapses to nothing");

  // The "Caveat:" preamble and a <system-reminder> block are both stripped.
  const caveat = "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.";
  assert.equal(stripCommandMarkup(caveat), "");
  assert.equal(stripCommandMarkup("<system-reminder>ignore me</system-reminder>"), "");
  assert.equal(stripCommandMarkup("<local-command-caveat></local-command-caveat>"), "");

  // A genuine user prompt with angle brackets is untouched.
  assert.equal(stripCommandMarkup("compare <a> and <b> in the diff"), "compare <a> and <b> in the diff");
  // A custom command that expands into a real prompt keeps the prompt body.
  assert.equal(
    stripCommandMarkup("<command-name>/refactor</command-name>\nPlease refactor the parser"),
    "Please refactor the parser",
  );
});

test("history strips leaked slash-command markup, live or on resume", async () => {
  const file = writeTranscript([
    { type: "user", sessionId: "S", message: { role: "user", content: "real prompt" } },
    { type: "user", sessionId: "S", message: { role: "user", content: [
      { type: "text", text: "<command-name>/model</command-name>\n<command-args>default</command-args>" },
    ] } },
    { type: "user", sessionId: "S", message: { role: "user", content: [
      { type: "text", text: "<local-command-stdout>Set model to claude-opus-4-8[1m]</local-command-stdout>" },
    ] } },
    { type: "assistant", sessionId: "S", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ]);
  const { messages } = await readClaudeHistoryMessages(file, "S", 0);
  const texts = messages.flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text ?? ""));
  assert.deepEqual(texts, ["real prompt", "done"], "only genuine turns survive; command markup is dropped");
});

test("a plain interrupt marker is dropped too", async () => {
  const file = writeTranscript([
    { type: "user", sessionId: "S", message: { role: "user", content: "hello" } },
    { type: "user", sessionId: "S", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  ]);
  const { messages, total } = await readClaudeHistoryMessages(file, "S", 0);
  assert.equal(total, 1, "only the real message is counted");
  assert.equal(messages[0].blocks[0].type === "text" && messages[0].blocks[0].text, "hello");
});

test("opencode history lists the cwd's sessions and assembles its multi-file parts", async () => {
  const cwd = "/workspace/proj";
  const otherCwd = "/workspace/other";
  const xdg = writeOpenCodeStorage({
    sessions: [
      // A normal session in the target cwd.
      { id: "ses_aaa", projectID: "prj1", directory: cwd, title: "My opencode chat", time: { created: 1000, updated: 5000 } },
      // A child (sub-agent) session — excluded by its parentID.
      { id: "ses_bbb", projectID: "prj1", directory: cwd, parentID: "ses_aaa", title: "subagent", time: { created: 2000, updated: 6000 } },
      // A session in a different project dir — excluded by cwd mismatch.
      { id: "ses_ccc", projectID: "prj2", directory: otherCwd, title: "elsewhere", time: { created: 3000, updated: 7000 } },
    ],
    messages: [
      { id: "msg_001", sessionID: "ses_aaa", role: "user", time: { created: 1000 } },
      { id: "msg_002", sessionID: "ses_aaa", role: "assistant", time: { created: 1500 } },
    ],
    parts: [
      { id: "prt_001", messageID: "msg_001", type: "text", text: "hello opencode" },
      { id: "prt_001", messageID: "msg_002", type: "reasoning", text: "thinking it through" },
      { id: "prt_002", messageID: "msg_002", type: "tool", tool: "read", callID: "call_1", state: { status: "completed", output: "file contents" } },
      { id: "prt_003", messageID: "msg_002", type: "step-finish", tokens: {}, cost: 0 },
      { id: "prt_004", messageID: "msg_002", type: "text", text: "done" },
    ],
  });
  await withXdgDataHome(xdg, async () => {
    const sessions = await listAgentHistory(OPENCODE_CMD, cwd, 10);
    assert.deepEqual(sessions, [
      { sessionId: "ses_aaa", title: "My opencode chat", updatedAt: new Date(5000).toISOString() },
    ], "only the cwd's top-level sessions are listed (children and other cwds dropped)");

    const { messages, total } = await readAgentHistoryMessages(OPENCODE_CMD, cwd, "ses_aaa", 20) ?? { messages: [], total: 0 };
    assert.equal(total, 2);
    assert.deepEqual(messages[0], { role: "user", blocks: [{ type: "text", text: "hello opencode" }] });
    assert.deepEqual(messages[1], {
      role: "assistant",
      blocks: [
        { type: "thought", text: "thinking it through" },
        { type: "tool", name: "read", toolCallId: "call_1", status: "completed", output: "file contents" },
        // step-finish carries nothing renderable and is dropped.
        { type: "text", text: "done" },
      ],
    }, "parts assemble in id order; tool state pairs onto the tool block");
  });
});

test("opencode history falls back to the first user text when a session has no title", async () => {
  const cwd = "/workspace/proj";
  const xdg = writeOpenCodeStorage({
    sessions: [{ id: "ses_zzz", projectID: "prj1", directory: cwd, time: { created: 1, updated: 2 } }],
    messages: [{ id: "msg_001", sessionID: "ses_zzz", role: "user", time: { created: 1 } }],
    parts: [{ id: "prt_001", messageID: "msg_001", type: "text", text: "  fix the   parser please  " }],
  });
  await withXdgDataHome(xdg, async () => {
    const sessions = await listAgentHistory(OPENCODE_CMD, cwd, 10);
    assert.equal(sessions[0].title, "fix the parser please", "whitespace-collapsed first user text is the fallback title");
  });
});

test("opencode history hides empty sessions (the rows session/new leaves before a prompt)", async () => {
  const cwd = "/workspace/proj";
  const xdg = writeOpenCodeStorage({
    sessions: [
      // A real conversation in the cwd.
      { id: "ses_real", projectID: "prj1", directory: cwd, title: "Real chat", time: { created: 1000, updated: 5000 } },
      // An empty session in the same cwd — opencode persisted it on session/new,
      // but no message was ever sent. It must not appear in the history list.
      { id: "ses_empty", projectID: "prj1", directory: cwd, title: "New session - ...", time: { created: 2000, updated: 9000 } },
    ],
    messages: [{ id: "msg_001", sessionID: "ses_real", role: "user", time: { created: 1000 } }],
    parts: [{ id: "prt_001", messageID: "msg_001", type: "text", text: "hello" }],
  });
  await withXdgDataHome(xdg, async () => {
    const sessions = await listAgentHistory(OPENCODE_CMD, cwd, 10);
    assert.deepEqual(sessions.map((s) => s.sessionId), ["ses_real"], "the empty session is dropped even though it sorts newest");
  });
});

test("opencode history won't read a session belonging to a different cwd", async () => {
  const cwd = "/workspace/proj";
  const xdg = writeOpenCodeStorage({
    sessions: [{ id: "ses_aaa", projectID: "prj1", directory: "/workspace/other", title: "elsewhere", time: { created: 1, updated: 2 } }],
    messages: [{ id: "msg_001", sessionID: "ses_aaa", role: "user", time: { created: 1 } }],
    parts: [{ id: "prt_001", messageID: "msg_001", type: "text", text: "secret" }],
  });
  await withXdgDataHome(xdg, async () => {
    const res = await readAgentHistoryMessages(OPENCODE_CMD, cwd, "ses_aaa", 20);
    assert.equal(res, null, "a cwd mismatch is rejected even though the id is valid");
  });
});

// The CLI truncates encoded project dir names it considers too long and appends
// a short hash, so the gateway's computed <encoded cwd> name can point at a dir
// that was never created even though the transcript exists. The fallbacks must
// recover both the per-cwd listing (by the transcript's recorded cwd) and the
// message view (by session id), including when the client sent a stale cwd.
const CLAUDE_CMD = "/opt/acp-gateway/node_modules/.bin/claude-agent-acp";
test("claude history survives a project dir name the gateway can't derive (CLI long-path truncation)", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-deep-"));
  // NOT encodeProjectPath(cwd): simulate the CLI's truncated-and-hashed name.
  writeClaudeProjectTranscript(projectsRoot, "-truncated-name-abc123", "11111111-aaaa-bbbb-cccc-000000000001", [
    { type: "user", cwd, sessionId: "11111111-aaaa-bbbb-cccc-000000000001", message: { role: "user", content: "deep prompt" } },
    { type: "assistant", cwd, sessionId: "11111111-aaaa-bbbb-cccc-000000000001", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
  ], 3000);

  const sessions = await listAgentHistory(CLAUDE_CMD, cwd, 10, { projectsRoot });
  assert.deepEqual(sessions.map((s) => s.sessionId), ["11111111-aaaa-bbbb-cccc-000000000001"], "listing resolves the dir via the transcript's recorded cwd");

  const r = await readAgentHistoryMessages(CLAUDE_CMD, cwd, "11111111-aaaa-bbbb-cccc-000000000001", 20, { projectsRoot });
  assert.equal(r?.messages.length, 2, "messages resolve even though encodeProjectPath(cwd) has no dir");
});

test("claude messages resolve by session id when the client sent the wrong cwd", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  writeClaudeProjectTranscript(projectsRoot, "-real-repo", "22222222-aaaa-bbbb-cccc-000000000002", [
    { type: "user", cwd: "/real/repo", sessionId: "22222222-aaaa-bbbb-cccc-000000000002", message: { role: "user", content: "hi" } },
  ], 3000);

  // Stale/empty client cwd falls back to the agent default server-side; the
  // session must still open (looked up by its unambiguous UUID filename).
  const r = await readAgentHistoryMessages(CLAUDE_CMD, "/some/other/folder", "22222222-aaaa-bbbb-cccc-000000000002", 20, { projectsRoot });
  assert.equal(r?.messages.length, 1, "wrong-cwd view still finds the transcript");

  // But a wrong cwd must NOT leak other projects' sessions into the LIST.
  const sessions = await listAgentHistory(CLAUDE_CMD, "/some/other/folder", 10, { projectsRoot });
  assert.deepEqual(sessions, [], "listing stays scoped to the requested cwd");

  // Unknown ids and traversal-shaped ids stay 404.
  assert.equal(await readAgentHistoryMessages(CLAUDE_CMD, "/real/repo", "33333333-aaaa-bbbb-cccc-000000000003", 20, { projectsRoot }), null);
  assert.equal(await findClaudeSessionFile("/real/repo", "../../../etc/passwd", projectsRoot), null, "path-shaped session ids are rejected");
});
