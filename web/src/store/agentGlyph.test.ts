import { describe, test, expect } from "vitest";
import { agentGlyphKind } from "./store.ts";
import type { AgentRef } from "../types.ts";

const agent = (a: Partial<AgentRef>): AgentRef => ({ name: "x", cwd: "/", ...a });

describe("agentGlyphKind", () => {
  test("the skin outranks the kind", () => {
    expect(agentGlyphKind(agent({ name: "gpt", kind: "cursor", skin: "codex" }))).toBe("codex");
  });

  test("each branded kind wears its own mark", () => {
    for (const kind of ["opencode", "cursor", "antigravity"] as const) {
      expect(agentGlyphKind(agent({ name: kind, kind }))).toBe(kind);
    }
  });

  test("claude is recognised by name, for configs older than `kind`", () => {
    expect(agentGlyphKind(agent({ name: "claude" }))).toBe("claude");
  });

  test("an agent with no brand of its own is mono, not the Claude robot", () => {
    expect(agentGlyphKind(agent({ name: "my-agent" }))).toBe("mono");
    expect(agentGlyphKind(undefined)).toBe("mono");
  });
});
