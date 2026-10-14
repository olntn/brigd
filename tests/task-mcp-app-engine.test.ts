import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import { createTaskBroker, type TaskBroker } from '../server/task-mcp';
import type { TaskAppAccess } from '../server/task-mcp-app';
import { controlledAgent, taskInput } from './repository-helpers';

test('engine supplies the app controller to task bridges for card management and revokes it on cancellation', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'brigd-app-engine-'));
  const store = new Store(join(folder, 'app.sqlite'));
  const agent = controlledAgent();
  let broker: TaskBroker | undefined;
  let forwarded: TaskAppAccess | undefined;
  const engine = new Engine(store, false, agent.factory, (database, run, fence, access) => {
    forwarded = access;
    broker = createTaskBroker(database, run, fence, access);
    broker.agentConfig.env.BRIGD_TASK_SOCKET = '/tmp/brigd-app-engine-test.sock';
    return broker;
  });
  const host = 'internal.brigd.test:4310';
  const origin = 'https://app.brigd.test';
  const paths: string[] = [];
  const access: TaskAppAccess = { async request(method, path, body, invocation) {
    paths.push(path);
    const handler = createHandler(engine, { port: 4310, allowedHosts: [host], allowedOrigins: [origin],
      authorizeMutation() {
        if (!invocation.isCurrent()) throw new AppError('Invocation is no longer current.', 409);
      },
    });
    return handler(new Request(origin + path, { method, headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' },
      ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body ?? {}) } : {}),
    }));
  } };
  const call = (tool: string, args: Record<string, unknown>) => broker!.dispatch({
    capability: broker!.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: crypto.randomUUID(), tool, arguments: args,
  });
  try {
    engine.setTaskAppAccess(access);
    const current = store.createTask(taskInput(folder));
    const run = engine.start(current.id);
    expect(agent.calls).toHaveLength(1);
    expect(forwarded).toBe(access);

    const create = { data: { title: 'Managed child card', instruction: 'Wait for a later manual launch.' }, idempotency_key: 'engine-create-card' };
    expect((await call('create_task', create)).isError).not.toBe(true);
    const created = store.listTasks().find(task => task.title === 'Managed child card')!;
    expect(created).toMatchObject({ cwd: folder, provider: current.provider, schedule: 'manual', paused: false, runCount: 0 });
    expect((await call('create_task', create)).isError).not.toBe(true);
    expect(store.listTasks().filter(task => task.title === created.title)).toHaveLength(1);
    expect((await call('archive_task', { task_id: created.id.slice(0, 8).toUpperCase(), idempotency_key: 'engine-archive-card' })).isError).not.toBe(true);
    expect(store.getTask(created.id).archivedAt).not.toBeNull();
    expect(paths).toEqual(['/api/tasks', `/api/tasks/${created.id}/archive`]);

    engine.cancel(run.id);
    expect((await call('create_task', { data: { title: 'After cancellation', instruction: 'Must not be created.' }, idempotency_key: 'engine-revoked' })).isError).toBe(true);
    expect(store.listTasks().some(task => task.title === 'After cancellation')).toBe(false);
  } finally {
    for (const invocation of agent.calls) invocation.reject(new Error('Test cleanup'));
    await engine.shutdown();
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
