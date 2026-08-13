import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_CONFIG_SCHEMA_VERSION, buildClientConfig } from "./client-config.ts";

test("native client config exposes capabilities without credentials or commands", () => {
  const config = buildClientConfig({
    gatewayVersion: "test",
    ssePath: "/stream",
    rpcPath: "/send",
    defaultAgent: "codex",
    fsRoot: "/workspace",
    terminalEnabled: true,
    agents: [{
      name: "codex",
      cwd: "/workspace/app",
      kind: "codex",
      history: true,
      discover: true,
      sessionLoad: true,
      skin: "codex",
      cmd: "/secret/codex-acp",
    }],
  });

  assert.equal(config.schemaVersion, CLIENT_CONFIG_SCHEMA_VERSION);
  assert.deepEqual(config.transport, { ssePath: "/stream", rpcPath: "/send" });
  assert.deepEqual(config.features, { nativeConsole: true, terminal: true });
  assert.deepEqual(config.agents, [{
    name: "codex",
    cwd: "/workspace/app",
    kind: "codex",
    history: true,
    discover: true,
    sessionLoad: true,
    skin: "codex",
  }]);
  assert.equal(JSON.stringify(config).includes("/secret"), false);
  assert.equal(JSON.stringify(config).includes("token"), false);
});
