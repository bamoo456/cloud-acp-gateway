import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadAgents,
  agentKindFor,
  supportsClaudeHistory,
  supportsAgentHistory,
  supportsHistoryDiscovery,
  supportsAgentSessionLoad,
  agentSkinFor,
  listAgentHistory,
  readAgentHistoryMessages,
  GATEWAY_VERSION,
} from "./gateway.ts";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("agents.example.json defines a codex agent using the codex-acp adapter", () => {
  const example = path.join(__dirname, "..", "agents.example.json");
  withEnv({ ACPG_AGENTS_FILE: example, ACPG_AGENT_CWD: undefined }, () => {
    const agents = loadAgents();
    assert.ok(agents.codex, "example config should include a codex agent");
    // resolveCmd: relative cmds resolve against the gateway install dir, so the
    // example must point at the locally installed adapter binary (never npx).
    assert.ok(path.isAbsolute(agents.codex.cmd));
    assert.ok(agents.codex.cmd.endsWith(path.join("node_modules", ".bin", "codex-acp")));
  });
});

test("history browsing is supported for Claude and Codex ACP agents", () => {
  assert.equal(supportsClaudeHistory("/opt/acp-gateway/node_modules/.bin/claude-agent-acp"), true);
  assert.equal(supportsAgentHistory("/opt/acp-gateway/node_modules/.bin/claude-agent-acp"), true);
  assert.equal(supportsAgentHistory("/opt/acp-gateway/node_modules/.bin/codex-acp"), true);
  assert.equal(supportsAgentHistory("/usr/bin/npx"), false);
  assert.equal(supportsAgentSessionLoad("/opt/acp-gateway/node_modules/.bin/claude-agent-acp"), true);
  // codex-acp used to be guessed false. observedSessionLoad is in-memory, so every
  // restart reverted codex to that stale guess, and the sidebar's Recent tab
  // hard-drops any agent advertising sessionLoad:false — hiding every codex row.
  // The guess is optimistic now; initialize corrects it downward if it's wrong.
  assert.equal(supportsAgentSessionLoad("/opt/acp-gateway/node_modules/.bin/codex-acp"), true);
});

test("history and session/load are supported for opencode (`opencode acp`)", () => {
  // opencode runs as `opencode acp`, so the configured binary is just `opencode`.
  assert.equal(supportsAgentHistory("/usr/local/bin/opencode"), true);
  // opencode's ACP advertises loadSession: true, so resume is allowed up front.
  assert.equal(supportsAgentSessionLoad("/usr/local/bin/opencode"), true);
  // opencode gets its own skin (dark neutral accent) so the UI isn't the
  // default orange claude accent.
  assert.equal(agentSkinFor("/usr/local/bin/opencode"), "opencode");
});

test("agents.example.json defines an opencode agent running `opencode acp`", () => {
  // The example file documents a config users copy. It points at
  // /usr/local/bin/opencode, which won't exist on a test host without opencode
  // installed — loadAgents will then drop the entry. So we test the example
  // file's *shape* (raw JSON) rather than feeding it through loadAgents.
  const example = path.join(__dirname, "..", "agents.example.json");
  const raw = JSON.parse(fs.readFileSync(example, "utf8")) as Record<string, { cmd: string; args: string[]; cwd?: string }>;
  assert.ok(raw.opencode, "example config should describe an opencode agent");
  assert.deepEqual(raw.opencode.args, ["acp"]);
  // Absolute cmd is the documented recommendation (a bare `opencode` would
  // resolve against the gateway install dir, not $PATH).
  assert.ok(path.isAbsolute(raw.opencode.cmd));
});

