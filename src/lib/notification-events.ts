import type { AutopilotOverview, Integration, Run, Task } from './types';

export type NotificationCategory = 'questions' | 'failures' | 'merges' | 'autopilot' | 'completed';
export interface BrigdNotification {
  event: string;
  taskId: string | null;
  title: string;
  worker: string | null;
  status: string;
  at: number;
}
export interface NotificationEvent { key: string; category: NotificationCategory; payload: BrigdNotification; }

function taskEvent(task: Pick<Task, 'id' | 'title'>, run: Run, category: NotificationCategory, event: string, status: string, key: string, at: number): NotificationEvent {
  return { key, category, payload: { event, taskId: task.id, title: task.title, worker: run.worker?.name ?? run.provider, status, at } };
}

export function runNotification(task: Pick<Task, 'id' | 'title'>, run: Run): NotificationEvent | null {
  const category = run.status === 'waiting_input' ? 'questions' : ['failed', 'blocked', 'interrupted'].includes(run.status) ? 'failures' : null;
  return category ? taskEvent(task, run, category, `run.${run.status}`, run.status, `run:${run.id}:${run.turn}:${run.status}`, run.updatedAt) : null;
}

export function integrationNotification(task: Pick<Task, 'id' | 'title'>, run: Run, job: Integration): NotificationEvent | null {
  const status = job.status === 'merged' ? 'completed' : `merge_${job.status}`;
  const category = job.status === 'merged' ? 'completed' : ['conflict', 'failed', 'blocked', 'interrupted'].includes(job.status) ? 'merges' : null;
  return category ? taskEvent(task, run, category, job.status === 'merged' ? 'task.merged' : status, status,
    `merge:${job.id}:${job.attempt}:${job.status}`, job.updatedAt) : null;
}

export function taskNotifications(previous: Task[], current: Task[]): NotificationEvent[] {
  const before = new Map(previous.map(task => [task.id, task]));
  return current.flatMap(task => {
    const old = before.get(task.id);
    const run = task.latestRun;
    if (!old || task.archivedAt || !run) return [];
    const events: NotificationEvent[] = [];
    if (run.id !== old.latestRun?.id || run.turn !== old.latestRun?.turn || run.status !== old.latestRun?.status) {
      const event = runNotification(task, run);
      if (event) events.push(event);
    }
    const job = run.integration;
    const prior = old.latestRun?.integration;
    if (job && (job.id !== prior?.id || job.attempt !== prior?.attempt || job.status !== prior?.status)) {
      const event = integrationNotification(task, run, job);
      if (event) events.push(event);
    }
    return events;
  });
}

export function autopilotStopped(state: Pick<AutopilotOverview, 'enabled' | 'stopReason' | 'stoppedAt'>): NotificationEvent | null {
  if (state.enabled || state.stoppedAt === null || !['until', 'failures', 'restart'].includes(state.stopReason ?? '')) return null;
  return { key: `autopilot:${state.stopReason}:${state.stoppedAt}`, category: 'autopilot',
    payload: { event: `autopilot.${state.stopReason}`, taskId: null, title: 'Autopilot', worker: null, status: state.stopReason!, at: state.stoppedAt } };
}

/** An empty pool while a run or merge is still working is not a finished queue. The switch stays on for newly added tasks. */
export function autopilotQueueEmpty(state: Pick<AutopilotOverview, 'enabled' | 'startedAt' | 'pool' | 'attempts'>, tasks: readonly Task[] = []): NotificationEvent | null {
  const latest = new Map(tasks.map(task => [task.id, task.latestRun]));
  const runs = state.attempts.map(run => latest.get(run.taskId) ?? run);
  if (!state.enabled || state.pool.length || !runs.length || runs.some(run =>
    !['completed', 'failed', 'blocked', 'cancelled'].includes(run.status) || run.integration && ['queued', 'checking', 'merging', 'cancelling'].includes(run.integration.status))) return null;
  const last = runs.at(-1)!;
  const at = Math.max(...runs.map(run => Math.max(run.finishedAt ?? run.updatedAt, run.integration?.updatedAt ?? 0)));
  return { key: `autopilot:empty:${state.startedAt}:${last.id}:${last.turn}:${last.integration?.attempt ?? 0}:${last.integration?.status ?? last.status}`, category: 'autopilot',
    payload: { event: 'autopilot.empty', taskId: null, title: 'Autopilot', worker: null, status: 'empty', at } };
}
