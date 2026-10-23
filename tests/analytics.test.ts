import { describe, expect, test } from 'bun:test';
import { ANALYTICS_GROUPS, ANALYTICS_STATUS_GROUP, analyticsPeriodStart, buildTaskAnalytics, type AnalyticsFilters } from '../src/lib/analytics';
import { TASK_STATUS_LABELS } from '../src/lib/status';
import type { TaskStatus } from '../src/lib/types';

const now = new Date(2026, 9, 23, 12).getTime();
const defaults: AnalyticsFilters = { period: 'all', provider: 'all', includeArchived: true };
type Card = Parameters<typeof buildTaskAnalytics>[0][number];
function task(id: string, overrides: Partial<Card> = {}): Card {
  return { id, status: 'ready', priority: 'normal', provider: 'codex', createdAt: now, archivedAt: null,
    workerId: null, worker: null, steps: [], ...overrides };
}

describe('task analytics', () => {
  test('covers every task state exactly once, including manual transfer and integration failures', () => {
    expect(Object.keys(ANALYTICS_STATUS_GROUP).sort()).toEqual(Object.keys(TASK_STATUS_LABELS).sort());
    const tasks = Object.keys(TASK_STATUS_LABELS).map(status => task(status, { status: status as TaskStatus }));
    const result = buildTaskAnalytics(tasks, defaults, now);
    expect(result.total).toBe(tasks.length);
    expect(result.groups).toEqual({ ready: 1, active: 6, attention: 9, completed: 1, cancelled: 1 });
    expect(ANALYTICS_GROUPS.reduce((sum, group) => sum + result.groups[group], 0)).toBe(result.total);
    expect(result.completionRate).toBe(1 / tasks.length);
  });

  test('combines creation period, archive and provider filters without changing inputs', () => {
    const start = analyticsPeriodStart('7', now)!;
    const tasks = [task('boundary', { createdAt: start }), task('old', { createdAt: start - 1 }),
      task('archived', { archivedAt: now }), task('claude', { provider: 'claude' }),
      task('future', { createdAt: now + 1 }), task('invalid', { createdAt: NaN })];
    const snapshot = JSON.stringify(tasks);
    const filtered = buildTaskAnalytics(tasks, { period: '7', provider: 'codex', includeArchived: false }, now);
    expect(filtered.total).toBe(1);
    expect(filtered.archived).toBe(0);
    expect(filtered.timeline[0]).toEqual({ date: start, count: 1 });
    expect(buildTaskAnalytics(tasks, { ...defaults, period: '7' }, now).total).toBe(3);
    expect(buildTaskAnalytics(tasks, defaults, now).total).toBe(4);
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });

  test('counts archived completions and every priority', () => {
    const result = buildTaskAnalytics([task('a', { status: 'completed', archivedAt: now, priority: 'high' }),
      task('b', { priority: 'critical' }), task('c'), task('d', { priority: 'low' })], defaults, now);
    expect(result.archived).toBe(1);
    expect(result.groups.completed).toBe(1);
    expect(result.completionRate).toBe(.25);
    expect(result.priorities.map(item => item.count)).toEqual([1, 1, 1, 1]);
  });

  test('counts workflow cards once and keeps distinct workers with the same name', () => {
    const assigned = (id: string, status: TaskStatus) => task(id, { workerId: id, worker: { id, name: 'Alex' }, status });
    const result = buildTaskAnalytics([assigned('a', 'completed'), assigned('b', 'failed'), task('unassigned'),
      task('workflow', { workerId: 'a', worker: { id: 'a', name: 'Alex' }, steps: [{ workerId: 'a' }, { workerId: 'b' }] })], defaults, now);
    expect(result.workers).toHaveLength(4);
    expect(result.workers.reduce((sum, worker) => sum + worker.count, 0)).toBe(4);
    expect(result.workers.find(worker => worker.id === 'worker:a')?.groups.completed).toBe(1);
    expect(result.workers.find(worker => worker.id === 'worker:b')?.groups.attention).toBe(1);
    expect(result.workers.find(worker => worker.kind === 'workflow')?.count).toBe(1);
  });

  test('fills missing calendar days with zeros and includes today', () => {
    const start = analyticsPeriodStart('7', now)!;
    const result = buildTaskAnalytics([task('first', { createdAt: start }), task('today'), task('today-2')], { ...defaults, period: '7' }, now);
    expect(result.granularity).toBe('day');
    expect(result.timeline).toHaveLength(7);
    expect(result.timeline.map(point => point.count)).toEqual([1, 0, 0, 0, 0, 0, 2]);
    expect(result.timeline[6]!.date).toBe(new Date(2026, 9, 23).getTime());
  });

  test('aggregates long histories without losing tasks or creating a huge daily series', () => {
    const monthly = buildTaskAnalytics([task('old', { createdAt: new Date(2025, 9, 23).getTime() }), task('new')], defaults, now);
    expect(monthly.granularity).toBe('month');
    expect(monthly.timeline).toHaveLength(13);
    expect(monthly.timeline.reduce((sum, point) => sum + point.count, 0)).toBe(2);
    const yearly = buildTaskAnalytics([task('old', { createdAt: new Date(2010, 0, 1).getTime() }), task('new')], defaults, now);
    expect(yearly.granularity).toBe('year');
    expect(yearly.timeline).toHaveLength(17);
    expect(yearly.timeline.reduce((sum, point) => sum + point.count, 0)).toBe(2);
  });

  test('keeps calendar days aligned across daylight saving transitions', () => {
    for (const month of [2, 10]) {
      const endDay = month === 2 ? 10 : 3;
      const end = new Date(2026, month, endDay, 12).getTime();
      const transition = new Date(2026, month, endDay - 2, 23, 59).getTime();
      const result = buildTaskAnalytics([task('before-midnight', { createdAt: transition }),
        task('after-midnight', { createdAt: transition + 120_000 })], { ...defaults, period: '7' }, end);
      expect(result.timeline).toHaveLength(7);
      expect(result.timeline.map(point => point.date)).toEqual(Array.from({ length: 7 }, (_, index) => new Date(2026, month, endDay - 6 + index).getTime()));
      expect(result.timeline.map(point => point.count)).toEqual([0, 0, 0, 0, 1, 1, 0]);
    }
  });

  test('empty selections have finite zero metrics', () => {
    const result = buildTaskAnalytics([], { ...defaults, period: '30' }, now);
    expect(result.total).toBe(0);
    expect(result.completionRate).toBe(0);
    expect(result.timeline).toHaveLength(30);
    expect(result.timeline.every(point => point.count === 0)).toBe(true);
    expect(result.workers).toEqual([]);
    expect(buildTaskAnalytics([], defaults, now).timeline).toHaveLength(1);
  });
});