test("loadAgents with an opencode entry whose binary exists keeps the agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agents-"));
  const fakeBin = path.join(dir, "opencode");
  fs.writeFileSync(fakeBin, "");
  fs.chmodSync(fakeBin, 0o755);
  try {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({
      opencode: { cmd: fakeBin, args: ["acp"] },
    }));
    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
      const agents = loadAgents();
      assert.ok(agents.opencode, "present binary should be kept");
      assert.deepEqual(agents.opencode.args, ["acp"]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgents preserves configured names that shadow Object properties", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agent-names-"));
  const fakeBin = path.join(dir, "agent");
  fs.writeFileSync(fakeBin, "");
  fs.chmodSync(fakeBin, 0o755);
  try {
    const file = path.join(dir, "agents.json");
    const raw: Record<string, unknown> = {};
    for (const name of ["constructor", "__proto__", "toString"]) {
      Object.defineProperty(raw, name, {
        value: { cmd: fakeBin, args: [] },
        enumerable: true,
      });
    }
    fs.writeFileSync(file, JSON.stringify(raw));

    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
      const agents = loadAgents();
      assert.equal(Object.getPrototypeOf(agents), null);
      for (const name of ["constructor", "__proto__", "toString"]) {
        assert.equal(agents[name].cmd, fakeBin);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgents accepts literal per-agent env without changing the profile shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agent-env-"));
  const fakeBin = path.join(dir, "codex-acp");
  fs.writeFileSync(fakeBin, "");
  fs.chmodSync(fakeBin, 0o755);
  const home = path.join(dir, "codex-home");
  try {
    const file = path.join(dir, "agents.json");
    const rawEnv = { CODEX_HOME: home, ACPG_INHERITED: "from-profile" } as Record<string, string>;
    Object.defineProperty(rawEnv, "__proto__", { value: "safe-value", enumerable: true });
    fs.writeFileSync(file, JSON.stringify({
      personal: {
        cmd: fakeBin,
        args: [],
        env: rawEnv,
      },
    }));

    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
      const agents = loadAgents();
      assert.equal(agents.personal.env?.CODEX_HOME, home);
      assert.equal(agents.personal.env?.ACPG_INHERITED, "from-profile");
      assert.deepEqual(Object.keys(agents.personal.env ?? {}).sort(), ["ACPG_INHERITED", "CODEX_HOME", "__proto__"]);
      assert.equal(Object.prototype.hasOwnProperty.call(agents.personal.env, "__proto__"), true);
      assert.equal(agents.personal.env?.["__proto__"], "safe-value");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgents rejects malformed env values and unsafe CODEX_HOME paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agent-env-"));
  const fakeBin = path.join(dir, "codex-acp");
  fs.writeFileSync(fakeBin, "");
  fs.chmodSync(fakeBin, 0o755);
  const cases: Array<{ env: unknown; message: RegExp }> = [
    { env: null, message: /expected an object/ },
    { env: ["not-an-object"], message: /expected an object/ },
    { env: { "BAD-KEY": "value" }, message: /invalid env key/ },
    { env: { ACPG_NUMBER: 1 }, message: /must be a string/ },
    { env: { ACPG_NUL: "bad\0value" }, message: /must not contain NUL/ },
    { env: { CODEX_HOME: "relative/home" }, message: /CODEX_HOME.*absolute path/ },
    { env: { CODEX_HOME: "" }, message: /CODEX_HOME.*absolute path/ },
    { env: { HOME: "relative/home" }, message: /HOME.*absolute path/ },
    { env: { HOME: "" }, message: /HOME.*absolute path/ },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const file = path.join(dir, `agents-${i}.json`);
      fs.writeFileSync(file, JSON.stringify({ codex: { cmd: fakeBin, args: [], env: c.env } }));
      withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
        assert.throws(() => loadAgents(), c.message);
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Claude adapter was renamed claude-code-acp -> claude-agent-acp; the old
// binary name must still be detected so pre-migration agents.json keeps working.
test("the legacy claude-code-acp binary name is still recognized as Claude", () => {
  assert.equal(supportsClaudeHistory("/opt/acp-gateway/node_modules/.bin/claude-code-acp"), true);
  assert.equal(supportsAgentHistory("/opt/acp-gateway/node_modules/.bin/claude-code-acp"), true);
  assert.equal(supportsAgentSessionLoad("/opt/acp-gateway/node_modules/.bin/claude-code-acp"), true);
  assert.equal(agentSkinFor("/opt/acp-gateway/node_modules/.bin/claude-code-acp"), undefined);
});

test("Codex ACP agents advertise the Codex skin", () => {
  assert.equal(agentSkinFor("/opt/acp-gateway/node_modules/.bin/codex-acp"), "codex");
  assert.equal(agentSkinFor("/opt/acp-gateway/node_modules/.bin/claude-agent-acp"), undefined);
});

test("Codex history lists archived sessions and reads messages for the cwd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codex-history-"));
  const cwd = path.join(dir, "project");
  const otherCwd = path.join(dir, "other");
  const codexHome = path.join(dir, "codex-home");
  const archived = path.join(codexHome, "archived_sessions");
  const sessionId = "019eb111-2222-7333-8444-555555555555";
  fs.mkdirSync(archived, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "session_index.jsonl"), [
    JSON.stringify({ id: sessionId, thread_name: "Codex archived work", updated_at: "2026-06-11T01:02:03.000Z" }),
    JSON.stringify({ id: "019eb999-2222-7333-8444-555555555555", thread_name: "Other project", updated_at: "2026-06-11T01:03:03.000Z" }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(archived, `rollout-2026-06-11T09-02-03-${sessionId}.jsonl`), [
    { type: "session_meta", payload: { id: sessionId, timestamp: "2026-06-11T01:00:00.000Z", cwd } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } },
    { type: "response_item", payload: { type: "function_call", name: "read_file", call_id: "call_1", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "file contents" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  fs.writeFileSync(path.join(archived, "rollout-2026-06-11T09-03-03-019eb999-2222-7333-8444-555555555555.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "019eb999-2222-7333-8444-555555555555", timestamp: "2026-06-11T01:03:00.000Z", cwd: otherCwd } }),
  ].join("\n") + "\n");

  try {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const sessions = await listAgentHistory("/opt/acp-gateway/node_modules/.bin/codex-acp", cwd, 10);
      assert.deepEqual(sessions, [{ sessionId, title: "Codex archived work", updatedAt: "2026-06-11T01:02:03.000Z" }]);

      const messages = await readAgentHistoryMessages("/opt/acp-gateway/node_modules/.bin/codex-acp", cwd, sessionId, 20);
      assert.ok(messages);
      assert.equal(messages.total, 3);
      assert.equal(messages.messages[0].role, "user");
      assert.equal(messages.messages[0].blocks[0].text, "hello codex");
      assert.equal(messages.messages[1].blocks[0].type, "tool");
      assert.equal(messages.messages[1].blocks[0].name, "read_file");
      assert.equal(messages.messages[1].blocks[0].output, "file contents");
      assert.equal(messages.messages[2].role, "assistant");
      assert.equal(messages.messages[2].blocks[0].text, "done");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex history lists active sessions from CODEX_HOME sessions and reads messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codex-active-history-"));
  const cwd = path.join(dir, "project");
  const codexHome = path.join(dir, "codex-home");
  const activeDir = path.join(codexHome, "sessions", "2026", "06", "11");
  const sessionId = "019eb222-3333-7444-8555-666666666666";
  const updatedAt = "2026-06-11T02:05:00.000Z";
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const activeFile = path.join(activeDir, `rollout-2026-06-11T10-02-03-${sessionId}.jsonl`);
  fs.writeFileSync(activeFile, [
    { type: "session_meta", payload: { id: sessionId, timestamp: "2026-06-11T02:00:00.000Z", cwd } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nskip this\n</INSTRUCTIONS>" },
          { type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" },
        ],
      },
    },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "active codex session" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "still here after reload" }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  fs.utimesSync(activeFile, new Date(updatedAt), new Date(updatedAt));

  try {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const sessions = await listAgentHistory("/opt/acp-gateway/node_modules/.bin/codex-acp", cwd, 10);
      assert.deepEqual(sessions, [{
        sessionId,
        title: "active codex session",
        updatedAt,
      }]);

      const messages = await readAgentHistoryMessages("/opt/acp-gateway/node_modules/.bin/codex-acp", cwd, sessionId, 20);
      assert.ok(messages);
      assert.equal(messages.total, 2);
      assert.equal(messages.messages[0].blocks[0].text, "active codex session");
      assert.equal(messages.messages[1].blocks[0].text, "still here after reload");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ACPG_AGENT_CWD is the default cwd for agents.json entries without cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agents-"));
  try {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({
      claude: { cmd: "node_modules/.bin/claude-agent-acp", args: [] },
      infra: { cmd: "node_modules/.bin/claude-agent-acp", args: [], cwd: "/explicit/project" },
    }));

    withEnv({
      ACPG_AGENTS_FILE: file,
      ACPG_AGENT_CWD: "/env/default-project",
    }, () => {
      const agents = loadAgents();
      assert.equal(agents.claude.cwd, "/env/default-project");
      assert.equal(agents.infra.cwd, "/explicit/project");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without ACPG_AGENT_CWD, entries omitting cwd default to the home dir (~)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agents-"));
  try {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({
      claude: { cmd: "node_modules/.bin/claude-agent-acp", args: [] },
      codex: { cmd: "node_modules/.bin/codex-acp", args: [] },
    }));

    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
      const agents = loadAgents();
      assert.equal(agents.claude.cwd, os.homedir());
      assert.equal(agents.codex.cwd, os.homedir());
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgents drops entries whose cmd file does not exist on this host", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agents-"));
  // Touch a "claude" binary so the host-has-claude path is exercised, leave
  // the opencode one pointing at a path that doesn't exist.
  const fakeBin = path.join(dir, "claude-agent-acp");
  fs.writeFileSync(fakeBin, "");
  fs.chmodSync(fakeBin, 0o755);
  try {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({
      claude: { cmd: fakeBin, args: [] },
      opencode: { cmd: "/nope/this/binary/does/not/exist/opencode", args: ["acp"] },
    }));

    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
      const agents = loadAgents();
      assert.ok(agents.claude, "present binary should be kept");
      assert.equal(agents.opencode, undefined, "missing binary should be dropped");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgents keeps only one agent when the others are all missing (no FATAL)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agents-"));
  const fakeBin = path.join(dir, "claude-agent-acp");
  fs.writeFileSync(fakeBin, "");
  fs.chmodSync(fakeBin, 0o755);
  try {
    const file = path.join(dir, "agents.json");
    fs.writeFileSync(file, JSON.stringify({
      claude: { cmd: fakeBin, args: [] },
      codex: { cmd: "/nope/codex-acp", args: [] },
      opencode: { cmd: "/nope/opencode", args: ["acp"] },
    }));

    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: undefined }, () => {
      const agents = loadAgents();
      assert.deepEqual(Object.keys(agents), ["claude"]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing agents file fallback uses a null-prototype registry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agent-fallback-"));
  try {
    withEnv({
      ACPG_AGENTS_FILE: path.join(dir, "missing-agents.json"),
      ACPG_AGENT_CWD: undefined,
      ACPG_AGENT_CMD: undefined,
      ACPG_AGENT_ARGS: undefined,
    }, () => {
      const agents = loadAgents();
      assert.equal(Object.getPrototypeOf(agents), null);
      assert.ok(Object.prototype.hasOwnProperty.call(agents, "claude"));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GATEWAY_VERSION matches package.json, so /healthz reports the real version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
  assert.equal(GATEWAY_VERSION, pkg.version);
});

test("Cursor and Antigravity are recognised from their binary names", () => {
  // Cursor's ACP binary ships with the app as plain `agent` and runs `agent acp`.
  assert.equal(agentKindFor("/Users/me/.local/bin/agent"), "cursor");
  assert.equal(agentKindFor("/usr/local/bin/cursor-agent"), "cursor");
  // The whole-basename match is what keeps `agent` off claude-agent-acp — the
  // substring "agent" is in both, so this must not depend on check order.
  assert.equal(agentKindFor("/opt/acp-gateway/node_modules/.bin/claude-agent-acp"), "claude");
  assert.equal(agentKindFor("/opt/antigravity/agy_acp_server.par"), "antigravity");
  // The npm wrapper's two bins are the cmd its own README configures, so both
  // spellings must be recognised as well as Google's underscored archive.
  assert.equal(agentKindFor("/opt/acp-gateway/node_modules/.bin/antigravity-acp"), "antigravity");
  assert.equal(agentKindFor("/opt/acp-gateway/node_modules/.bin/agy-acp-server"), "antigravity");
});

test("Cursor and Antigravity conversations are browsable and discoverable", () => {
  // Both keep a readable on-disk store, so they advertise history — and both
  // record the conversation's cwd in their own metadata rather than leaving it
  // to be recovered from a transcript, which is what qualifies them for
  // discovery (the cross-folder Recent list) where opencode does not.
  for (const cmd of [
    "/Users/me/.local/bin/agent",
    "/opt/antigravity/agy_acp_server.par",
    "/opt/acp-gateway/node_modules/.bin/antigravity-acp",
  ]) {
    assert.equal(supportsAgentHistory(cmd), true, cmd);
    assert.equal(supportsHistoryDiscovery(cmd), true, cmd);
  }
  // opencode is the counter-example the rule above is drawn against.
  assert.equal(supportsAgentHistory("/usr/local/bin/opencode"), true);
  assert.equal(supportsHistoryDiscovery("/usr/local/bin/opencode"), false);
  // An unknown CLI still gets neither.
  assert.equal(supportsAgentHistory("/opt/bin/some-other-acp"), false);
  assert.equal(supportsHistoryDiscovery("/opt/bin/some-other-acp"), false);
});

test("an explicit agents.json kind overrides the cmd sniff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-agent-kind-"));
  const file = path.join(dir, "agents.json");
  // A wrapper script tells the sniff nothing, so the entry states its kind.
  const wrapper = path.join(dir, "run-cursor.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexec agent acp\n");
  try {
    fs.writeFileSync(file, JSON.stringify({
      wrapped: { cmd: wrapper, args: [], kind: "cursor" },
      sniffed: { cmd: wrapper, args: [] },
    }));
    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: dir }, () => {
      const agents = loadAgents();
      assert.equal(agents.wrapped.kind, "cursor");
      assert.equal(agentKindFor(agents.wrapped), "cursor");
      // Same binary without the field: unidentifiable, and honestly so.
      assert.equal(agents.sniffed.kind, undefined);
      assert.equal(agentKindFor(agents.sniffed), null);
    });

    // A kind outside the known set is a config error, not a silent null.
    fs.writeFileSync(file, JSON.stringify({ bad: { cmd: wrapper, args: [], kind: "gemini" } }));
    withEnv({ ACPG_AGENTS_FILE: file, ACPG_AGENT_CWD: dir }, () => {
      assert.throws(() => loadAgents(), /invalid kind "gemini"/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
