import { expect, test } from 'bun:test';
import { conversationComments } from '../src/lib/activity';
import type { Attachment, Comment } from '../src/lib/types';

const answer = 'Привет! Я Codex, ИИ-помощник.';
function comment(id: string, kind: Comment['kind'], patch: Partial<Comment> = {}): Comment {
  return { id, kind, taskId: 'task', runId: 'run', stepIndex: null, body: answer, createdAt: 100, ...patch };
}
function attachment(id: string, commentId: string): Attachment {
  return { id, commentId, taskId: 'task', runId: 'run', stepIndex: null, attemptId: null,
    source: 'agent', name: `${id}.txt`, mime: 'text/plain', size: 10, sha256: id, previewable: false, createdAt: 100 };
}

test('an already saved answer and identical final summary display as one result', () => {
  const entries = [comment('answer', 'agent', { body: ` ${answer}\n` }), comment('summary', 'result')];
  const original = structuredClone(entries);
  expect(conversationComments(entries)).toEqual([{ ...entries[1], attachments: [] }]);
  expect(entries).toEqual(original);
});

test('collapsing a historical duplicate preserves all attachments and their original identities', () => {
  const first = attachment('first', 'answer');
  const second = attachment('second', 'summary');
  const entries = [comment('answer', 'agent', { attachments: [first] }), comment('summary', 'result', { attachments: [first, second] })];
  const result = conversationComments(entries);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: 'summary', kind: 'result', attachments: [first, second] });
  expect(entries[0]!.attachments).toEqual([first]);
});

test.each([
  ['a different result', { body: 'Другой ответ.' }],
  ['a different run', { runId: 'another-run' }],
  ['a different step', { stepIndex: 1 }],
  ['a different task', { taskId: 'another-task' }],
] as [string, Partial<Comment>][] )('preserves %s alongside the prior answer', (_label, patch) => {
  const entries = [comment('answer', 'agent'), comment('summary', 'result', patch)];
  expect(conversationComments(entries)).toEqual(entries);
});

test.each(['user', 'question', 'agent', 'result'] as const)('does not collapse repeated %s comments', kind => {
  const entries = [comment('first', kind), comment('second', kind)];
  expect(conversationComments(entries)).toEqual(entries);
});

test('a user quote, an explicit question, empty text, and missing run identity are never hidden', () => {
  for (const entries of [
    [comment('user', 'user'), comment('summary', 'result')],
    [comment('question', 'question'), comment('summary', 'result')],
    [comment('answer', 'agent', { body: '' }), comment('summary', 'result', { body: '' })],
    [comment('answer', 'agent', { runId: null }), comment('summary', 'result', { runId: null })],
  ]) expect(conversationComments(entries)).toEqual(entries);
});

test('hidden system messages and user replies keep repeated answers in separate turns', () => {
  for (const kind of ['system', 'user', 'question'] as const) {
    const first = comment('answer', 'agent');
    const boundary = comment('boundary', kind, { body: 'Продолжить работу' });
    const result = comment('summary', 'result');
    expect(conversationComments([first, boundary, result])).toEqual(kind === 'system' ? [first, result] : [first, boundary, result]);
  }
});
