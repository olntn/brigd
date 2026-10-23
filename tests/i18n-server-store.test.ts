import { describe, expect, test } from 'bun:test';
import { translateServer } from '../src/lib/i18n';
import { validateConcurrencyLimit } from '../src/lib/concurrency';
import { parseIntegrationChecks, validateIntegrationChecks } from '../src/lib/integration-checks';
import { normalizeModel, normalizeWorkerDescription } from '../src/lib/workers';

const english = (text: string) => translateServer('en', text);
const thrown = (action: () => unknown) => {
  try { action(); } catch (error) { return (error as Error).message; }
  throw new Error('Expected a validation error');
};

describe('store API errors in English', () => {
  test('translate fixed messages', () => {
    expect(english('Задача не найдена')).toBe('Task not found');
    expect(english('Страница в корзине. Восстановите её, чтобы редактировать.')).toBe('The page is in the trash. Restore it to edit.');
  });

  test('keep the values embedded in messages', () => {
    expect(english('База уже занята процессом PID 48213. Остановите второй brigd перед запуском.'))
      .toBe('The database is already in use by process PID 48213. Stop the other brigd before starting.');
    expect(english('Можно сохранить не больше 50 моделей для каждого провайдера')).toBe('You can save at most 50 models per provider');
    expect(english('Вложенность страниц ограничена 6 уровнями')).toBe('Page nesting is limited to 6 levels');
    expect(english('Приоритет: укажите critical, high, normal, low')).toBe('Priority: use one of critical, high, normal, low');
    expect(english('Интегратор уже 3 раза объединял этот результат, а целевая ветка снова конфликтует. Разрешите конфликт вручную в исходном worktree и повторите проверку.'))
      .toStartWith('The Integrator has already merged this result 3 times');
  });

  test('handle optional parts and embedded labels', () => {
    expect(english('Работник назначен в задачах: 1. Назначьте им другого работника или удалите эти задачи, затем повторите.'))
      .toBe('The worker is assigned to 1 task. Assign another worker to them or delete those tasks, then try again.');
    expect(english('Работник назначен в задачах: 4, из них в архиве: 2. Назначьте им другого работника или удалите эти задачи, затем повторите.'))
      .toBe('The worker is assigned to 4 tasks (2 archived). Assign another worker to them or delete those tasks, then try again.');
    expect(english('Задачу можно переставить только среди задач с тем же приоритетом («Высокий»). Чтобы она шла раньше или позже, измените её приоритет.'))
      .toBe('A task can only be moved among tasks with the same priority (“High”). To run it earlier or later, change its priority.');
  });

  test('translate validation errors that the store passes through', () => {
    const messages = [
      thrown(() => normalizeModel('model with spaces')),
      thrown(() => normalizeModel('bad\u0001model')),
      thrown(() => normalizeWorkerDescription('x'.repeat(100_000))),
      thrown(() => validateIntegrationChecks([])),
      thrown(() => parseIntegrationChecks('not json')),
      thrown(() => validateConcurrencyLimit(0, 'maxParallel')),
      thrown(() => validateConcurrencyLimit(99, 'maxPerRepository')),
    ];
    for (const message of messages) expect(english(message)).not.toMatch(/[А-Яа-яЁё]/);
    expect(english(messages[5]!)).toBe('Total processes: a whole number from 1 to 32');
  });

  test('do not touch similar prose', () => {
    const prose = 'Можно сохранить не больше пяти моделей, но я сохранил шесть';
    expect(english(prose)).toBe(prose);
  });
});
