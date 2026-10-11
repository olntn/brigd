import type { TaskStatus } from './types';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'В очереди', preparing: 'Подготовка', awaiting_merge: 'Ожидает слияния', integrating: 'Проверка и слияние',
  merge_conflict: 'Конфликт слияния', merge_failed: 'Проверка не прошла', merge_blocked: 'Перенос заблокирован', merge_interrupted: 'Слияние прервано',
  ready: 'К запуску', running: 'В работе', cancelling: 'Останавливается', waiting_input: 'Нужен ответ', completed: 'Завершено',
  blocked: 'Заблокировано', failed: 'Ошибка', interrupted: 'Прервано', cancelled: 'Отменено',
};
