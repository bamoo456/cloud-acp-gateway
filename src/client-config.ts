export const CLIENT_CONFIG_SCHEMA_VERSION = 1;

export type NativeAgentConfig = {
  name: string;
  cwd: string;
  kind: "claude" | "codex" | "opencode" | null;
  history: boolean;
  // Whether /history/discovered can list this agent's sessions from folders the
  // console isn't currently in. Server-owned so clients don't re-derive it from
  // `kind` — the web sidebar and the iOS console each hardcoded "claude", and
  // both silently dropped codex conversations outside the selected folder.
  discover: boolean;
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
    // Whether the general-shell terminal (ACPG_TERMINAL) is reachable on this
    // gateway — see terminal.ts. On unless the deployment withheld it.
    terminal: boolean;
  };
};

export function buildClientConfig(input: {
  gatewayVersion: string;
  ssePath: string;
  rpcPath: string;
  defaultAgent: string;
  fsRoot: string;
  agents: Array<NativeAgentConfig & { cmd?: string }>;
  terminalEnabled: boolean;
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
    features: { nativeConsole: true, terminal: input.terminalEnabled },
  };
}
