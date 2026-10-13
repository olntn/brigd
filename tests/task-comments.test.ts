import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { prepareAttachment } from '../server/attachments';
import { AppError, Store } from '../server/store';
import type { TaskInput } from '../src/lib/types';

const BASE = 1_700_000_000_000;
const input = (): TaskInput => ({
  title: 'Read task history', instruction: 'Inspect the comments and attached files.',
  provider: 'codex', cwd: '/tmp', schedule: 'manual', intervalMinutes: null,
  firstRunAt: null, paused: false,
});

let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

describe('bounded task comment history', () => {
  test('pages one task in insertion order when timestamps are identical', () => {
    const task = store.createTask(input(), BASE);
    const other = store.createTask(input(), BASE);
    const first = store.comment(task.id, null, 'user', 'First', BASE);
    store.comment(other.id, null, 'user', 'Unrelated task', BASE);
    const second = store.comment(task.id, null, 'agent', 'Second', BASE);
    const third = store.comment(task.id, null, 'system', 'Third', BASE);
    const fourth = store.comment(task.id, null, 'result', 'Fourth', BASE);
    const throughSequence = store.commentCursor(task.id);

    // A caller can fetch one extra row to decide whether another page exists.
    expect(store.listTaskComments(task.id, { offset: 0, limit: 3, throughSequence })).toEqual([first, second, third]);
    expect(store.listTaskComments(task.id, { offset: 2, limit: 3, throughSequence })).toEqual([third, fourth]);
    expect(store.listTaskComments(task.id, { offset: 4, limit: 3, throughSequence })).toEqual([]);
    expect(store.listTaskComments(other.id, { offset: 0, limit: 21, throughSequence }).map(comment => comment.body)).toEqual(['Unrelated task']);
  });

  test('sequence snapshot excludes later comments even with an older timestamp', () => {
    const task = store.createTask(input(), BASE);
    const first = store.comment(task.id, null, 'user', 'Available at invocation start', BASE);
    const throughSequence = store.commentCursor(task.id);
    store.comment(task.id, null, 'user', 'Added during the invocation', BASE - 1);

    expect(store.listTaskComments(task.id, { offset: 0, limit: 21, throughSequence })).toEqual([first]);
    expect(store.listTaskComments(task.id, { offset: 1, limit: 21, throughSequence })).toEqual([]);
    expect(store.listTaskComments(task.id, { offset: 0, limit: 21, throughSequence: store.commentCursor(task.id) })).toHaveLength(2);
  });

  test('returns attachment metadata and run attribution without file bytes', async () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    const prepared = await prepareAttachment(Buffer.from('Attached file content'), 'text/plain', 'details.txt');
    const attachment = store.stageAttachment(prepared, BASE);
    const comment = store.comment(task.id, run.id, 'user', 'Read this attachment', BASE, undefined, [attachment.id]);
    const comments = store.listTaskComments(task.id, { offset: 0, limit: 21, throughSequence: store.commentCursor(task.id) });

    expect(comments).toContainEqual(comment);
    expect(comments.find(item => item.id === comment.id)).toMatchObject({
      taskId: task.id, runId: run.id, stepIndex: null,
      attachments: [expect.objectContaining({ id: attachment.id, taskId: task.id, commentId: comment.id, name: 'details.txt' })],
    });
    expect(JSON.stringify(comments)).not.toContain('Attached file content');
    expect(Buffer.from(store.readAttachment(task.id, attachment.id).data).toString()).toBe('Attached file content');
  });

  test('empty snapshots stay empty and missing tasks are rejected', () => {
    const task = store.createTask(input(), BASE);
    expect(store.commentCursor(task.id)).toBe(0);
    store.comment(task.id, null, 'user', 'Later', BASE);
    expect(store.listTaskComments(task.id, { offset: 0, limit: 21, throughSequence: 0 })).toEqual([]);
    expect(() => store.listTaskComments('missing', { offset: 0, limit: 21, throughSequence: 0 })).toThrow(AppError);
    try { store.listTaskComments('missing', { offset: 0, limit: 21, throughSequence: 0 }); }
    catch (error) { expect((error as AppError).status).toBe(404); }
  });

  test.each([
    { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: Number.NaN },
    { limit: 0 }, { limit: 22 }, { limit: 1.5 }, { limit: Number.POSITIVE_INFINITY },
    { throughSequence: -1 }, { throughSequence: 0.5 }, { throughSequence: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid history bounds %j', patch => {
    const task = store.createTask(input(), BASE);
    expect(() => store.listTaskComments(task.id, { offset: 0, limit: 21, throughSequence: 0, ...patch })).toThrow(AppError);
  });
});
