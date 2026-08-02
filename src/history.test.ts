import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { readClaudeHistoryMessages, stripCommandMarkup, listAgentHistory, readAgentHistoryMessages, discoverClaudeHistory, discoverCodexHistory, findClaudeSessionFile, deleteHistorySession, sliceMessages, historyPageParams, searchCandidates } from "./gateway.ts";
import { searchQueryParams } from "./search-core.ts";
import { Db } from "./db.ts";

// The Claude history paths cache derived transcript metadata in the shared prefs
// DB. Tests inject an in-memory one so they never touch the real state.sqlite.
const memStore = () => new Db(":memory:");

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
  const db = new Database(path.join(dir, "opencode.db"));
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

  const sessions = await discoverClaudeHistory({ projectsRoot, fsRoot, limit: 10, store: memStore() });

  assert.deepEqual(sessions, [
    { sessionId: "session-new", title: "newer cli prompt", updatedAt: new Date(3000).toISOString(), cwd: fs.realpathSync(newerCwd), source: "claude-cli" },
    { sessionId: "session-old", title: "older cli prompt", updatedAt: new Date(1000).toISOString(), cwd: fs.realpathSync(inCwd), source: "claude-cli" },
  ]);
});

// Codex's counterpart. The cwd needs no recovering — a rollout's head line
// records it outright — so what matters here is that discovery spans folders
// (the gap that made codex conversations invisible outside the selected one),
// still honours the filesystem root, and ranks by the index's updated_at.
function writeCodexRollout(
  home: string,
  name: string,
  meta: { id: string; cwd: string; timestamp: string },
  userText: string,
): string {
  const dir = path.join(home, "sessions", "2026", "07", "20");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, [
    { type: "session_meta", payload: meta },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

async function withCodexHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}

test("Codex discovery spans folders and filters outside the filesystem root", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codexhome-"));
  const inCwd = path.join(fsRoot, "repo");
  const otherCwd = path.join(fsRoot, "other");
  const outCwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-outside-"));
  fs.mkdirSync(inCwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });

  writeCodexRollout(home, "A", { id: "CDX-A", cwd: inCwd, timestamp: "2026-07-20T10:00:00.000Z" }, "older prompt");
  writeCodexRollout(home, "B", { id: "CDX-B", cwd: otherCwd, timestamp: "2026-07-20T12:00:00.000Z" }, "newer prompt");
  writeCodexRollout(home, "C", { id: "CDX-C", cwd: outCwd, timestamp: "2026-07-20T14:00:00.000Z" }, "out of bounds");
  // The index supplies a thread name and the authoritative recency; a session
  // absent from it falls back to the rollout's own first user message + mtime.
  fs.writeFileSync(path.join(home, "session_index.jsonl"),
    JSON.stringify({ id: "CDX-B", thread_name: "named thread", updated_at: "2026-07-20T12:00:00.000Z" }) + "\n");
  // mtime is what an un-indexed session ranks and dates by.
  fs.utimesSync(path.join(home, "sessions", "2026", "07", "20", "rollout-A.jsonl"), new Date(1000), new Date(1000));

  const sessions = await withCodexHome(home, () => discoverCodexHistory({ fsRoot, limit: 10 }));

  assert.deepEqual(sessions, [
    { sessionId: "CDX-B", title: "named thread", updatedAt: "2026-07-20T12:00:00.000Z", cwd: fs.realpathSync(otherCwd), source: "codex-cli" },
    { sessionId: "CDX-A", title: "older prompt", updatedAt: new Date(1000).toISOString(), cwd: fs.realpathSync(inCwd), source: "codex-cli" },
  ], "both in-root folders listed, newest first; the out-of-root rollout is dropped");
});

