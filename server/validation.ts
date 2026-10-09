import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Effort, TaskInput, WorkerInput } from '../src/lib/types';
import { AppError } from './store';
import { effortOptions } from '../src/lib/workers';

export function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new AppError(`${label}: введите от 1 до ${max} символов`);
  return value.trim();
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
  if (v.schedule !== 'manual' && v.schedule !== 'interval') throw new AppError('Неизвестное расписание');
  if (typeof v.paused !== 'boolean') throw new AppError('paused должен быть boolean');
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
  return { workerId, title, instruction, provider: v.provider, cwd, schedule: v.schedule, intervalMinutes, firstRunAt, paused: v.paused };
}

export function validateWorker(value: unknown): WorkerInput & { archived?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  const name = textField(v.name, 'Имя работника', 80);
  if (v.provider !== 'codex' && v.provider !== 'claude') throw new AppError('Выберите Codex или Claude Code');
  const effort = v.effort === undefined ? 'default' : v.effort;
  if (typeof effort !== 'string' || !effortOptions[v.provider].includes(effort as Effort)) throw new AppError('Этот effort не поддерживается выбранной моделью');
  const communicationStyle = v.communicationStyle === undefined ? '' : v.communicationStyle;
  if (typeof communicationStyle !== 'string' || communicationStyle.length > 4_000 || communicationStyle.includes('\0')) throw new AppError('Стиль общения: не больше 4000 символов');
  const avatarUrl = v.avatarUrl ?? null;
  if (avatarUrl !== null && (typeof avatarUrl !== 'string' || !/^\/api\/avatars\/[a-f0-9]{64}$/.test(avatarUrl))) throw new AppError('Используйте загруженный аватар');
  if ('archived' in v && typeof v.archived !== 'boolean') throw new AppError('archived должен быть boolean');
  return { name, provider: v.provider, effort: effort as Effort, communicationStyle: communicationStyle.trim(), avatarUrl,
    ...(typeof v.archived === 'boolean' ? { archived: v.archived } : {}) };
}
