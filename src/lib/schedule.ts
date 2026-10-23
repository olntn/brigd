import { tk } from './i18n/key';
import type { DefaultSchedule, TaskSchedule } from './types';

/** daily: at a local time of day on chosen weekdays, read in the card's own time zone. */
export const TASK_SCHEDULES = ['manual', 'interval', 'daily', 'auto'] as const satisfies readonly TaskSchedule[];
/** The general setting preselects one of these for a new card; a daily time is always chosen per card. */
export const DEFAULT_SCHEDULES = ['auto', 'manual', 'interval'] as const satisfies readonly DefaultSchedule[];
export const isTaskSchedule = (value: unknown): value is TaskSchedule => TASK_SCHEDULES.includes(value as TaskSchedule);
export const isDefaultSchedule = (value: unknown): value is DefaultSchedule => DEFAULT_SCHEDULES.includes(value as DefaultSchedule);

/** ISO 8601 numbering: 1 is Monday, 7 is Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WORKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5];
/** Russian labels; the interface renders them through t(). */
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  1: tk('Пн'), 2: tk('Вт'), 3: tk('Ср'), 4: tk('Чт'), 5: tk('Пт'), 6: tk('Сб'), 7: tk('Вс'),
};
export const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: tk('Понедельник'), 2: tk('Вторник'), 3: tk('Среда'), 4: tk('Четверг'), 5: tk('Пятница'), 6: tk('Суббота'), 7: tk('Воскресенье'),
};
/** A time zone name long enough for any IANA zone; Intl decides whether it exists. */
export const TIME_ZONE_MAX_LENGTH = 64;

/** 24-hour "HH:MM", as an `<input type="time">` reports it without seconds. */
export const isTimeOfDay = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
/** Distinct ISO weekdays in ascending order, or null when the value is not such a nonempty list. */
export function normalizeWeekdays(value: unknown): Weekday[] | null {
  if (!Array.isArray(value) || !value.length || value.length > WEEKDAYS.length) return null;
  if (!value.every(day => WEEKDAYS.includes(day as Weekday)) || new Set(value).size !== value.length) return null;
  return [...value as Weekday[]].sort((a, b) => a - b);
}
