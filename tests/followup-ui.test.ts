import { expect, test } from 'bun:test';
import type { Run, RunStep, Task, WorkerSnapshot } from '../src/lib/types';
import { followupFingerprint, followupStage, followupTargets, runWorkflowSteps, taskHasCompletedRun, followupSessionKey, resolveFollowupTarget } from '../src/lib/followups';

const worker = (id: string, provider: 'codex' | 'claude' = 'codex'): WorkerSnapshot => ({ id, name: id, description: 'Public role',
  provider, model: 'frozen-model', effort: 'high', communicationStyle: 'Private guidance', avatarUrl: null });
function run(id: string, extra: Partial<Run> = {}): Run {
  return { id, taskId: 'task', workerId: 'worker', worker: worker('worker'), provider: 'codex', cwd: '/project', instruction: 'Original task',
    instructions: [], trigger: 'manual', scheduledFor: null, status: 'completed', sessionId: `session-${id}`, startedAt: 1,
    updatedAt: 2, finishedAt: 2, summary: 'Completed result', error: null, turn: 1, mock: false, steps: [], currentStepIndex: null, ...extra };
}
function stage(index: number, provider: 'codex' | 'claude' = 'codex'): RunStep {
  return { workerId: `worker-${index}`, worker: worker(`worker-${index}`, provider), title: `Stage ${index + 1}`, instruction: 'Frozen stage',
    status: 'completed', sessionId: `stage-session-${index}`, startedAt: 1, updatedAt: 2, finishedAt: 2, summary: 'Stage done', error: null, attempts: [] };
}

test('follow-up recipient defaults to the last completed stage without mutating its history', () => {
  const workflow = run('workflow', { steps: [stage(0), stage(1, 'claude')], currentStepIndex: 1 });
  const before = JSON.stringify(workflow);
  const targets = followupTargets([workflow]);
  expect(targets.map(target => target.sourceStepIndex)).toEqual([1, 0]);
  expect(targets[0]).toMatchObject({ sourceRunId: workflow.id, worker: workflow.steps[1]!.worker, provider: 'claude', sessionId: 'stage-session-1', stageTitle: 'Stage 2' });
  expect(JSON.stringify(workflow)).toBe(before);
});

test('newest completed continuation replaces a duplicate session but preserves original stage label', () => {
  const workflow = run('workflow', { steps: [stage(0), stage(1)], currentStepIndex: 1 });
  const followup = run('additional', { startedAt: 4, sessionId: 'stage-session-0', worker: workflow.steps[0]!.worker,
    followup: { sourceRunId: workflow.id, sourceStepIndex: 0, request: 'Extra work', workflow: { steps: workflow.steps, currentStepIndex: 0 } } });
  const targets = followupTargets([workflow, followup]);
  expect(targets).toHaveLength(2);
  expect(targets[0]).toMatchObject({ sourceRunId: followup.id, sourceStepIndex: null, stageIndex: 0, stageTitle: 'Stage 1', isFollowup: true });
  expect(targets[1]).toMatchObject({ sourceRunId: workflow.id, sourceStepIndex: 1 });
  expect(followupStage(followup)).toEqual({ index: 0, title: 'Stage 1' });
  expect(runWorkflowSteps(followup)).toEqual(workflow.steps);
  expect(followup.steps).toEqual([]);
});

test('only completed source runs become targets; missing sessions stay explicit and providers do not collide', () => {
  const failed = run('failed', { status: 'failed', steps: [stage(0), { ...stage(1), status: 'failed' }], currentStepIndex: 1 });
  const waiting = run('waiting', { status: 'waiting_input' });
  const cancelled = run('cancelled', { status: 'cancelled' });
  const interrupted = run('interrupted', { status: 'interrupted' });
  const missing = run('missing', { sessionId: null, startedAt: 10 });
  const codex = run('codex', { sessionId: 'shared-session', startedAt: 9 });
  const claude = run('claude', { provider: 'claude', worker: worker('claude', 'claude'), sessionId: 'shared-session', startedAt: 8 });
  const targets = followupTargets([failed, waiting, cancelled, interrupted, missing, codex, claude]);
  expect(targets.map(target => target.sourceRunId)).toEqual(['missing', 'codex', 'claude']);
  expect(targets[0]!.sessionId).toBeNull();
});

