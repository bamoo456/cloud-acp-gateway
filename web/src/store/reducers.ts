import type {
  Session, ThreadItem, ContentBlock, SessionUpdate, NewSessionResult,
  Model, Mode, ConfigOption, ToolContentItem, MessageImage, MessageFile,
} from "../types.ts";
import type { ViewMessage } from "../lib/api.ts";

// Updates that are part of a session/load replay; dropped during a lazy resume
// because /history/messages already rendered the history.
const REPLAY_KINDS = new Set([
  "agent_message_chunk", "agent_thought_chunk", "user_message_chunk",
  "tool_call", "tool_call_update", "plan",
]);

export function makeSession(
  id: string,
  createdAt = 0,
  opts: { agentName?: string; cwd?: string } = {},
): Session {
  return {
    id, title: "Untitled", createdAt,
    agentName: opts.agentName ?? "",
    cwd: opts.cwd ?? "",
    lastActiveAt: createdAt,
    items: [], hasContent: false, working: false,
    modelId: null, mode: null,
    curAssistantId: null, curThoughtId: null,
    toolItemId: {}, planItemId: null, seq: 0,
  };
}

// Ports console.html contentText (public/console.html:734-740).
export function contentText(c: ContentBlock | undefined): string {
  if (!c) return "";
  if (c.type === "text") return c.text || "";
  if (c.type === "resource_link") return c.name || c.uri || "";
  if (c.type === "resource" && c.resource) return c.resource.text || c.resource.uri || "";
  return "[" + (c.type || "content") + "]";
}

// An image content block -> MessageImage, or null for anything else. An image
// block carries either inline base64 (`data` + `mimeType`) or a `uri`.
export function contentImage(c: ContentBlock | undefined): MessageImage | null {
  if (!c || c.type !== "image") return null;
  if (c.data) return { mimeType: c.mimeType || "image/png", data: c.data };
  if (c.uri) return { mimeType: c.mimeType || "image/png", uri: c.uri };
  return null;
}

// A resource_link / embedded resource content block -> MessageFile (a referenced
// file), or null for anything else. Used to render an "@ file" reference as a chip
// instead of a bare path string.
export function contentFile(c: ContentBlock | undefined): MessageFile | null {
  if (!c) return null;
  if (c.type === "resource_link") return { name: c.name || c.uri || "file", uri: c.uri };
  if (c.type === "resource" && c.resource?.uri) return { name: c.resource.uri, uri: c.resource.uri };
  return null;
}

function nextId(s: Session): [string, number] {
  const seq = s.seq + 1;
  return [s.id + ":" + seq, seq];
}

function markContent(s: Session): Session {
  return s.hasContent && !s.working ? s : { ...s, hasContent: true, working: false };
}
function breakFlow(s: Session): Session {
  return { ...s, curAssistantId: null, curThoughtId: null };
}

function appendStream(s0: Session, kind: "assistant" | "thought", text: string): Session {
  if (!text) return s0;
  let s = markContent(s0);
  const curId = kind === "assistant" ? s.curAssistantId : s.curThoughtId;
  // streaming an assistant chunk ends any open thought, and vice-versa
  s = kind === "assistant" ? { ...s, curThoughtId: null } : { ...s, curAssistantId: null };
  if (curId) {
    const items = s.items.map((it) =>
      it.id === curId && (it.kind === "assistant" || it.kind === "thought")
        ? { ...it, text: it.text + text } : it);
    return { ...s, items };
  }
  const [id, seq] = nextId(s);
  const item: ThreadItem = { id, kind, text };
  return {
    ...s, seq, items: [...s.items, item],
    curAssistantId: kind === "assistant" ? id : null,
    curThoughtId: kind === "thought" ? id : null,
  };
}

