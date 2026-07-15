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

// How long a conversation lingers in the Recent "Running" section after its turn
// ends. The gateway clears a task the instant its prompt response returns, so
// without this a session would pop out of Running (and back into the recency
// list) the moment it finishes — flip-flopping between turns. We keep it visible
// for a short cooldown that resets on any new activity, so it only leaves once
// it's genuinely idle. Frontend-only: the TopBar bolt badge still counts just the
// live /running tasks.
export const RUNNING_GRACE_MS = 2 * 60_000;

// A task remembered from a /running snapshot, stamped with when it was last seen
// running. `at` is refreshed on every poll the task is still live, so the grace
// window measures inactivity, not total lifetime.
export interface RunningSeen { task: RunningTask; at: number; }

export function taskKey(t: Pick<RunningTask, "agentName" | "sessionId">): string {
  return t.agentName + "\n" + t.sessionId;
}

// Fold a fresh /running snapshot into the seen-map: refresh each live task's
// timestamp and drop anything past the grace window. Pure — returns a new map.
export function ingestSeen(
  prev: Record<string, RunningSeen>,
  tasks: RunningTask[],
  now: number,
): Record<string, RunningSeen> {
  const next: Record<string, RunningSeen> = {};
  for (const [k, v] of Object.entries(prev)) if (now - v.at <= RUNNING_GRACE_MS) next[k] = v;
  for (const t of tasks) next[taskKey(t)] = { task: t, at: now };
  return next;
}

// Rows for the Running section: live tasks in gateway start order (stable, never
// re-sorted on activity), then recently-finished ones still inside the grace
// window, newest-active first.
export function runningView(
  runningTasks: RunningTask[],
  seen: Record<string, RunningSeen>,
  now: number,
): { active: RunningTask[]; cooling: RunningSeen[] } {
  const activeKeys = new Set(runningTasks.map(taskKey));
  const cooling = Object.values(seen)
    .filter((v) => !activeKeys.has(taskKey(v.task)) && now - v.at <= RUNNING_GRACE_MS)
    .sort((a, b) => b.at - a.at);
  return { active: runningTasks, cooling };
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
