import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { Store } from '../server/store';

let folder: string, store: Store, engine: Engine, server: ReturnType<typeof Bun.serve>;
let host: string, origin: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-agent-client-'));
  store = new Store(join(folder, 'app.sqlite'));
  engine = new Engine(store, true);
  let handler: ReturnType<typeof createHandler>;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => handler(req) });
  host = `brigd.local:${server.port}`;
  origin = `http://${host}`;
  handler = createHandler(engine, { port: server.port!, root: folder, defaultCwd: folder, allowedHosts: [host], allowedOrigins: [origin] });
});
afterEach(async () => {
  server.stop(true);
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});
const worker = (name: string, provider: 'codex' | 'claude' = 'codex') => store.createWorker({
  name, provider, effort: 'default', communicationStyle: '', avatarUrl: null,
});
async function invoke(command: string, input?: unknown) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIGD_') && !key.startsWith('TRACKT_')));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../scripts/brigd.ts'), command], { cwd: folder,
    env: { ...env, PORT: String(server.port), BRIGD_ALLOWED_HOSTS: host, BRIGD_ALLOWED_ORIGINS: origin },
    stdin: input === undefined ? 'ignore' : new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, error, value: code === 0 ? JSON.parse(output) as any : null };
}

test('agent discovers employees and assigns a card by name without an MCP endpoint or token', async () => {
  const anna = worker('Анна', 'claude');
  expect((await invoke('info')).value).toMatchObject({ cwd: folder, scheduler: 'running' });
  expect((await invoke('workers')).value).toEqual(expect.arrayContaining([expect.objectContaining({ id: anna.id, name: 'Анна' })]));
  const result = await invoke('create-task', { worker: 'анна', title: 'Проверить отчёт', instruction: 'Проверить цифры и описать расхождения.' });
  expect(result).toMatchObject({ code: 0, error: '' });
  expect(result.value).toMatchObject({ title: 'Проверить отчёт', workerId: anna.id, provider: 'claude', cwd: folder, schedule: 'manual', runCount: 0 });
  expect(store.detail(result.value.id).runs).toEqual([]);
  expect((await invoke('tasks')).value.map((task: any) => task.id)).toEqual([result.value.id]);
  expect((await fetch(`http://127.0.0.1:${server.port}/mcp`, { headers: { Host: host } })).status).toBe(404);
});

test('agent can assign multiple employees by ID and uses the saved app working directory', async () => {
  const anna = worker('Анна', 'claude'), ivan = worker('Иван');
  store.setDefaultCwd(tmpdir());
  for (const employee of [anna, ivan]) {
    const result = await invoke('create-task', { worker: employee.id, title: `Задача для ${employee.name}`, instruction: 'Подготовить результат.' });
    expect(result.code).toBe(0);
    expect(result.value).toMatchObject({ workerId: employee.id, provider: employee.provider, cwd: tmpdir(), schedule: 'manual' });
  }
  expect(store.listTasks()).toHaveLength(2);
  expect(store.listTasks().every(task => task.runCount === 0)).toBe(true);
});

test('agent can set a card priority; an unknown priority creates nothing', async () => {
  const anna = worker('Анна');
  const rejected = await invoke('create-task', { worker: 'Анна', title: 'Срочно', instruction: 'Проверка', priority: 'срочно' });
  expect(rejected.code).toBe(1);
  expect(rejected.error).toContain('critical (Критический)');
  expect(store.listTasks()).toEqual([]);
  const result = await invoke('create-task', { worker: 'Анна', title: 'Срочно', instruction: 'Проверка', priority: 'critical' });
  expect(result.value).toMatchObject({ workerId: anna.id, priority: 'critical', schedule: 'manual' });
  expect((await invoke('create-task', { worker: 'Анна', title: 'Обычная', instruction: 'Проверка' })).value.priority).toBe('normal');
});

test('agent helper forwards dependsOn IDs through the task API without launching work', async () => {
  worker('Анна');
  const a = await invoke('create-task', { worker: 'Анна', title: 'A', instruction: 'Проверка' });
  const b = await invoke('create-task', { worker: 'Анна', title: 'B', instruction: 'Проверка', dependsOn: [a.value.id] });
  expect(b).toMatchObject({ code: 0, error: '', value: { dependsOnTaskIds: [a.value.id], schedule: 'manual', runCount: 0 } });
  expect(store.getTask(b.value.id).dependencies[0]).toMatchObject({ taskId: a.value.id, satisfied: false });
  const invalid = await invoke('create-task', { worker: 'Анна', title: 'Invalid', instruction: 'Проверка', dependsOn: [a.value.id, a.value.id] });
  expect(invalid.code).toBe(1);
  expect(store.listTasks()).toHaveLength(2);
});

test('unknown or archived employee and unsupported task fields do not create or launch work', async () => {
  const anna = worker('Анна');
  store.archiveWorker(anna.id);
  for (const input of [
    { worker: 'Не существует', title: 'Задача', instruction: 'Проверка' },
    { worker: anna.id, title: 'Задача', instruction: 'Проверка' },
    { worker: 'Анна', title: 'Задача', instruction: 'Проверка', schedule: 'auto' },
    { worker: 'Анна', title: '', instruction: 'Проверка' },
  ]) expect((await invoke('create-task', input)).code).toBe(1);
  expect(store.listTasks()).toEqual([]);
  expect(store.listWorkers()).toHaveLength(1);
});

test('ambiguous names require an employee ID and user text remains literal', async () => {
  const first = worker('Алексей');
  worker('Алексей');
  const input = { worker: 'Алексей', title: 'Проверить $(echo never) и `код`', instruction: 'Сохранить дословно: $HOME; echo x\nВторая строка.' };
  const ambiguous = await invoke('create-task', input);
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.error).toContain('неоднозначно');
  expect(store.listTasks()).toEqual([]);
  const result = await invoke('create-task', { ...input, worker: first.id, cwd: folder });
  expect(result.code).toBe(0);
  expect(store.getTask(result.value.id)).toMatchObject({ title: input.title, instruction: input.instruction, workerId: first.id });
});