// The limit is a recency cut, not an arbitrary one — deriving titles happens
// after it, so a truncated listing must still be the most recent sessions.
test("Codex discovery applies its limit to the most recent sessions", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codexhome-"));
  const cwd = path.join(fsRoot, "repo");
  fs.mkdirSync(cwd, { recursive: true });

  writeCodexRollout(home, "OLD", { id: "CDX-OLD", cwd, timestamp: "2026-07-20T10:00:00.000Z" }, "old");
  writeCodexRollout(home, "NEW", { id: "CDX-NEW", cwd, timestamp: "2026-07-20T10:00:00.000Z" }, "new");
  fs.utimesSync(path.join(home, "sessions", "2026", "07", "20", "rollout-OLD.jsonl"), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(home, "sessions", "2026", "07", "20", "rollout-NEW.jsonl"), new Date(9000), new Date(9000));

  const sessions = await withCodexHome(home, () => discoverCodexHistory({ fsRoot, limit: 1 }));

  assert.deepEqual(sessions.map((s) => [s.sessionId, s.title]), [["CDX-NEW", "new"]]);
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

  const sessions = await listAgentHistory(CLAUDE_CMD, cwd, 10, { projectsRoot, store: memStore() });
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
  const sessions = await listAgentHistory(CLAUDE_CMD, "/some/other/folder", 10, { projectsRoot, store: memStore() });
  assert.deepEqual(sessions, [], "listing stays scoped to the requested cwd");

  // Unknown ids and traversal-shaped ids stay 404.
  assert.equal(await readAgentHistoryMessages(CLAUDE_CMD, "/real/repo", "33333333-aaaa-bbbb-cccc-000000000003", 20, { projectsRoot }), null);
  assert.equal(await findClaudeSessionFile("/real/repo", "../../../etc/passwd", projectsRoot), null, "path-shaped session ids are rejected");
});

// ---------------------------------------------------- transcript recency ----
// A real turn line, carrying the `timestamp` the list's recency is derived from.
function turn(cwd: string, sessionId: string, role: "user" | "assistant", text: string, timestamp: string) {
  return {
    type: role, cwd, sessionId, timestamp, isSidechain: false,
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
  };
}
const encodeProject = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

test("a phantom transcript touch neither reorders the list nor evicts a genuinely-recent session", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-repo-"));
  const project = encodeProject(cwd);
  const store = memStore();
  const at = (iso: string) => Date.parse(iso);
  const staleAt = "2026-07-18T10:00:00.000Z";
  const midAt = "2026-07-22T10:00:00.000Z";
  const freshAt = "2026-07-24T10:00:00.000Z";
  const stale = writeClaudeProjectTranscript(projectsRoot, project, "s-stale",
    [turn(cwd, "s-stale", "user", "stale prompt", staleAt)], at(staleAt));
  writeClaudeProjectTranscript(projectsRoot, project, "s-mid",
    [turn(cwd, "s-mid", "user", "mid prompt", midAt)], at(midAt));
  writeClaudeProjectTranscript(projectsRoot, project, "s-fresh",
    [turn(cwd, "s-fresh", "user", "fresh prompt", freshAt)], at(freshAt));

  // limit 2 of 3 sessions: the cut is where a phantom touch used to do real damage.
  const before = await listAgentHistory(CLAUDE_CMD, cwd, 2, { projectsRoot, store });
  assert.deepEqual(before.map((s) => s.sessionId), ["s-fresh", "s-mid"]);

  // Something rewrote the oldest transcript without appending a turn: mtime jumps
  // to "now" while its content is untouched.
  const phantom = new Date("2026-07-26T10:41:40.000Z");
  fs.utimesSync(stale, phantom, phantom);

  const after = await listAgentHistory(CLAUDE_CMD, cwd, 2, { projectsRoot, store });
  assert.deepEqual(after.map((s) => s.sessionId), ["s-fresh", "s-mid"],
    "the touched session stays last and does not evict the genuinely-recent one");
  assert.deepEqual(after.map((s) => s.updatedAt), [freshAt, midAt], "dates come from the transcripts, not the mtimes");
  store.close();
});

test("an unchanged transcript is answered from the cache without re-reading the file", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-repo-"));
  const store = memStore();
  const file = writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), "s-cached",
    [turn(cwd, "s-cached", "user", "cached title", "2026-07-20T10:00:00.000Z")], Date.parse("2026-07-20T10:00:00.000Z"));

  const first = await listAgentHistory(CLAUDE_CMD, cwd, 10, { projectsRoot, store });
  assert.deepEqual(first, [{ sessionId: "s-cached", title: "cached title", updatedAt: "2026-07-20T10:00:00.000Z" }]);

  // Rewrite the content with the SAME byte length, then restore the mtime, so the
  // (file, size, mtime) triple is unchanged. Getting the old values back proves
  // neither the head nor the tail was read a second time.
  const st = fs.statSync(file);
  fs.writeFileSync(file, JSON.stringify(turn(cwd, "s-cached", "user", "edited title", "2026-07-25T10:00:00.000Z")) + "\n");
  assert.equal(fs.statSync(file).size, st.size, "fixture rewrite must keep the byte length identical");
  fs.utimesSync(file, st.mtime, st.mtime);

  const second = await listAgentHistory(CLAUDE_CMD, cwd, 10, { projectsRoot, store });
  assert.deepEqual(second, first, "cache hit: the edited content was never read");
  store.close();
});