export function addUserBubble(s0: Session, text: string, images?: MessageImage[], files?: MessageFile[]): Session {
  let s = breakFlow(markContent(s0));
  const [id, seq] = nextId(s);
  const item: ThreadItem = { id, kind: "user", text };
  if (images && images.length) item.images = images;
  if (files && files.length) item.files = files;
  s = { ...s, seq, items: [...s.items, item] };
  if (s.title === "Untitled" && text.trim()) s = setTitle(s, text.trim());
  return s;
}

// Attach an image the agent returned to the open assistant bubble (creating one
// if a turn hasn't streamed text yet), mirroring how appendStream coalesces text.
function appendImage(s0: Session, img: MessageImage): Session {
  let s = markContent(s0);
  s = { ...s, curThoughtId: null };
  if (s.curAssistantId) {
    const items = s.items.map((it) =>
      it.id === s.curAssistantId && it.kind === "assistant"
        ? { ...it, images: [...(it.images || []), img] } : it);
    return { ...s, items };
  }
  const [id, seq] = nextId(s);
  const item: ThreadItem = { id, kind: "assistant", text: "", images: [img] };
  return { ...s, seq, items: [...s.items, item], curAssistantId: id };
}

function isDuplicateLocalPromptReplay(s: Session, text: string): boolean {
  const last = s.items[s.items.length - 1];
  return !!s.working
    && !!text
    && last?.kind === "user"
    && last.text === text
    && !last.images?.length
    && !last.files?.length;
}

export function setTitle(s: Session, text: string): Session {
  return { ...s, title: text.length > 40 ? text.slice(0, 40) + "…" : text };
}

function upsertTool(s0: Session, up: SessionUpdate, isUpdate: boolean): Session {
  let s = breakFlow(markContent(s0));
  const tcId = up.toolCallId!;
  const existingId = s.toolItemId[tcId];
  // ACP carries tool content under `up.content` (array); see types.ts note.
  const upContent = (up as { content?: ToolContentItem[] }).content;
  if (!existingId) {
    const [id, seq] = nextId(s);
    const item: ThreadItem = {
      id, kind: "tool", toolCallId: tcId,
      title: up.title || up.kind || "Tool",
      toolKind: up.kind || "other",
      status: up.status || (isUpdate ? "pending" : "pending"),
      locations: (up.locations || []).map((l) => l.path || l.uri || ""),
      content: Array.isArray(upContent) ? upContent : [],
    };
    return { ...s, seq, items: [...s.items, item], toolItemId: { ...s.toolItemId, [tcId]: id } };
  }
  const items = s.items.map((it) => {
    if (it.id !== existingId || it.kind !== "tool") return it;
    return {
      ...it,
      title: up.title || it.title,
      toolKind: up.kind || it.toolKind,
      status: up.status || it.status,
      locations: up.locations ? up.locations.map((l) => l.path || l.uri || "") : it.locations,
      content: Array.isArray(upContent) ? upContent : it.content,
    };
  });
  return { ...s, items };
}

function upsertPlan(s0: Session, entries: SessionUpdate["entries"]): Session {
  let s = breakFlow(markContent(s0));
  const list = entries || [];
  if (s.planItemId) {
    const items = s.items.map((it) =>
      it.id === s.planItemId && it.kind === "plan" ? { ...it, entries: list } : it);
    return { ...s, items };
  }
  const [id, seq] = nextId(s);
  return { ...s, seq, items: [...s.items, { id, kind: "plan", entries: list }], planItemId: id };
}

// Ports console.html applyUpdate (public/console.html:747-775). `available_commands_update`
// is NOT handled here — it updates the app-global slash command list (Task 4 store).
export function applyUpdate(s: Session, up: SessionUpdate): Session {
  const t = up.sessionUpdate;
  if (s.suppressReplay && REPLAY_KINDS.has(t)) return s;
  switch (t) {
    case "agent_message_chunk": {
      const img = contentImage(up.content);
      return img ? appendImage(s, img) : appendStream(s, "assistant", contentText(up.content));
    }
    case "agent_thought_chunk": return appendStream(s, "thought", contentText(up.content));
    case "user_message_chunk": {
      const img = contentImage(up.content);
      if (img) return addUserBubble(s, "", [img]);
      const file = contentFile(up.content);
      if (file) return addUserBubble(s, "", undefined, [file]);
      const text = contentText(up.content);
      return isDuplicateLocalPromptReplay(s, text) ? s : addUserBubble(s, text);
    }
    case "tool_call": return upsertTool(s, up, false);
    case "tool_call_update": return upsertTool(s, up, true);
    case "plan": return upsertPlan(s, up.entries);
    case "current_mode_update": return { ...s, mode: up.currentModeId ?? s.mode };
    default: return s;
  }
}

