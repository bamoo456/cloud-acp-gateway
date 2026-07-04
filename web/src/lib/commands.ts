import type { SlashCommand } from "../types.ts";

export interface CommandToken { start: number; end: number; query: string; }

// The invocation token for a command, as the user types and sees it. Most
// agents (Claude, opencode) expose plain "/command" entries. Codex also
// surfaces *skills*, which arrive already prefixed with "$" in their name
// (e.g. "$my-skill") and are invoked with that "$", not a "/". So the prefix
// is derived from the name itself rather than always being "/".
export function commandToken(c: SlashCommand): string {
  return c.name.startsWith("$") ? c.name : "/" + c.name;
}

// The "/command" (or Codex "$skill") token being typed, or null. Commands are
// only valid as the very first token of the message, so this triggers only when
// the text begins with "/" (or "$") and the caret sits within that first
// whitespace-free token. `query` is the whole leading token up to the caret —
// including its "/"/"$" prefix, so it can be matched directly against each
// command's invocation token. `start`/`end` bound the entire token (end runs to
// the first whitespace, not the caret) so a pick can replace what's being typed.
// `allowSkill` gates the "$" trigger: only Codex exposes "$" skills, so other
// agents pass false to avoid popping the menu on a message that merely starts
// with "$" (e.g. "$5").
export function activeCommand(value: string, caret: number, allowSkill = true): CommandToken | null {
  const first = value[0];
  if (first !== "/" && !(first === "$" && allowSkill)) return null;
  if (caret < 1 || caret > value.length) return null;
  const sp = value.search(/\s/);
  const end = sp === -1 ? value.length : sp;
  if (caret > end) return null;             // caret past the command token
  return { start: 0, end, query: value.slice(0, caret) };
}

// Case-insensitive filter over the available commands for an autocomplete
// query. The query carries its leading trigger char ("/" or "$"): that char
// selects the command family (slash commands vs Codex "$" skills) and the rest
// is matched against the command name within that family — so a bare "/" lists
// the slash commands and a bare "$" lists the skills. Matching the *rest* (not
// the whole token) keeps the "/" a separator rather than part of the name, so a
// substring like "review" still finds "security-review". An empty query returns
// everything (button-opened menu). Otherwise rank prefix matches before
// substring matches, preserving the original order within each group.
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  const trigger = query[0];
  const rest = query.slice(1).toLowerCase();
  const prefix: SlashCommand[] = [];
  const substring: SlashCommand[] = [];
  for (const c of commands) {
    const isSkill = c.name.startsWith("$");
    if ((isSkill ? "$" : "/") !== trigger) continue;     // wrong family
    const name = (isSkill ? c.name.slice(1) : c.name).toLowerCase();
    if (name.startsWith(rest)) prefix.push(c);
    else if (name.includes(rest)) substring.push(c);
  }
  return [...prefix, ...substring];
}