test("recency skips trailing system/bookkeeping lines and comes from the last real turn", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = path.join(fsRoot, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const lastRealTurn = "2026-07-24T16:04:20.000Z";
  // The observed tail: hook/turn/away summaries and a last-prompt line (which has
  // no timestamp at all) written long after the conversation actually ended, plus
  // meta and sidechain user entries that are not the user talking either.
  writeClaudeProjectTranscript(projectsRoot, "-encoded-repo", "s-noise", [
    turn(cwd, "s-noise", "user", "the real prompt", "2026-07-24T16:00:00.000Z"),
    turn(cwd, "s-noise", "assistant", "the real reply", lastRealTurn),
    { type: "system", subtype: "stop_hook_summary", cwd, sessionId: "s-noise", isSidechain: false, timestamp: "2026-07-24T16:04:21.760Z" },
    { type: "system", subtype: "turn_duration", cwd, sessionId: "s-noise", isSidechain: false, isMeta: false, timestamp: "2026-07-24T16:04:21.762Z" },
    { type: "system", subtype: "away_summary", cwd, sessionId: "s-noise", isSidechain: false, isMeta: true, timestamp: "2026-07-26T10:41:40.000Z" },
    { type: "user", cwd, sessionId: "s-noise", isMeta: true, timestamp: "2026-07-26T10:41:41.000Z", message: { role: "user", content: "meta bookkeeping" } },
    { type: "user", cwd, sessionId: "s-noise", isSidechain: true, timestamp: "2026-07-26T10:41:42.000Z", message: { role: "user", content: "sidechain prompt" } },
    { type: "last-prompt", lastPrompt: "the real prompt", leafUuid: "u1", sessionId: "s-noise" },
  ], Date.parse("2026-07-26T10:41:40.000Z"));

  const sessions = await discoverClaudeHistory({ projectsRoot, fsRoot, limit: 10, store: memStore() });
  assert.deepEqual(sessions, [{
    sessionId: "s-noise", title: "the real prompt", updatedAt: lastRealTurn,
    cwd: fs.realpathSync(cwd), source: "claude-cli",
  }]);
});

test("a transcript with no derivable activity sorts last and keeps its mtime date", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = path.join(fsRoot, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const quietMtime = Date.parse("2026-07-26T10:41:40.000Z");
  writeClaudeProjectTranscript(projectsRoot, "-encoded-repo", "s-quiet", [
    { type: "system", subtype: "away_summary", cwd, sessionId: "s-quiet", isSidechain: false, timestamp: "2026-07-26T10:41:40.000Z" },
  ], quietMtime);
  writeClaudeProjectTranscript(projectsRoot, "-encoded-repo", "s-real",
    [turn(cwd, "s-real", "user", "a real prompt", "2026-07-19T09:00:00.000Z")], Date.parse("2026-07-19T09:00:00.000Z"));

  const sessions = await discoverClaudeHistory({ projectsRoot, fsRoot, limit: 10, store: memStore() });
  assert.deepEqual(sessions.map((s) => s.sessionId), ["s-real", "s-quiet"],
    "no derivable activity sorts after every session that has some, newest mtime notwithstanding");
  assert.equal(sessions[1].updatedAt, new Date(quietMtime).toISOString(), "the fallback row still renders a date");
  assert.equal(sessions[1].title, null);
});

test("turn traffic the gateway pumped outranks a stale transcript tail", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = path.join(fsRoot, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const store = memStore();
  const gwActivity = "2026-07-18T10:00:00.000Z"; // what the transcript still says
  const gwMessage = "2026-07-25T10:00:00.000Z";  // the prompt the gateway pumped
  const otherActivity = "2026-07-22T10:00:00.000Z";
  writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), "s-gw",
    [turn(cwd, "s-gw", "user", "gateway prompt", gwActivity)], Date.parse(gwActivity));
  writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), "s-other",
    [turn(cwd, "s-other", "user", "other prompt", otherActivity)], Date.parse(otherActivity));
  store.touchSessionMessage({ agentName: "claude", cwd, sessionId: "s-gw", title: "gateway prompt", at: gwMessage });

  const listed = await listAgentHistory(CLAUDE_CMD, cwd, 10, { projectsRoot, store });
  assert.deepEqual(listed.map((s) => [s.sessionId, s.updatedAt]), [["s-gw", gwMessage], ["s-other", otherActivity]],
    "the DB's turn traffic wins over the transcript's older tail, and drives the order");

  const discovered = await discoverClaudeHistory({ projectsRoot, fsRoot, limit: 10, store });
  assert.deepEqual(discovered.map((s) => [s.sessionId, s.updatedAt]), [["s-gw", gwMessage], ["s-other", otherActivity]],
    "the discovery path merges the same way");
  store.close();
});