export function applyModelsModes(
  s: Session, res: NewSessionResult,
): { session: Session; models: Model[] | null; modes: Mode[] | null; configOptions: ConfigOption[] | null } {
  let session = s;
  let models: Model[] | null = null, modes: Mode[] | null = null;
  if (res.models) {
    models = res.models.availableModels ?? null;
    session = { ...session, modelId: res.models.currentModelId ?? session.modelId ?? null };
  }
  if (res.modes) {
    modes = res.modes.availableModes ?? null;
    session = { ...session, mode: res.modes.currentModeId ?? session.mode ?? null };
  }
  const configOptions = res.configOptions ?? null;
  return { session, models, modes, configOptions };
}

// Render a session's persisted history (from /history/messages) into thread
// items. Shared by opening a session from the history panel and joining one via
// a deep-link.
export function applyHistoryMessages(s0: Session, messages: ViewMessage[]): Session {
  let cur = s0;
  for (const m of messages) {
    if (m.role === "user") {
      const txt = m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const images = m.blocks
        .filter((b) => b.type === "image" && (b.data || b.uri))
        .map((b) => ({ mimeType: b.mimeType || "image/png", data: b.data, uri: b.uri }));
      if (txt || images.length) cur = addUserBubble(cur, txt, images.length ? images : undefined);
    } else {
      for (const b of m.blocks) {
        const seq = cur.seq + 1; const iid = cur.id + ":" + seq;
        if (b.type === "text") cur = { ...cur, seq, hasContent: true, items: [...cur.items, { id: iid, kind: "assistant", text: b.text || "" }] };
        else if (b.type === "image" && (b.data || b.uri)) cur = { ...cur, seq, hasContent: true, items: [...cur.items, { id: iid, kind: "assistant", text: "", images: [{ mimeType: b.mimeType || "image/png", data: b.data, uri: b.uri }] }] };
        else if (b.type === "thought") cur = { ...cur, seq, items: [...cur.items, { id: iid, kind: "thought", text: b.text || "" }] };
        else if (b.type === "tool") cur = { ...cur, seq, hasContent: true, items: [...cur.items, {
          id: iid, kind: "tool", toolCallId: b.toolCallId || iid, title: b.name || "Tool",
          toolKind: b.name || "other", status: b.status || "completed", locations: [],
          content: b.output ? [{ type: "content", content: { type: "text", text: b.output } }] : [],
        }] };
      }
    }
  }
  return cur;
}

// Move a session to a new id (provisional "pending-*" -> real sessionId), keeping items.
export function remapSession(s: Session, newId: string): Session {
  return { ...s, id: newId };
}

// Cap the live-session map: keep at most `max`, never evicting the active session,
// dropping the least-recently-active first. Evicted conversations are cold — the
// store rebuilds them from history on next select.
export function evictExcess(
  sessions: Record<string, Session>,
  activeId: string | null,
  max: number,
): Record<string, Session> {
  const ids = Object.keys(sessions);
  if (ids.length <= max) return sessions;
  const evictable = ids
    .filter((id) => id !== activeId)
    .sort((a, b) => sessions[a].lastActiveAt - sessions[b].lastActiveAt);
  const toRemove = ids.length - max;
  const next = { ...sessions };
  for (let i = 0; i < toRemove && i < evictable.length; i++) delete next[evictable[i]];
  return next;
}
