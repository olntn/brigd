import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AppError, Store } from '../server/store';
import type { Task, TaskInput } from '../src/lib/types';

const BASE = 1_700_000_000_000;
const REFERENCE_ID = 'd91b14ac-1234-4567-89ab-0123456789ab';
const input = (): TaskInput => ({
  title: 'Referenced task', instruction: 'Read this task from its displayed ID.',
  provider: 'codex', cwd: '/tmp', schedule: 'manual', intervalMinutes: null,
  firstRunAt: null, paused: false,
});
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

function taskWithId(id: string): Task {
  const task = store.createTask(input(), BASE);
  store.db.query('UPDATE tasks SET id=? WHERE id=?').run(id, task.id);
  return store.getTask(id);
}
function expectStatus(action: () => unknown, status: number, message?: string) {
  try { action(); throw new Error('Expected an AppError'); }
  catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(status);
    if (message) expect((error as AppError).message).toContain(message);
  }
}

describe('task reference resolution', () => {
  test.each([
    'D91B14', 'd91b14', 'D91B14AC', 'd91b14ac', 'D91B14AC-',
    'D91B14AC-12', 'D91B14AC-1234-4567', REFERENCE_ID, REFERENCE_ID.toUpperCase(),
  ])('resolves displayed and longer UUID references: %s', reference => {
    const task = taskWithId(REFERENCE_ID);
    expect(store.resolveTaskReference(reference)).toEqual(task);
  });

  test('case-insensitive references resolve UUIDs stored with uppercase characters', () => {
    const task = taskWithId(REFERENCE_ID.toUpperCase());
    expect(store.resolveTaskReference('d91b14')).toEqual(task);
    expect(store.resolveTaskReference(REFERENCE_ID)).toEqual(task);
  });

  test('ambiguous displayed prefixes require a full ID or distinguishing longer prefix', () => {
    const first = taskWithId(REFERENCE_ID);
    const second = taskWithId('d91b14ac-5678-4567-89ab-0123456789ab');
    expectStatus(() => store.resolveTaskReference('D91B14'), 409, 'полный ID');
    expectStatus(() => store.resolveTaskReference('D91B14AC'), 409, 'полный ID');
    expect(store.resolveTaskReference('d91b14ac-1')).toEqual(first);
    expect(store.resolveTaskReference('D91B14AC-5')).toEqual(second);
    expect(store.resolveTaskReference(first.id)).toEqual(first);
    expect(store.resolveTaskReference(second.id)).toEqual(second);
  });

  test('an exact stored ID wins over another task sharing its prefix', () => {
    const exact = taskWithId('d91b14ac');
    taskWithId(REFERENCE_ID);
    expect(store.resolveTaskReference('D91B14AC')).toEqual(exact);
  });

  test('archived tasks remain readable and take part in ambiguity checks', () => {
    const task = taskWithId(REFERENCE_ID);
    const archived = store.archiveTask(task.id, BASE + 1);
    expect(store.resolveTaskReference('D91B14AC')).toEqual(archived);
    expect(store.resolveTaskReference(task.id.toUpperCase())).toEqual(archived);
    const current = taskWithId('d91b14ac-5678-4567-89ab-0123456789ab');
    expectStatus(() => store.resolveTaskReference('D91B14AC'), 409);
    expect(store.resolveTaskReference(current.id)).toEqual(current);
  });

  test('valid references with no task return not found', () => {
    taskWithId(REFERENCE_ID);
    expectStatus(() => store.resolveTaskReference('000000'), 404);
    expectStatus(() => store.resolveTaskReference('00000000-0000-0000-0000-000000000000'), 404);
    expectStatus(() => store.resolveTaskReference('D91B14AC-9'), 404);
  });

  test.each([
    '', 'd91b1', ' d91b14ac', 'd91b14ac ', 'd91b14ac%', 'd91b14ac_',
    "d91b14ac' OR 1=1", 'd91b14ac; DROP TABLE tasks', 'g91b14ac',
    'd91b-14ac', 'd91b14ac--1', 'd91b14ac1', 'd91b14ac-12345',
    'd91b14ac-1234-4567-89ab-0123456789ab0', 'd91b14ac\0',
  ])('rejects malformed or unsafe references: %j', reference => {
    taskWithId(REFERENCE_ID);
    expectStatus(() => store.resolveTaskReference(reference), 400);
    expect(store.getTask(REFERENCE_ID).id).toBe(REFERENCE_ID);
  });
});
