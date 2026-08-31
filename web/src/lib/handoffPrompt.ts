import type { PlanEntry, ThreadItem } from "../types.ts";

// One conversation, rendered as the single message a DIFFERENT agent receives.
//
// An ACP session lives inside the process that made it — Claude's in
// claude-agent-acp, Codex's in codex-acp — and no protocol move hands one over
// to another binary. So a cross-agent handoff cannot be a transfer; it is a
// retelling. Everything below follows from that being lossy on purpose.
//
// What survives is what was said. Thoughts, tool calls and permission prompts
// are dropped, and that is the point rather than a shortcut: a tool call's value
// was its effect on the checkout, the receiving agent is standing in that same
// checkout, and it will read the file better than it reads somebody else's
// diff payload. Carrying them would spend the whole budget below on the one part
// of the transcript the new agent can re-derive for free.
//
// Plain text, like reviewPrompt.ts and for the second of its two reasons: file
// references ride on the `embeddedContext` prompt capability, and the target
// agent's capabilities aren't known until after the connection this message is
// built for has been made.

// What one handoff may carry. A large-but-ordinary first prompt: past this the
// receiving agent reads a book before it reaches the ask, and the ask is the
// part that matters.
export const MAX_HANDOFF_BYTES = 32 * 1024;

const SEP = "\n\n";

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Truncate to a BYTE budget on a code-point boundary — the cap is in bytes, but
// a cut through a surrogate pair reaches the agent as a replacement character.
// Only ever hit by a single message that alone exceeds the budget (a pasted
// build log, a whole file quoted back); the ordinary case drops whole messages.
function clip(s: string, max: number): string {
  const cps = [...s];
  let n = cps.length;
  while (n > 0 && bytes(cps.slice(0, n).join("")) > max) n = Math.floor(n * 0.9);
  return cps.slice(0, n).join("") + "\n…[truncated]";
}

function planLine(e: PlanEntry): string {
  const box = e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]";
  return `- ${box} ${e.content}`;
}

// One transcript item as one block, or null for the kinds a handoff drops.
// Images and file chips become named placeholders rather than vanishing: "there
// was a screenshot here" is information, and silently losing it would let the
// new agent read a reply to a picture as a reply to nothing.
function block(item: ThreadItem, fromAgent: string): string | null {
  if (item.kind === "user") {
    const body = [
      item.text.trim(),
      ...(item.images ?? []).map(() => "[image]"),
      ...(item.files ?? []).map((f) => `[file: ${f.name}${f.range ? ":" + f.range : ""}]`),
    ].filter(Boolean).join("\n");
    return body ? `**User:**\n${body}` : null;
  }
  if (item.kind === "assistant") {
    const body = [item.text.trim(), ...(item.images ?? []).map(() => "[image]")]
      .filter(Boolean).join("\n");
    return body ? `**${fromAgent}:**\n${body}` : null;
  }
  // The plan is the one non-message kind worth carrying, and on a "plan it here,
  // build it there" handoff it is usually the whole reason for the handoff.
  if (item.kind === "plan") {
    const lines = item.entries.filter((e) => e.content?.trim()).map(planLine);
    return lines.length ? `**${fromAgent} — plan:**\n${lines.join("\n")}` : null;
  }
  return null;
}

export interface HandoffSource {
  items: ThreadItem[];
  fromAgent: string;
  title: string | null;
  cwd: string;
}

// The whole message: what this is, the conversation, and what to do about it.
//
// `instruction` goes LAST, not in the header. An agent handed several thousand
// words reads the end of them as the ask, and burying the one sentence that says
// what to build above the transcript is how a handoff turns into a summary
// request.
export function buildHandoffMessage(src: HandoffSource, instruction: string): string {
  const all = src.items.map((i) => block(i, src.fromAgent)).filter((b): b is string => b !== null);

  // Newest-first accumulation, so the budget is spent on the end of the
  // conversation — where the plan, the decision and the last failure are.
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const cost = bytes(all[i]) + SEP.length;
    if (kept.length && used + cost > MAX_HANDOFF_BYTES) { dropped = i + 1; break; }
    kept.unshift(cost > MAX_HANDOFF_BYTES ? clip(all[i], MAX_HANDOFF_BYTES) : all[i]);
    used += cost;
  }

  const named = src.title && src.title !== "Untitled" ? ` — “${src.title}”` : "";
  const head = [
    `## Handoff from ${src.fromAgent}${named}`,
    `Folder: ${src.cwd}`,
    // Said out loud, because an agent that doesn't know the beginning is missing
    // will answer as if the conversation started where the text does.
    dropped > 0
      ? `The first ${dropped} ${dropped === 1 ? "message" : "messages"} are not included; the rest of the conversation follows.`
      : "The conversation follows in full.",
  ].join("\n");

  const foot = "That transcript is from another agent's session. You have the folder it ran in, "
    + "but none of its tool state — re-read anything you need to be sure of.";

  return [head, "---", ...kept, "---", foot, instruction.trim()].join(SEP);
}
