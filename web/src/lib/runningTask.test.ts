import { describe, test, expect } from "vitest";
import { resolveRunningTask, type RunningTaskContext } from "./runningTask.ts";
import type { RunningTask } from "./api.ts";
import type { Session } from "../types.ts";

function ctx(over: Partial<RunningTaskContext> = {}): RunningTaskContext {
  return { recentSessions: [], agentName: "claude", sessions: {}, cwd: "/here", ...over };
}
const session = (title: string): Session => ({ title } as Session);
const rec = (over: Partial<RunningTaskContext["recentSessions"][number]>) => ({
  agentName: "claude", cwd: "/recalled", sessionId: "s", title: "Recalled", lastActiveAt: "2026-06-10T00:00:00.000Z", ...over,
});

describe("resolveRunningTask", () => {
  const task: RunningTask = { agentName: "claude", sessionId: "s", state: "active" };

  test("gateway cwd is authoritative — wins over recents and the current folder", () => {
    const r = resolveRunningTask({ ...task, cwd: "/gateway" }, ctx({ recentSessions: [rec({})], cwd: "/here" }));
    expect(r.cwd).toBe("/gateway");
  });

  test("falls back to recents cwd when the gateway omits it (older gateway)", () => {
    const r = resolveRunningTask(task, ctx({ recentSessions: [rec({})] }));
    expect(r.cwd).toBe("/recalled");
  });

  test("falls back to the current folder for a same-agent task with no other source", () => {
    expect(resolveRunningTask(task, ctx({ cwd: "/here" })).cwd).toBe("/here");
  });

  test("a cross-agent task with no recents has an unknown folder", () => {
    const r = resolveRunningTask({ agentName: "codex", sessionId: "s", state: "active" }, ctx({ agentName: "claude" }));
    expect(r.cwd).toBeUndefined();
  });

  test("title comes from recents, then the live local session, else null", () => {
    expect(resolveRunningTask(task, ctx({ recentSessions: [rec({ title: "From recents" })] })).title).toBe("From recents");
    expect(resolveRunningTask(task, ctx({ sessions: { s: session("From live") } })).title).toBe("From live");
    // The gateway-reported first-prompt label is the fallback for tasks this device
    // never opened (e.g. one running on another device) — so they don't collapse
    // to a bare session id and read as duplicates.
    expect(resolveRunningTask({ ...task, title: "First prompt text" }, ctx()).title).toBe("First prompt text");
    expect(resolveRunningTask(task, ctx()).title).toBeNull();
  });

  test("does not read a same-id local session belonging to another agent", () => {
    // The live session map is keyed by id within the current agent; a cross-agent
    // task must not borrow a title from a collision in this agent's sessions.
    const r = resolveRunningTask({ agentName: "codex", sessionId: "s", state: "active" }, ctx({ agentName: "claude", sessions: { s: session("Claude's") } }));
    expect(r.title).toBeNull();
  });
});
