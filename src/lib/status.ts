import { tk } from './i18n/key';
import type { TaskStatus } from './types';

/** Russian labels; render them through t(). */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  awaiting_manual_transfer: tk('Ожидает ручного переноса'),
  queued: tk('В очереди'), preparing: tk('Подготовка'), awaiting_merge: tk('Ожидает слияния'), integrating: tk('Проверка и слияние'),
  merge_conflict: tk('Конфликт слияния'), merge_failed: tk('Проверка не прошла'), merge_blocked: tk('Перенос заблокирован'), merge_interrupted: tk('Слияние прервано'),
  ready: tk('К запуску'), running: tk('В работе'), cancelling: tk('Останавливается'), waiting_input: tk('Нужен ответ'), completed: tk('Завершено'),
  blocked: tk('Заблокировано'), failed: tk('Ошибка'), interrupted: tk('Прервано'), cancelled: tk('Отменено'),
};
