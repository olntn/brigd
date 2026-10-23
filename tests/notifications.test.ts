import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { NotificationQueue } from '../server/notifications';
import { autopilotQueueEmpty, autopilotStopped, taskNotifications } from '../src/lib/notification-events';
import type { AutopilotOverview, Run, Task } from '../src/lib/types';

const payload = { event: 'run.waiting_input', taskId: 'task-id', title: 'Задача', worker: 'Работник', status: 'waiting_input', at: 1234 };

describe('webhook delivery', () => {
  test('disabled URL sends nothing; enabled delivery signs the exact UTF-8 JSON and retries once', async () => {
    const received: RequestInit[] = [];
    const errors: string[] = [];
    const queue = new NotificationQueue((async (_url, init) => {
      received.push(init!);
      return new Response('', { status: received.length === 1 ? 503 : 200 });
    }) as typeof fetch, message => errors.push(message));
    queue.enqueue({ webhookUrl: '', webhookSecret: '' }, payload);
    await queue.idle();
    expect(received).toHaveLength(0);
    queue.enqueue({ webhookUrl: 'http://localhost/events', webhookSecret: 'secret' }, payload);
    await queue.idle();
    expect(received).toHaveLength(2);
    for (const init of received) {
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init.body as string)).toEqual(payload);
      expect(new Headers(init.headers).get('X-Brigd-Signature')).toBe(createHmac('sha256', 'secret').update(init.body as string).digest('hex'));
    }
    expect(received[0]!.body).toBe(received[1]!.body);
    expect(errors).toHaveLength(1);
  });
  test('network failures do not reject or stall later events and unsigned requests omit the header', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const queue = new NotificationQueue((async (_url, init) => {
      attempts++;
      expect(new Headers(init?.headers).has('X-Brigd-Signature')).toBe(false);
      if (attempts <= 2) throw new Error('Connection refused with sensitive receiver details');
      return new Response(null, { status: 204 });
    }) as typeof fetch, message => errors.push(message));
    queue.enqueue({ webhookUrl: 'http://localhost/events', webhookSecret: '' }, payload);
    queue.enqueue({ webhookUrl: 'http://localhost/events', webhookSecret: '' }, { ...payload, status: 'blocked' });
    await queue.idle();
    expect(attempts).toBe(3);
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).not.toContain('sensitive');
  });
});

function task(status: Run['status'], turn = 1): Task {
  return { id: 'task', title: 'Title', archivedAt: null, status, latestRun: {
    id: 'run', taskId: 'task', provider: 'codex', worker: null, status, turn, updatedAt: turn * 100,
    finishedAt: status === 'completed' ? turn * 100 : null, integration: null,
  } } as Task;
}

describe('notification transitions', () => {
  test('only status/turn transitions notify, including questions in a resumed session', () => {
    const running = task('running');
    const waiting = task('waiting_input');
    expect(taskNotifications([running], [waiting]).map(event => event.payload.event)).toEqual(['run.waiting_input']);
    expect(taskNotifications([waiting], [waiting])).toEqual([]);
    expect(taskNotifications([waiting], [task('waiting_input', 2)])).toHaveLength(1);
    expect(taskNotifications([running], [task('failed')])[0]?.category).toBe('failures');
    expect(taskNotifications([running], [task('completed')])).toEqual([]);
    expect(taskNotifications([], [waiting])).toEqual([]);
    expect(taskNotifications([running], [{ ...waiting, archivedAt: 100 }])).toEqual([]);
  });
  test('merges and completed tasks have separate event categories', () => {
    const before = task('completed');
    const after = structuredClone(before);
    after.latestRun!.integration = { id: 'merge', attempt: 1, status: 'merged', updatedAt: 200 } as NonNullable<Run['integration']>;
    expect(taskNotifications([before], [after])[0]).toMatchObject({ category: 'completed', payload: { event: 'task.merged' } });
    for (const status of ['failed', 'blocked', 'conflict', 'interrupted'] as const) {
      after.latestRun!.integration.status = status;
      expect(taskNotifications([before], [after])[0]?.category).toBe('merges');
    }
  });
  test('autopilot reports timed/circuit stops and only a fully settled empty queue', () => {
    const state = { enabled: true, startedAt: 10, pool: [], attempts: [task('running').latestRun!] } as unknown as AutopilotOverview;
    expect(autopilotQueueEmpty(state)).toBeNull();
    state.attempts = [task('waiting_input').latestRun!];
    expect(autopilotQueueEmpty(state)).toBeNull();
    state.attempts = [task('completed').latestRun!];
    expect(autopilotQueueEmpty(state)?.payload.event).toBe('autopilot.empty');
    state.pool = [task('running')];
    expect(autopilotQueueEmpty(state)).toBeNull();
    expect(autopilotStopped({ enabled: false, stoppedAt: 20, stopReason: 'failures' })?.payload.event).toBe('autopilot.failures');
    expect(autopilotStopped({ enabled: false, stoppedAt: 20, stopReason: 'until' })?.payload.event).toBe('autopilot.until');
    expect(autopilotStopped({ enabled: false, stoppedAt: 20, stopReason: 'manual' })).toBeNull();
  });
});