// --------------------------------------------------------------- deletion ----
// Deleting a conversation removes it from the agent's OWN store, so each
// provider needs its own primitive. All three are exercised against temp stores
// (projectsRoot / CODEX_HOME / XDG_DATA_HOME) — never the real ones on this host.
const CODEX_CMD = "/opt/acp-gateway/node_modules/.bin/codex-acp";

test("deleting a claude conversation unlinks its transcript and its custom title", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-repo-"));
  const keep = "44444444-aaaa-bbbb-cccc-000000000004";
  const drop = "55555555-aaaa-bbbb-cccc-000000000005";
  const at = "2026-07-20T10:00:00.000Z";
  writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), keep, [turn(cwd, keep, "user", "keep me", at)], Date.parse(at));
  const dropFile = writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), drop, [turn(cwd, drop, "user", "delete me", at)], Date.parse(at));
  // A renamed conversation also has a sidecar entry; it must go with it.
  const sidecar = path.join(projectsRoot, encodeProject(cwd), ".acpb-titles.json");
  fs.writeFileSync(sidecar, JSON.stringify({ [drop]: "custom name", [keep]: "keep name" }));

  assert.equal(await deleteHistorySession([CLAUDE_CMD], drop, { projectsRoot }), true);

  assert.equal(fs.existsSync(dropFile), false, "transcript unlinked");
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")), { [keep]: "keep name" }, "only the deleted session's title is dropped");
  const left = await listAgentHistory(CLAUDE_CMD, cwd, 10, { projectsRoot, store: memStore() });
  assert.deepEqual(left.map((s) => s.sessionId), [keep], "it no longer lists");
  assert.equal(await readAgentHistoryMessages(CLAUDE_CMD, cwd, drop, 20, { projectsRoot }), null, "and no longer opens");
});

test("claude deletion rejects traversal-shaped ids and unknown sessions", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acpb-victim-")), "secret.jsonl");
  fs.writeFileSync(outside, "{}\n");

  assert.equal(await deleteHistorySession([CLAUDE_CMD], "../../../etc/passwd", { projectsRoot }), false);
  assert.equal(await deleteHistorySession([CLAUDE_CMD], "66666666-aaaa-bbbb-cccc-000000000006", { projectsRoot }), false, "unknown id is a no-op");
  assert.equal(fs.existsSync(outside), true, "nothing outside the session store is touched");
  // An agent with no history provider can't delete anything either.
  assert.equal(await deleteHistorySession(["/usr/bin/some-other-agent"], "66666666-aaaa-bbbb-cccc-000000000006", { projectsRoot }), false);
});

// Addressing by id is what makes this work: the sidecar is taken from the
// transcript's OWN directory, so it is cleaned even when the CLI truncated the
// encoded project name and projectDirFor(cwd) points at a dir that never existed
// — the case where a rename's sidecar was already unreadable before this change.
test("claude deletion clears the sidecar in a project dir the gateway can't derive", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-deep-"));
  const sid = "77777777-aaaa-bbbb-cccc-000000000007";
  const at = "2026-07-20T10:00:00.000Z";
  // NOT encodeProject(cwd) — the CLI's truncated-and-hashed name.
  const file = writeClaudeProjectTranscript(projectsRoot, "-truncated-xyz789", sid, [turn(cwd, sid, "user", "delete me", at)], Date.parse(at));
  const sidecar = path.join(projectsRoot, "-truncated-xyz789", ".acpb-titles.json");
  fs.writeFileSync(sidecar, JSON.stringify({ [sid]: "custom name" }));

  assert.equal(await deleteHistorySession([CLAUDE_CMD], sid, { projectsRoot }), true);

  assert.equal(fs.existsSync(file), false, "transcript unlinked");
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")), {}, "the sidecar entry went with it");
});

test("claude deletion is refused for a conversation outside the filesystem root", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-outside-repo-"));
  const sid = "88888888-aaaa-bbbb-cccc-000000000008";
  const at = "2026-07-20T10:00:00.000Z";
  const file = writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), sid, [turn(cwd, sid, "user", "out of bounds", at)], Date.parse(at));

  // withinRoot sees the cwd recorded IN the transcript, not one the caller sent.
  const seen: string[] = [];
  assert.equal(await deleteHistorySession([CLAUDE_CMD], sid, { projectsRoot, withinRoot: (c: string) => { seen.push(c); return false; } }), false);
  assert.deepEqual(seen, [cwd], "the bound is applied to the transcript's own cwd");
  assert.equal(fs.existsSync(file), true, "nothing unlinked");

  assert.equal(await deleteHistorySession([CLAUDE_CMD], sid, { projectsRoot, withinRoot: () => true }), true);
  assert.equal(fs.existsSync(file), false);
});

