import type { RunningTask } from "./api.ts";
import type { RecentSession } from "./recentSessions.ts";
import type { Session } from "../types.ts";

// Where a running task should open and what to call it. The gateway-reported cwd
// is authoritative — it works even for a task this device never opened. Recents
// and the live session only supply the title and a cwd fallback for older
// gateways that don't report one. Shared by the TopBar popup (RunningTasks) and
// the store's jumpToTask so the label shown and the folder jumped to never drift.
export interface ResolvedTask {
  title: string | null;
  cwd: string | undefined;
}

export interface RunningTaskContext {
  recentSessions: RecentSession[];
  agentName: string;
  sessions: Record<string, Session>;
  cwd: string;
}

export function resolveRunningTask(task: RunningTask, ctx: RunningTaskContext): ResolvedTask {
  const rec = ctx.recentSessions.find((r) => r.agentName === task.agentName && r.sessionId === task.sessionId);
  const sameAgent = task.agentName === ctx.agentName;
  const local = sameAgent ? ctx.sessions[task.sessionId] : undefined;
  return {
    // Recents/live title win (they reflect any rename); the gateway-reported first
    // prompt is the fallback for tasks this device never opened (e.g. cross-device).
    title: rec?.title ?? local?.title ?? task.title ?? null,
    cwd: task.cwd ?? rec?.cwd ?? (sameAgent ? ctx.cwd : undefined),
  };
}
