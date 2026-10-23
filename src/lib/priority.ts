import type { TaskPriority } from './types';

/** Most urgent first: the autopilot claims cards in this order, then by their place in the queue. */
export const TASK_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const satisfies readonly TaskPriority[];
export const DEFAULT_TASK_PRIORITY: TaskPriority = 'normal';
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: 'Критический', high: 'Высокий', normal: 'Обычный', low: 'Низкий',
};
export const isTaskPriority = (value: unknown): value is TaskPriority => TASK_PRIORITIES.includes(value as TaskPriority);
