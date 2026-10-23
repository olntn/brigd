import { tk } from './i18n/key';
import type { TaskPriority } from './types';

/** Most urgent first: the autopilot claims cards in this order, then by their place in the queue. */
export const TASK_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const satisfies readonly TaskPriority[];
export const DEFAULT_TASK_PRIORITY: TaskPriority = 'normal';
/** Russian labels, also used in server messages; the interface renders them through t(). */
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: tk('Критический'), high: tk('Высокий'), normal: tk('Обычный'), low: tk('Низкий'),
};
export const isTaskPriority = (value: unknown): value is TaskPriority => TASK_PRIORITIES.includes(value as TaskPriority);
