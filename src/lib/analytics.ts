import type { Provider, Task, TaskStatus } from './types';
import { TASK_PRIORITIES } from './priority';

export type AnalyticsPeriod = 'all' | '7' | '30' | '90';
export type AnalyticsGroup = 'ready' | 'active' | 'attention' | 'completed' | 'cancelled';
export const ANALYTICS_GROUPS: readonly AnalyticsGroup[] = ['ready', 'active', 'attention', 'completed', 'cancelled'];

/** Each card belongs to exactly one group, including integration and interrupted states. */
export const ANALYTICS_STATUS_GROUP: Record<TaskStatus, AnalyticsGroup> = {
  ready: 'ready', queued: 'active', preparing: 'active', running: 'active', cancelling: 'active',
  awaiting_merge: 'active', integrating: 'active', completed: 'completed', cancelled: 'cancelled',
  waiting_input: 'attention', blocked: 'attention', failed: 'attention', interrupted: 'attention',
  merge_conflict: 'attention', merge_failed: 'attention', merge_blocked: 'attention', merge_interrupted: 'attention',
};

export interface AnalyticsFilters {
  period: AnalyticsPeriod;
  provider: 'all' | Provider;
  includeArchived: boolean;
}

type AnalyticsTask = Pick<Task, 'id' | 'status' | 'priority' | 'createdAt' | 'archivedAt' | 'provider' | 'workerId'> & {
  worker: { id: string; name: string } | null;
  steps: { workerId: string }[];
};

export interface AnalyticsWorker {
  id: string;
  kind: 'worker' | 'workflow' | 'unassigned';
  name: string;
  count: number;
  groups: Record<AnalyticsGroup, number>;
}

const emptyGroups = (): Record<AnalyticsGroup, number> => ({ ready: 0, active: 0, attention: 0, completed: 0, cancelled: 0 });
const midnight = (timestamp: number) => { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date; };

/** Periods are calendar days in the browser's zone, including today. */
export function analyticsPeriodStart(period: AnalyticsPeriod, now: number): number | null {
  if (period === 'all') return null;
  const start = midnight(now);
  start.setDate(start.getDate() - Number(period) + 1);
  return start.getTime();
}

export function buildTaskAnalytics(tasks: readonly AnalyticsTask[], filters: AnalyticsFilters, now: number = Date.now()) {
  const start = analyticsPeriodStart(filters.period, now);
  const selected = tasks.filter(task => (filters.includeArchived || task.archivedAt === null)
    && (filters.provider === 'all' || task.provider === filters.provider)
    && Number.isFinite(task.createdAt) && task.createdAt <= now && (start === null || task.createdAt >= start));
  const groups = emptyGroups();
  const priorities = { critical: 0, high: 0, normal: 0, low: 0 };
  const workerMap = new Map<string, AnalyticsWorker>();
  let earliest = now;
  for (const task of selected) {
    const group = ANALYTICS_STATUS_GROUP[task.status];
    groups[group]++;
    priorities[task.priority]++;
    earliest = Math.min(earliest, task.createdAt);
    // A workflow is one card, not one card per participant.
    const kind = task.steps.length ? 'workflow' : task.workerId ? 'worker' : 'unassigned';
    const id = kind === 'worker' ? `worker:${task.workerId}` : kind;
    let worker = workerMap.get(id);
    if (!worker) {
      worker = { id, kind, name: task.worker?.name ?? task.workerId ?? '', count: 0, groups: emptyGroups() };
      workerMap.set(id, worker);
    }
    worker.count++;
    worker.groups[group]++;
  }

  const first = midnight(start ?? earliest);
  const spanDays = (now - first.getTime()) / 86_400_000;
  // Bound the all-time chart while preserving the selected time range.
  const granularity = spanDays > 730 ? 'year' : spanDays > 90 ? 'month' : 'day';
  const bucketDate = (timestamp: number) => {
    const date = midnight(timestamp);
    if (granularity !== 'day') date.setDate(1);
    if (granularity === 'year') date.setMonth(0);
    return date;
  };
  const counts = new Map<number, number>();
  for (const task of selected) {
    const key = bucketDate(task.createdAt).getTime();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const timeline: { date: number; count: number }[] = [];
  const cursor = bucketDate(first.getTime());
  while (cursor.getTime() <= now) {
    const date = cursor.getTime();
    timeline.push({ date, count: counts.get(date) ?? 0 });
    if (granularity === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else if (granularity === 'month') cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }

  return {
    total: selected.length,
    archived: selected.filter(task => task.archivedAt !== null).length,
    groups,
    completionRate: selected.length ? groups.completed / selected.length : 0,
    priorities: TASK_PRIORITIES.map(priority => ({ priority, count: priorities[priority] })),
    workers: [...workerMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    timeline,
    granularity,
  };
}