test("deleting a codex conversation unlinks its rollout and leaves the index alone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codexhome-"));
  const sessionsDir = path.join(home, "sessions", "2026", "07", "20");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const cwd = "/work/repo";
  const file = path.join(sessionsDir, "rollout-S.jsonl");
  fs.writeFileSync(file, [
    { type: "session_meta", payload: { id: "CDX-1", cwd, timestamp: "2026-07-20T10:00:00Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "delete me" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // session_index.jsonl is append-only and joined ONTO the files found on disk,
  // so a stale entry is already invisible — deletion must not rewrite it.
  const index = path.join(home, "session_index.jsonl");
  const indexBefore = JSON.stringify({ id: "CDX-1", thread_name: "codex thread", updated_at: "2026-07-20T10:00:00Z" }) + "\n";
  fs.writeFileSync(index, indexBefore);

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    // withinRoot is checked against the cwd the rollout itself records, so a
    // conversation outside the filesystem root is refused before anything is unlinked.
    assert.equal(await deleteHistorySession([CODEX_CMD], "CDX-1", { withinRoot: () => false }), false, "refused outside the filesystem root");
    assert.equal(fs.existsSync(file), true, "and nothing was unlinked");

    assert.equal(await deleteHistorySession([CODEX_CMD], "CDX-1"), true);
    assert.equal(fs.existsSync(file), false, "rollout unlinked");
    assert.equal(fs.readFileSync(index, "utf8"), indexBefore, "session_index.jsonl untouched");
    assert.deepEqual(await listAgentHistory(CODEX_CMD, cwd, 10), [], "the stale index entry does not resurrect the row");
    assert.equal(await deleteHistorySession([CODEX_CMD], "CDX-1"), false, "deleting again is a no-op");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test("deleting an opencode conversation removes its rows, including sub-agent sessions", async () => {
  const cwd = "/work/repo";
  const xdg = writeOpenCodeStorage({
    sessions: [
      { id: "ses_keep", projectID: "p", directory: cwd, title: "keep", time: { created: 1, updated: 1 } },
      { id: "ses_drop", projectID: "p", directory: cwd, title: "drop", time: { created: 2, updated: 2 } },
      { id: "ses_kid", projectID: "p", parentID: "ses_drop", directory: cwd, title: "sub-agent", time: { created: 3, updated: 3 } },
    ],
    messages: [
      { id: "m_keep", sessionID: "ses_keep", role: "user" },
      { id: "m_drop", sessionID: "ses_drop", role: "user" },
      { id: "m_kid", sessionID: "ses_kid", role: "user" },
    ],
    parts: [
      { id: "p_keep", messageID: "m_keep", sessionID: "ses_keep", type: "text", text: "keep me" },
      { id: "p_drop", messageID: "m_drop", sessionID: "ses_drop", type: "text", text: "delete me" },
      { id: "p_kid", messageID: "m_kid", sessionID: "ses_kid", type: "text", text: "sub-agent work" },
    ],
  });

  await withXdgDataHome(xdg, async () => {
    assert.equal(await deleteHistorySession([OPENCODE_CMD], "ses_keep", { withinRoot: () => false }), false, "refused outside the filesystem root");
    assert.equal(await deleteHistorySession([OPENCODE_CMD], "ses_drop"), true);
    const left = await listAgentHistory(OPENCODE_CMD, cwd, 10);
    assert.deepEqual(left.map((s) => s.sessionId), ["ses_keep"], "only the survivor lists");
    assert.equal(await readAgentHistoryMessages(OPENCODE_CMD, cwd, "ses_drop", 20), null, "and the deleted one no longer opens");
    assert.equal(await deleteHistorySession([OPENCODE_CMD], "ses_drop"), false, "deleting again is a no-op");
  });

  const db = new Database(path.join(xdg, "opencode", "opencode.db"), { readonly: true });
  const ids = (sql: string) => (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids("SELECT id FROM session"), ["ses_keep"], "parent AND its sub-agent session are gone");
  assert.deepEqual(ids("SELECT id FROM message"), ["m_keep"], "their messages are gone");
  assert.deepEqual(ids("SELECT id FROM part"), ["p_keep"], "their parts are gone");
  db.close();
});

test("deleting an opencode conversation with no store on disk creates nothing", async () => {
  // fileMustExist keeps a writable open from conjuring an empty opencode.db on a
  // host that has never run opencode. (The Node 24 branch has no such option and
  // guards with existsSync instead — same behaviour, asserted the same way.)
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-opencode-empty-"));
  await withXdgDataHome(xdg, async () => {
    assert.equal(await deleteHistorySession([OPENCODE_CMD], "ses_nope"), false);
  });
  assert.equal(fs.existsSync(path.join(xdg, "opencode", "opencode.db")), false, "no DB was conjured");
});

test("deletion finds the right provider without being told the agent", async () => {
  // Two agents can share one provider (agents.example.json ships "claude" and
  // "claude-infra"), so an agent name never identified a conversation. Passing
  // every configured agent's cmd, the id alone has to land in the right store —
  // and only configured providers may be touched.
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-repo-"));
  const sid = "99999999-aaaa-bbbb-cccc-000000000009";
  const at = "2026-07-20T10:00:00.000Z";
  const file = writeClaudeProjectTranscript(projectsRoot, encodeProject(cwd), sid, [turn(cwd, sid, "user", "which store?", at)], Date.parse(at));

  const xdg = writeOpenCodeStorage({
    sessions: [{ id: "ses_other", projectID: "p", directory: cwd, title: "opencode one", time: { created: 1, updated: 1 } }],
    messages: [{ id: "m1", sessionID: "ses_other", role: "user" }],
    parts: [{ id: "p1", messageID: "m1", sessionID: "ses_other", type: "text", text: "hi" }],
  });

  await withXdgDataHome(xdg, async () => {
    // Two claude agents plus an opencode one: the claude transcript is found once,
    // not once per agent sharing that provider.
    const cmds = [CLAUDE_CMD, CLAUDE_CMD, OPENCODE_CMD];
    assert.equal(await deleteHistorySession(cmds, sid, { projectsRoot }), true, "the claude id lands in the claude store");
    assert.equal(fs.existsSync(file), false);
    assert.equal(await deleteHistorySession(cmds, "ses_other", { projectsRoot }), true, "the opencode id lands in the opencode store");
    assert.equal(await deleteHistorySession(cmds, "ses_other", { projectsRoot }), false, "and is gone");

    // An unconfigured provider is never consulted: with only claude configured,
    // an opencode id is not found even though its DB is right there.
    const xdg2 = writeOpenCodeStorage({
      sessions: [{ id: "ses_untouched", projectID: "p", directory: cwd, title: "keep", time: { created: 1, updated: 1 } }],
      messages: [{ id: "m2", sessionID: "ses_untouched", role: "user" }],
      parts: [{ id: "p2", messageID: "m2", sessionID: "ses_untouched", type: "text", text: "hi" }],
    });
    await withXdgDataHome(xdg2, async () => {
      assert.equal(await deleteHistorySession([CLAUDE_CMD], "ses_untouched", { projectsRoot }), false);
      const rows = await listAgentHistory(OPENCODE_CMD, cwd, 10);
      assert.deepEqual(rows.map((r) => r.sessionId), ["ses_untouched"], "the opencode row survives");
    });
  });
});

test("sliceMessages without a range returns the last `limit` messages and their start index", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: "user" as const, blocks: [{ type: "text" as const, text: "m" + i }],
  }));

  const r = sliceMessages(msgs, { limit: 3 });

  assert.equal(r.total, 10);
  assert.equal(r.start, 7, "start is the index of the first returned message");
  assert.equal(r.truncated, true);
  assert.deepEqual(r.messages.map((m) => m.blocks[0].text), ["m7", "m8", "m9"]);
});

