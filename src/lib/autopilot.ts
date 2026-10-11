import type { AutopilotStopReason } from './types';

/** Consecutive failed or blocked autopilot runs that switch the autopilot off: a logged-out CLI or an exhausted account must not burn through the whole pool. */
export const AUTOPILOT_FAILURE_LIMIT = 3;
/** The farthest stop time accepted when enabling, so a typo cannot schedule a month of unattended work. */
export const AUTOPILOT_MAX_WINDOW_MS = 31 * 24 * 60 * 60_000;
export const AUTOPILOT_STOP_REASONS: Record<AutopilotStopReason, string> = {
  manual: 'выключен вручную',
  until: 'наступило время остановки',
  failures: `${AUTOPILOT_FAILURE_LIMIT} запуска подряд завершились ошибкой или блокировкой`,
  restart: 'перезапуск сервиса; включите снова после проверки прерванных запусков',
};
/** The suggested stop time for an overnight session: the next 08:00 local time at least an hour away. */
export function defaultAutopilotUntil(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next.getTime() <= now.getTime() + 60 * 60_000) next.setDate(next.getDate() + 1);
  return next;
}
