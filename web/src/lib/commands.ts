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
// Leading whitespace is skipped rather than disqualifying: a stray space from a
// phone keyboard or a blank first line is invisible, and anchoring hard at index
// 0 made the menu silently refuse to open with no way to see why. A pick rebuilds
// the text from the token onwards, so what gets sent still starts with the command.
export function activeCommand(value: string, caret: number, allowSkill = true): CommandToken | null {
  const head = value.search(/\S/);
  if (head < 0) return null;                // blank (or all-whitespace) input
  const first = value[head];
  if (first !== "/" && !(first === "$" && allowSkill)) return null;
  if (caret <= head || caret > value.length) return null;
  const sp = value.slice(head).search(/\s/);
  const end = sp === -1 ? value.length : head + sp;
  if (caret > end) return null;             // caret past the command token
  return { start: head, end, query: value.slice(head, caret) };
}

// Greedy leftmost subsequence of `needle` in `hay`, scored fzy-style: bonuses for
// consecutive runs and word starts, penalties for stretch and a late first hit.
// Null when `needle` is not a subsequence. Both must already be lowercase. Same
// scoring as the file finder's (src/fuzzy.ts) — duplicated rather than imported
// because web/ is a separate build that does not reach outside web/src.
function subsequenceScore(hay: string, needle: string): number | null {
  let score = 0, prev = -2, first = -1, j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] !== needle[j]) continue;
    if (first < 0) first = i;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || "-_.: ".includes(hay[i - 1])) score += 2;
    prev = i; j++;
  }
  if (j < needle.length) return null;
  return score * 4 - (prev - first + 1 - needle.length) - first;
}

// Case-insensitive filter over the available commands for an autocomplete
// query. The query carries its leading trigger char ("/" or "$"): that char
// selects the command family (slash commands vs Codex "$" skills) and the rest
// is matched against the command name within that family — so a bare "/" lists
// the slash commands and a bare "$" lists the skills. Matching the *rest* (not
// the whole token) keeps the "/" a separator rather than part of the name, so a
// substring like "review" still finds "security-review". An empty query returns
// everything (button-opened menu). Otherwise rank prefix matches before
// substring matches, preserving the original order within each group, then fuzzy
// (subsequence) matches by score last. The fuzzy tier is what makes a long list
// typeable — "prpr" finds "pr-review-toolkit:review-pr", "cdrv" finds
// "code-review" — while staying behind the exact tiers so a literal match is
// never demoted by a lucky-scoring subsequence. It needs 3 characters to engage:
// a 1-2 char subsequence hits most of a hundred-plus command list, which is not
// filtering but noise (the same reason src/fuzzy.ts scopes its fuzzy tier).
const FUZZY_MIN = 3;
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  const trigger = query[0];
  const rest = query.slice(1).toLowerCase();
  const prefix: SlashCommand[] = [];
  const substring: SlashCommand[] = [];
  const fuzzy: { c: SlashCommand; score: number }[] = [];
  for (const c of commands) {
    const isSkill = c.name.startsWith("$");
    if ((isSkill ? "$" : "/") !== trigger) continue;     // wrong family
    const name = (isSkill ? c.name.slice(1) : c.name).toLowerCase();
    if (name.startsWith(rest)) prefix.push(c);
    else if (name.includes(rest)) substring.push(c);
    else if (rest.length >= FUZZY_MIN) {
      const s = subsequenceScore(name, rest);
      if (s !== null) fuzzy.push({ c, score: s });
    }
  }
  fuzzy.sort((a, b) => b.score - a.score || a.c.name.length - b.c.name.length);
  return [...prefix, ...substring, ...fuzzy.map((f) => f.c)];
}