test("sliceMessages without a range returns everything when the conversation is shorter than the limit", () => {
  const msgs = [{ role: "user" as const, blocks: [{ type: "text" as const, text: "only" }] }];

  const r = sliceMessages(msgs, { limit: 50 });

  assert.equal(r.total, 1);
  assert.equal(r.start, 0, "start 0 means the beginning of the conversation is included");
  assert.equal(r.truncated, false);
  assert.equal(r.messages.length, 1);
});

test("sliceMessages serves an absolute half-open range", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: "user" as const, blocks: [{ type: "text" as const, text: "m" + i }],
  }));

  const r = sliceMessages(msgs, { from: 2, to: 5 });

  assert.deepEqual(r.messages.map((m) => m.blocks[0].text), ["m2", "m3", "m4"], "`to` is exclusive");
  assert.equal(r.start, 2);
  assert.equal(r.total, 10);
  assert.equal(r.truncated, true, "messages older than index 2 exist");
});

test("sliceMessages clamps an out-of-bounds range instead of throwing", () => {
  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: "user" as const, blocks: [{ type: "text" as const, text: "m" + i }],
  }));

  const low = sliceMessages(msgs, { from: -5, to: 2 });
  assert.deepEqual(low.messages.map((m) => m.blocks[0].text), ["m0", "m1"]);
  assert.equal(low.start, 0);
  assert.equal(low.truncated, false, "clamped to the beginning, so nothing older remains");

  const high = sliceMessages(msgs, { from: 3, to: 99 });
  assert.deepEqual(high.messages.map((m) => m.blocks[0].text), ["m3"]);
  assert.equal(high.start, 3);

  const past = sliceMessages(msgs, { from: 10, to: 20 });
  assert.deepEqual(past.messages, [], "a range entirely past the end is empty, not an error");
  assert.equal(past.start, 4);

  const inverted = sliceMessages(msgs, { from: 3, to: 1 });
  assert.deepEqual(inverted.messages, [], "to < from yields an empty page rather than a reversed slice");
  assert.equal(inverted.start, 3);
});

