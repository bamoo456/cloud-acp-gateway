export const CLIENT_CONFIG_SCHEMA_VERSION = 1;

export type NativeAgentConfig = {
  name: string;
  cwd: string;
  kind: "claude" | "codex" | "opencode" | null;
  history: boolean;
  sessionLoad: boolean;
  skin?: "codex" | "opencode";
};

export type NativeClientConfig = {
  schemaVersion: number;
  gatewayVersion: string;
  transport: {
    ssePath: string;
    rpcPath: string;
  };
  defaultAgent: string;
  fsRoot: string;
  agents: NativeAgentConfig[];
  features: {
    nativeConsole: true;
  };
};

export function buildClientConfig(input: {
  gatewayVersion: string;
  ssePath: string;
  rpcPath: string;
  defaultAgent: string;
  fsRoot: string;
  agents: Array<NativeAgentConfig & { cmd?: string }>;
}): NativeClientConfig {
  return {
    schemaVersion: CLIENT_CONFIG_SCHEMA_VERSION,
    gatewayVersion: input.gatewayVersion,
    transport: {
      ssePath: input.ssePath,
      rpcPath: input.rpcPath,
    },
    defaultAgent: input.defaultAgent,
    fsRoot: input.fsRoot,
    agents: input.agents.map(({ cmd: _cmd, ...agent }) => agent),
    features: { nativeConsole: true },
  };
}
