import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AutopilotInput, Effort, IntegratorProfileInput, TaskInput, WorkerInput } from '../src/lib/types';
import { AUTOPILOT_MAX_WINDOW_MS } from '../src/lib/autopilot';
import { DEFAULT_TASK_PRIORITY, isTaskPriority, TASK_PRIORITIES } from '../src/lib/priority';
import { AppError } from './errors';
import { validateWorkflowSteps } from './workflows';
import { attachmentIds } from './attachments';
import { effortOptions, normalizeModel, normalizeWorkerDescription } from '../src/lib/workers';
import { validateTagIds } from './tags';

export function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new AppError(`${label}: введите от 1 до ${max} символов`);
  return value.trim();
}
/** Minutes in settings and cards; null (or an omitted creation value) leaves the limit unset. */
export function validateTimeLimitMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new AppError('Лимит времени: введите целое число от 1 до 1440 минут или null');
  }
  return value;
}

export async function validateTask(value: unknown): Promise<TaskInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  const workerId = v.workerId ?? null;
  if (workerId !== null && (typeof workerId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(workerId))) throw new AppError('Некорректный работник');
  const title = textField(v.title, 'Название', 140);
  const instruction = textField(v.instruction, 'Инструкция', 16_000);
  if (v.provider !== 'codex' && v.provider !== 'claude') throw new AppError('Выберите Codex или Claude Code');
  const cwdInput = textField(v.cwd, 'Рабочая папка', 4_096);
  if (!isAbsolute(cwdInput)) throw new AppError('Нужен абсолютный путь к рабочей папке');
  let cwd: string;
  try {
    cwd = await realpath(cwdInput);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
  } catch { throw new AppError('Рабочая папка не существует или недоступна сервису'); }
  if (v.schedule !== 'manual' && v.schedule !== 'interval' && v.schedule !== 'auto') throw new AppError('Неизвестное расписание');
  if (typeof v.paused !== 'boolean') throw new AppError('paused должен быть boolean');
  const ultracode = v.ultracode ?? null;
  if (ultracode !== null && typeof ultracode !== 'boolean') throw new AppError('ultracode должен быть true, false или null');
  const priority = v.priority === undefined ? DEFAULT_TASK_PRIORITY : v.priority;
  if (!isTaskPriority(priority)) throw new AppError(`Приоритет: укажите ${TASK_PRIORITIES.join(', ')}`);
  let intervalMinutes: number | null = null;
  let firstRunAt: number | null = null;
  if (v.schedule === 'interval') {
    if (!Number.isInteger(v.intervalMinutes) || (v.intervalMinutes as number) < 1 || (v.intervalMinutes as number) > 525_600) throw new AppError('Интервал: от 1 до 525600 минут');
    intervalMinutes = v.intervalMinutes as number;
    if (v.firstRunAt != null) {
      if (typeof v.firstRunAt !== 'number' || !Number.isSafeInteger(v.firstRunAt) || v.firstRunAt < 0 || v.firstRunAt > 8_640_000_000_000_000) throw new AppError('Некорректное время первого запуска');
      firstRunAt = v.firstRunAt;
    }
  }
  return { ...(v.timeLimitMinutes !== undefined ? { timeLimitMinutes: validateTimeLimitMinutes(v.timeLimitMinutes) } : {}), ...(v.tagIds !== undefined ? { tagIds: validateTagIds(v.tagIds) } : {}), ...(v.attachmentIds !== undefined ? { attachmentIds: attachmentIds(v.attachmentIds) } : {}), steps: validateWorkflowSteps(v.steps), workerId, title, instruction, provider: v.provider, cwd, ultracode, priority, schedule: v.schedule, intervalMinutes, firstRunAt, paused: v.paused };
}