test("sliceMessages caps a range at the 2000-message page limit", () => {
  const msgs = Array.from({ length: 2500 }, (_, i) => ({
    role: "user" as const, blocks: [{ type: "text" as const, text: "m" + i }],
  }));

  const r = sliceMessages(msgs, { from: 0, to: 2500 });

  assert.equal(r.messages.length, 2000, "an oversized range is capped, not rejected");
  assert.equal(r.start, 0);
});

test("readAgentHistoryMessages serves an absolute range for a claude transcript", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const sid = "44444444-aaaa-bbbb-cccc-000000000004";
  const lines = Array.from({ length: 6 }, (_, i) => ({
    type: "user",
    cwd: "/repo",
    sessionId: sid,
    message: { role: "user", content: "m" + i },
  }));
  writeClaudeProjectTranscript(projectsRoot, "-repo", sid, lines, 3000);

  const tail = await readAgentHistoryMessages(CLAUDE_CMD, "/repo", sid, 2, { projectsRoot });
  assert.equal(tail?.total, 6);
  assert.equal(tail?.start, 4, "the default tail page starts at total - limit");

  const older = await readAgentHistoryMessages(CLAUDE_CMD, "/repo", sid, 2, { projectsRoot, from: 1, to: 4 });
  assert.equal(older?.start, 1);
  assert.equal(older?.total, 6);
  assert.deepEqual(
    older?.messages.map((m) => m.blocks[0].text),
    ["m1", "m2", "m3"],
    "the range wins over limit when both are supplied",
  );

  const head = await readAgentHistoryMessages(CLAUDE_CMD, "/repo", sid, 2, { projectsRoot, from: 0, to: 1 });
  assert.equal(head?.start, 0);
  assert.equal(head?.truncated, false, "reaching index 0 reports nothing older");
});

test("repeated page fetches reuse the parsed transcript until the file changes", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-claude-projects-"));
  const sid = "55555555-aaaa-bbbb-cccc-000000000005";
  const line = (i: number) => ({
    type: "user", cwd: "/repo", sessionId: sid, message: { role: "user", content: "m" + i },
  });
  const file = writeClaudeProjectTranscript(projectsRoot, "-repo", sid, [line(0), line(1)], 3000);

  const first = await readAgentHistoryMessages(CLAUDE_CMD, "/repo", sid, 10, { projectsRoot });
  assert.equal(first?.total, 2);

  // Rewrite with a different length AND a new mtime — the cache key must notice.
  const when = new Date(9000);
  fs.writeFileSync(file, [line(0), line(1), line(2)].map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.utimesSync(file, when, when);

  const second = await readAgentHistoryMessages(CLAUDE_CMD, "/repo", sid, 10, { projectsRoot });
  assert.equal(second?.total, 3, "a changed transcript is re-parsed, never served from a stale cache");
});

test("history page params: from/to are optional, integer-only, and range-capped", () => {
  assert.deepEqual(historyPageParams(new URLSearchParams("")), { limit: 120 });
  assert.deepEqual(historyPageParams(new URLSearchParams("limit=50")), { limit: 50 });
  assert.deepEqual(
    historyPageParams(new URLSearchParams("limit=50&from=10&to=60")),
    { limit: 50, from: 10, to: 60 },
  );
  assert.deepEqual(
    historyPageParams(new URLSearchParams("from=abc&to=60")),
    { limit: 120 },
    "a non-numeric bound drops the whole range rather than guessing a bound",
  );
  assert.deepEqual(
    historyPageParams(new URLSearchParams("from=-5&to=99999")),
    { limit: 120, from: 0, to: 2000 },
    "bounds are floored at 0 and the range length capped at MAX_HISTORY_PAGE",
  );
});

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const searchParams = (qs: string) => searchQueryParams(new URLSearchParams(qs), NOW)!;
// A root that contains the fixture cwds without meaningfully restricting them.
// Not "/": resolveWithinRootBase compares against `root + path.sep`, so the
// filesystem root denies everything (see the report's concerns).
const permissiveRoot = () => os.tmpdir();

