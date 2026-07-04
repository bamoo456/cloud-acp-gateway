import { describe, test, expect } from "vitest";
import { activeCommand, filterCommands, commandToken } from "./commands.ts";
import type { SlashCommand } from "../types.ts";

describe("commandToken", () => {
  test("slash-prefixes a plain command, leaves a $skill as-is", () => {
    expect(commandToken({ name: "review" })).toBe("/review");
    expect(commandToken({ name: "$my-skill" })).toBe("$my-skill");
  });
});

describe("activeCommand", () => {
  test("detects a /command token at the start of the input (query keeps the prefix)", () => {
    expect(activeCommand("/", 1)).toEqual({ start: 0, end: 1, query: "/" });
    expect(activeCommand("/co", 3)).toEqual({ start: 0, end: 3, query: "/co" });
  });

  test("detects a Codex $skill token when skills are allowed", () => {
    expect(activeCommand("$", 1)).toEqual({ start: 0, end: 1, query: "$" });
    expect(activeCommand("$my", 3)).toEqual({ start: 0, end: 3, query: "$my" });
  });

  test("ignores a leading $ when skills aren't allowed", () => {
    expect(activeCommand("$my", 3, false)).toBeNull();
    // "/command" still triggers regardless of the skill flag
    expect(activeCommand("/co", 3, false)).toEqual({ start: 0, end: 3, query: "/co" });
  });

  test("query is bounded by the caret, token end by the first whitespace", () => {
    // caret after "/co" but the token "/commit" runs to the space
    expect(activeCommand("/commit msg", 3)).toEqual({ start: 0, end: 7, query: "/co" });
  });

  test("only triggers as the first token", () => {
    expect(activeCommand("hi /co", 6)).toBeNull();   // not at the start
    expect(activeCommand("/co arg", 5)).toBeNull();  // caret past the command token
    expect(activeCommand("hello", 5)).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds: SlashCommand[] = [
    { name: "init" },
    { name: "review" },
    { name: "commit" },
    { name: "security-review" },
  ];

  test("empty query returns everything unchanged", () => {
    expect(filterCommands(cmds, "")).toEqual(cmds);
  });

  test("a bare slash lists every slash command, but no $skills", () => {
    const mixed: SlashCommand[] = [{ name: "mcp" }, { name: "$skill-a" }, { name: "status" }];
    expect(filterCommands(mixed, "/").map((c) => c.name)).toEqual(["mcp", "status"]);
  });

  test("a bare $ lists only the skills", () => {
    const mixed: SlashCommand[] = [{ name: "mcp" }, { name: "$skill-a" }, { name: "$skill-b" }];
    expect(filterCommands(mixed, "$").map((c) => c.name)).toEqual(["$skill-a", "$skill-b"]);
  });

  test("matches case-insensitively, prefix matches ranked first", () => {
    // "/review" is a prefix match; "/security-review" is a substring match
    expect(filterCommands(cmds, "/review").map((c) => c.name)).toEqual([
      "review",
      "security-review",
    ]);
  });

  test("matches a skill by its $-prefixed token", () => {
    const mixed: SlashCommand[] = [{ name: "$deep-research" }, { name: "$review" }];
    expect(filterCommands(mixed, "$rev").map((c) => c.name)).toEqual(["$review"]);
  });

  test("filters out non-matches", () => {
    expect(filterCommands(cmds, "/com").map((c) => c.name)).toEqual(["commit"]);
    expect(filterCommands(cmds, "/zzz")).toEqual([]);
  });
});
