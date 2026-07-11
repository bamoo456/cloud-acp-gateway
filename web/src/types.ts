// ---- config (injected by the gateway as #acpg-cfg) ----
// `kind` is the CLI backing the agent (drives the terminal resume-command syntax).
// `history` is false for agents whose past conversations the gateway can't read.
// `sessionLoad` is false for agents that cannot resume a session id over ACP.
export type AgentSkin = "codex" | "opencode";
export type AgentKind = "claude" | "codex" | "opencode";
export interface AgentRef { name: string; cwd: string; kind?: AgentKind; history?: boolean; sessionLoad?: boolean; skin?: AgentSkin; }
export interface AppConfig {
  // The gateway serves a single transport: SSE downstream (ssePath) + POST upstream
  // (rpcPath). Both are injected by the gateway; the defaults match its defaults.
  ssePath?: string;
  rpcPath?: string;
  token: string;
  defaultAgent: string;
  agents: AgentRef[];
  fsRoot: string;
}

// ---- ACP wire types (only what the client interprets) ----
export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  uri?: string;
  // image content block: `data` is raw base64 (no data: URL prefix), `mimeType`
  // the media type (e.g. "image/png"). `uri` may carry a link instead of bytes.
  mimeType?: string;
  data?: string;
  resource?: { text?: string; uri?: string };
}

// An image attached to a rendered message. `data` is raw base64 (no data: URL
// prefix); `uri` is an alternative for link-only images. Used both for images
// the user sends and images the agent returns.
export interface MessageImage { mimeType: string; data?: string; uri?: string; }

// A file referenced via the composer's "@ file" picker. `name` is the cwd-relative
// path shown on the chip; `uri` is the file:// URI sent to the agent as an ACP
// `resource_link` so the agent can read the file itself.
export interface MessageFile { name: string; uri?: string; }

// What an agent reports it can accept in a prompt (from `initialize`'s
// agentCapabilities.promptCapabilities). We only gate on `image` today.
export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}
export interface Model { modelId: string; name: string; description?: string; }
export interface Mode { id: string; name: string; description?: string; }
export interface ConfigOptionChoice { value: string; name: string; description?: string; }
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ConfigOptionChoice[];
}
export interface PermissionOption { optionId: string; name?: string; kind?: string; }

// ---- form elicitation (agent questions) ----
// A renderable field parsed from an `elicitation/create` requestedSchema (see
// lib/elicitation.ts). claude-agent-acp surfaces the AskUserQuestion tool this
// way: one select field per question (plus a free-text "Other" companion).
// `options` empty means a free-text input.
export interface ElicitationOption { value: string; label: string; description?: string }
export interface ElicitationField {
  key: string;
  title?: string;        // short label (e.g. AskUserQuestion's header chip)
  description?: string;  // the question / helper text
  multi: boolean;        // multi-select (array of choices) vs single choice
  valueType: "string" | "number" | "integer" | "boolean";
  options: ElicitationOption[];
}
// The JSON-RPC reply an elicitation expects. "decline" tells the agent the user
// skipped the question(s); it does NOT abort the turn (that would be "cancel").
export type ElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" };
export interface PlanEntry { content?: string; status?: string; }
export interface SlashCommand { name: string; description?: string; }

export interface NewSessionResult {
  sessionId: string;
  models?: { availableModels?: Model[]; currentModelId?: string };
  modes?: { availableModes?: Mode[]; currentModeId?: string };
  configOptions?: ConfigOption[];
}

// tool_call content items (diff / terminal / generic)
export interface ToolContentItem {
  type?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
  content?: ContentBlock;
}

export interface SessionUpdate {
  sessionUpdate: string;
  content?: ContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Array<{ path?: string; uri?: string }>;
  toolContent?: ToolContentItem[]; // see note: ACP field is `content`; reducer reads up.content
  entries?: PlanEntry[];
  availableCommands?: SlashCommand[];
  currentModeId?: string;
  configOptions?: ConfigOption[];
}

// ---- view model (what components render) ----
export type ThreadItem =
  | { id: string; kind: "user"; text: string; images?: MessageImage[]; files?: MessageFile[] }
  | { id: string; kind: "assistant"; text: string; images?: MessageImage[] }
  | { id: string; kind: "thought"; text: string }
  | {
      id: string; kind: "tool"; toolCallId: string; title: string;
      toolKind: string; status: string; locations: string[]; content: ToolContentItem[];
    }
  | { id: string; kind: "plan"; entries: PlanEntry[] }
  | {
      id: string; kind: "permission"; reqId: number | string; title: string;
      options: PermissionOption[]; resolved: boolean; chosen?: string;
    }
  | {
      id: string; kind: "elicitation"; reqId: number | string; message: string;
      fields: ElicitationField[]; resolved: boolean; chosen?: string;
    }
  | { id: string; kind: "note"; text: string; variant?: "error" };

export interface PendingPermission {
  reqId: number | string;
  sessionId: string;
  agentName: string; // which agent's connection owns reqId — a prompt is only answerable on its own agent
  title: string;
  options: PermissionOption[];
  createdAt: number;
  // Present when the prompt is a form elicitation (agent question) rather than
  // a permission: `options` is empty and re-attachment rebuilds the form from
  // these fields instead of option buttons.
  elicitation?: { message: string; fields: ElicitationField[] };
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  agentName: string;    // which agent owns this conversation (claude / codex)
  cwd: string;          // working directory the session was created in
  lastActiveAt: number; // recency for LRU eviction
  items: ThreadItem[];
  hasContent: boolean;
  working: boolean;
  modelId?: string | null;
  mode?: string | null;
  viewOnly?: boolean;
  suppressReplay?: boolean;
  // streaming cursors (item ids of the currently-open assistant / thought bubble)
  curAssistantId: string | null;
  curThoughtId: string | null;
  toolItemId: Record<string, string>; // toolCallId -> ThreadItem.id
  planItemId: string | null;
  seq: number; // monotonic id source for this session's items
}