// A transcript whose recorded activity is OLD but whose mtime was pushed forward
// — the bulk-touch shape measured in the spec (1464 files sharing one mtime).
function writeSkewedTranscript(projectsRoot: string, sessionId: string, cwd: string, activityAt: string, mtimeMs: number, text: string) {
  return writeClaudeProjectTranscript(projectsRoot, "proj", sessionId, [
    { type: "user", cwd, sessionId, timestamp: activityAt, message: { role: "user", content: text } },
  ], mtimeMs);
}

test("search bounds by real activity, never by mtime (I1)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-cwd-"));
  // Real activity 2026-07-01, mtime faked to 2026-08-01.
  writeSkewedTranscript(root, "s-skewed", cwd, "2026-07-01T00:00:00.000Z", Date.parse("2026-08-01T00:00:00.000Z"), "needle in an old turn");

  const scope = { projectsRoot: root, fsRoot: permissiveRoot(), store: memStore() };
  const agents = [{ name: "claude", cmd: CLAUDE_CMD }];

  // `until` that only its MTIME violates must not drop it.
  const kept = await searchCandidates(agents, searchParams("q=needle&all=1&until=2026-07-05T00:00:00Z"), scope);
  assert.deepEqual(kept.candidates.map((c) => c.sessionId), ["s-skewed"]);

  // `since` its MTIME would satisfy must still drop it.
  const dropped = await searchCandidates(agents, searchParams("q=needle&since=2026-07-20T00:00:00Z"), scope);
  assert.deepEqual(dropped.candidates.map((c) => c.sessionId), []);
});

test("search drops sessions outside FS_ROOT and sessions with no recoverable cwd (I2)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-"));
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-in-"));
  const denied = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-out-"));
  const when = Date.parse("2026-08-01T00:00:00.000Z");
  writeSkewedTranscript(root, "s-in", allowed, "2026-08-01T00:00:00.000Z", when, "needle inside");
  writeSkewedTranscript(root, "s-out", denied, "2026-08-01T00:00:00.000Z", when, "needle outside");
  // No cwd recorded anywhere in the transcript.
  writeClaudeProjectTranscript(root, "proj", "s-nocwd", [
    { type: "user", sessionId: "s-nocwd", timestamp: "2026-08-01T00:00:00.000Z", message: { role: "user", content: "needle nowhere" } },
  ], when);

  const r = await searchCandidates([{ name: "claude", cmd: CLAUDE_CMD }], searchParams("q=needle&all=1"),
    { projectsRoot: root, fsRoot: allowed, store: memStore() });
  assert.deepEqual(r.candidates.map((c) => c.sessionId), ["s-in"]);
});

test("search reports opencode as skipped rather than searching it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-"));
  const r = await searchCandidates(
    [{ name: "claude", cmd: CLAUDE_CMD }, { name: "oc", cmd: OPENCODE_CMD }],
    searchParams("q=needle&all=1"), { projectsRoot: root, fsRoot: permissiveRoot(), store: memStore() });
  assert.deepEqual(r.skipped, ["opencode"]);
});

test("search orders by real activity with sessionId breaking ties", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-search-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-cwd-"));
  const stale = Date.parse("2026-08-01T00:00:00.000Z");
  writeSkewedTranscript(root, "s-old", cwd, "2026-07-01T00:00:00.000Z", stale, "needle old");
  writeSkewedTranscript(root, "s-new", cwd, "2026-07-30T00:00:00.000Z", stale, "needle new");
  writeSkewedTranscript(root, "s-tie-a", cwd, "2026-07-30T00:00:00.000Z", stale, "needle tie");

  const r = await searchCandidates([{ name: "claude", cmd: CLAUDE_CMD }], searchParams("q=needle&all=1"),
    { projectsRoot: root, fsRoot: permissiveRoot(), store: memStore() });
  // Order is (recency desc, sessionId desc): the two 07-30 sessions first, and
  // within that tie "s-tie-a" outranks "s-new" because ids sort descending. All
  // three share one mtime, so any mtime-based ranking would scramble this.
  assert.deepEqual(r.candidates.map((c) => c.sessionId), ["s-tie-a", "s-new", "s-old"]);
});