test('equal-time input order stays stable for database newest-row ordering', () => {
  const newest = run('newest', { sessionId: 'same', startedAt: 1 });
  const older = run('older', { sessionId: 'same', startedAt: 1 });
  expect(followupTargets([newest, older]).map(target => target.sourceRunId)).toEqual(['newest']);
  expect(followupStage(older)).toBeNull();
  expect(runWorkflowSteps(null)).toEqual([]);
});

test('request fingerprint is stable across object field order and sensitive to every actual submission field', () => {
  const input = { sourceRunId: 'run', sourceStepIndex: null, body: 'Additional task', attachmentIds: ['first', 'second'] };
  const expected = followupFingerprint(input);
  expect(followupFingerprint({ body: input.body, attachmentIds: input.attachmentIds, sourceStepIndex: null, sourceRunId: 'run' })).toBe(expected);
  for (const changed of [
    { ...input, sourceRunId: 'other' }, { ...input, sourceStepIndex: 0 }, { ...input, body: 'Changed task' },
    { ...input, attachmentIds: ['second', 'first'] }, { ...input, attachmentIds: ['first'] },
  ]) expect(followupFingerprint(changed)).not.toBe(expected);
});

test('successful history forbids fresh manual reruns even after failed or cancelled follow-ups', () => {
  const task = (latestRun: Run | null, hasCompletedRun?: boolean): Task => ({ id: 'task', title: 'Task', instruction: 'Initial work',
    provider: 'codex', cwd: '/project', schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
    createdAt: 1, updatedAt: 1, nextRunAt: null, workerId: null, worker: null, steps: [], runCount: latestRun ? 1 : 0,
    latestRun, status: latestRun?.status ?? 'ready', ...(hasCompletedRun === undefined ? {} : { hasCompletedRun }) });
  expect(taskHasCompletedRun(task(null))).toBe(false);
  expect(taskHasCompletedRun(task(run('completed')))).toBe(true);
  expect(taskHasCompletedRun(task(run('failed-first', { status: 'failed' }), false))).toBe(false);
  expect(taskHasCompletedRun(task(run('failed-after-completion', { status: 'failed' }), true))).toBe(true);
  for (const status of ['failed', 'blocked', 'cancelled', 'interrupted'] as const) {
    expect(taskHasCompletedRun(task(run(status, { status, followup: { sourceRunId: 'completed', sourceStepIndex: null,
      request: 'Additional work', workflow: null } })))).toBe(true);
  }
});

test('an open draft keeps its native recipient when other tabs complete newer requests for different stages', () => {
  const source = run('workflow', { steps: [stage(0), stage(1)], currentStepIndex: 1 });
  const selected = followupTargets([source])[0]!;
  const identity = followupSessionKey(selected);
  const additional = (id: string, index: number, startedAt: number) => run(id, { startedAt, sessionId: source.steps[index]!.sessionId,
    worker: source.steps[index]!.worker, followup: { sourceRunId: source.id, sourceStepIndex: index,
      request: 'Other tab request', workflow: { steps: source.steps, currentStepIndex: index } } });
  const secondStage = additional('newer-second', 1, 10);
  const firstStage = additional('newest-first', 0, 20);
  const targets = followupTargets([firstStage, secondStage, source]);
  expect(targets[0]!.sessionId).toBe(source.steps[0]!.sessionId);
  const resolved = resolveFollowupTarget(targets, selected.key, identity);
  expect(resolved?.sourceRunId).toBe(secondStage.id);
  expect(resolved?.sessionId).toBe(source.steps[1]!.sessionId);
  expect(resolveFollowupTarget(targets, resolved!.key, identity)?.sessionId).toBe(source.steps[1]!.sessionId);
});

test('missing recipient blocks instead of falling back, while a genuinely new draft gets the latest default', () => {
  const targets = followupTargets([run('new')]);
  expect(resolveFollowupTarget(targets, 'missing:scalar', 'codex:missing')).toBeNull();
  expect(resolveFollowupTarget(targets, 'missing-no-session:scalar', '')).toBeNull();
  expect(resolveFollowupTarget(targets, '', '')).toEqual(targets[0]!);
  expect(followupSessionKey({ ...targets[0]!, sessionId: null })).toBe('');
  expect(resolveFollowupTarget([], '', '')).toBeNull();
});