/** The autopilot switch. A stop time is optional; when enabling it must lie ahead and within a month. */
export function validateAutopilot(value: unknown, now = Date.now()): AutopilotInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean') throw new AppError('enabled должен быть boolean');
  const until = v.until ?? null;
  if (until !== null && (typeof until !== 'number' || !Number.isSafeInteger(until) || until < 0)) throw new AppError('Некорректное время остановки');
  if (v.enabled && until !== null && until <= now) throw new AppError('Время остановки уже прошло');
  if (v.enabled && until !== null && until > now + AUTOPILOT_MAX_WINDOW_MS) throw new AppError('Время остановки: не больше 31 дня вперёд');
  return { enabled: v.enabled, until: until as number | null };
}
/** A move within the autopilot queue: the card of the same priority that should follow the moved one, or null for the end of that priority. */
export function validateAutopilotMove(value: unknown, taskId: string): { beforeTaskId: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== 'beforeTaskId') || !Object.hasOwn(v, 'beforeTaskId')) throw new AppError('Укажите только поле beforeTaskId');
  const before = v.beforeTaskId;
  if (before !== null && (typeof before !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(before))) throw new AppError('beforeTaskId: укажите ID задачи или null');
  if (before === taskId) throw new AppError('Задачу нельзя поставить перед самой собой');
  return { beforeTaskId: before };
}

/** CLI settings, private instructions and avatar shared by worker profiles and the integrator profile. */
function executionProfile(v: Record<string, unknown>, instructionsLabel: string): Pick<WorkerInput, 'provider' | 'effort' | 'communicationStyle' | 'avatarUrl'> & { model: string | null } {
  if (v.provider !== 'codex' && v.provider !== 'claude') throw new AppError('Выберите Codex или Claude Code');
  const effort = v.effort === undefined ? 'default' : v.effort;
  let model: string | null;
  try { model = normalizeModel(v.model); }
  catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректная модель'); }
  if (typeof effort !== 'string' || !effortOptions[v.provider].includes(effort as Effort)) throw new AppError('Этот effort не поддерживается выбранным провайдером');
  const communicationStyle = v.communicationStyle === undefined ? '' : v.communicationStyle;
  if (typeof communicationStyle !== 'string' || communicationStyle.length > 4_000 || communicationStyle.includes('\0')) throw new AppError(`${instructionsLabel}: не больше 4000 символов`);
  const avatarUrl = v.avatarUrl ?? null;
  if (avatarUrl !== null && (typeof avatarUrl !== 'string' || !/^\/api\/avatars\/[a-f0-9]{64}$/.test(avatarUrl))) throw new AppError('Используйте загруженный аватар');
  return { provider: v.provider, model, effort: effort as Effort, communicationStyle: communicationStyle.trim(), avatarUrl };
}

export function validateWorker(value: unknown): WorkerInput & { archived?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  const name = textField(v.name, 'Имя работника', 80);
  let description: string;
  try { description = normalizeWorkerDescription(v.description); }
  catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректное описание'); }
  const profile = executionProfile(v, 'Личные инструкции');
  const ultracode = v.ultracode === undefined ? false : v.ultracode;
  if (typeof ultracode !== 'boolean') throw new AppError('ultracode должен быть boolean');
  const fallbackWorkerId = v.fallbackWorkerId ?? null;
  if (fallbackWorkerId !== null && (typeof fallbackWorkerId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(fallbackWorkerId))) throw new AppError('Замена при лимитах: выберите работника или оставьте поле пустым');
  if ('archived' in v && typeof v.archived !== 'boolean') throw new AppError('archived должен быть boolean');
  return { name, description, ...profile, ultracode, fallbackWorkerId, ...(typeof v.archived === 'boolean' ? { archived: v.archived } : {}) };
}

/** The built-in integrator's single profile. Inherit mode still stores CLI settings so switching back restores them. */
export function validateIntegratorProfile(value: unknown): IntegratorProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  if (v.mode !== 'inherit' && v.mode !== 'custom') throw new AppError('Выберите, откуда Интегратор берёт настройки: как у запуска или свои');
  return { mode: v.mode, ...executionProfile(v, 'Указания Интегратору') };
}
