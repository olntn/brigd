import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BackupOverview, Run, Task, TaskDetail } from '../src/lib/types';
import { repository, taskInput } from './repository-helpers';

const root = resolve(import.meta.dir, '..');
const servers: { child: ReturnType<typeof Bun.spawn>; folder: string; logs: Promise<string[]> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.child.exitCode === null) server.child.kill('SIGTERM');
    const deadline = setTimeout(() => { if (server.child.exitCode === null) server.child.kill('SIGKILL'); }, 5_000);
    try { await server.child.exited; await server.logs; }
    finally { clearTimeout(deadline); rmSync(server.folder, { recursive: true, force: true }); }
  }
});

interface ReceiptEvent {
  type: string;
  tool?: string;
  value?: Record<string, any>;
  received?: boolean;
  runId?: string;
  taskId?: string;
  message?: string;
}

async function start() {
  const folder = mkdtempSync(join(tmpdir(), 'brigd-mcp-app-runtime-'));
  const project = repository(folder);
  const bin = join(folder, 'bin');
  mkdirSync(bin);
  // Resolve the SDK from the repository, because this executable lives outside
  // its node_modules tree. The helper is deliberately the source under test.
  const executable = join(bin, 'codex');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import { StdioClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};

if (process.argv.includes('--help')) {
  console.log('--json --sandbox --config --strict-config --output-schema --model SESSION_ID');
  process.exit(0);
}
const prompt = process.argv.at(-1);
const instruction = prompt.split('\\nUSER TASK:\\n')[1];
const config = JSON.parse(instruction);
const metadata = prompt.split('\\n').map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).find(value => value?.runId && value?.taskId && value?.server);
let received = false;
const write = event => appendFileSync(config.marker, JSON.stringify(event) + '\\n');
process.on('SIGTERM', () => {
  write({ type: 'stopped', received, runId: metadata.runId });
  process.exit(0);
});
const emit = event => console.log(JSON.stringify(event));
emit({ type: 'thread.started', thread_id: 'native-' + metadata.runId });
emit({ type: 'turn.started' });
let client;
try {
  if (!process.argv.includes('--strict-config')) throw new Error('Task bridge strict configuration was not supplied.');
  const allowed = process.argv.find(value => value.startsWith('mcp_servers.' + metadata.server + '.enabled_tools='));
  if (!allowed) throw new Error('Task tools were not configured for the CLI.');
  const enabled = JSON.parse(allowed.slice(allowed.indexOf('=') + 1));
  for (const tool of ['create_task', 'archive_task', 'create_backup', 'restore_backup', 'cancel_run']) {
    if (!enabled.includes(tool)) throw new Error('CLI tool is not enabled: ' + tool);
  }
  client = new Client({ name: 'native-fake-codex', version: '1' });
  await client.connect(new StdioClientTransport({
    command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(join(root, 'server/task-mcp-stdio.ts'))}],
    env: { ...process.env, BRIGD_TASK_SOCKET: process.env.BRIGD_TASK_SOCKET, BRIGD_TASK_CAPABILITY: process.env.BRIGD_TASK_CAPABILITY },
    stderr: 'pipe',
  }));
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const tool of ['create_task', 'archive_task', 'create_backup', 'restore_backup', 'cancel_run']) {
    if (!tools.includes(tool)) throw new Error('MCP catalogue is missing: ' + tool);
  }
  write({ type: 'connected', runId: metadata.runId, taskId: metadata.taskId });
  const call = async (tool, args) => {
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError) throw new Error(tool + ': ' + JSON.stringify(result.content));
    const value = JSON.parse(result.content.find(content => content.type === 'text').text);
    write({ type: 'receipt', tool, value, runId: metadata.runId, taskId: metadata.taskId });
    return value;
  };
  const creation = { data: { title: config.title, instruction: 'Created through native MCP.' }, idempotency_key: 'native-card' };
  const card = await call('create_task', creation);
  const retriedCard = await call('create_task', creation);
  if (card.id !== retriedCard.id) throw new Error('Task retry created a second card.');
  const backupArgs = { idempotency_key: 'native-backup' };
  const backup = await call('create_backup', backupArgs);
  const retriedBackup = await call('create_backup', backupArgs);
  if (backup.id !== retriedBackup.id) throw new Error('Backup retry created a second snapshot.');
  await call('archive_task', { task_id: card.id.slice(0, 8).toUpperCase(), idempotency_key: 'native-archive' });
  if (config.mode === 'restore') {
    await call('create_task', { data: { title: 'After native snapshot', instruction: 'This card must disappear after restore.' }, idempotency_key: 'native-later-card' });
    await call('restore_backup', { backup_id: backup.id, idempotency_key: 'native-restore' });
  } else {
    await call('cancel_run', { run_id: metadata.runId, data: {}, idempotency_key: 'native-self-cancel' });
  }
  received = true;
  // Remain alive so cancellation/restoration, rather than normal CLI exit,
  // must stop this process after it received the SDK response.
  setInterval(() => {}, 1_000);
} catch (error) {
  write({ type: 'failure', message: String(error) });
  await client?.close();
  process.exit(1);
}
`);
  chmodSync(executable, 0o700);
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port!;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIGD_') && !key.startsWith('TRACKT_')));
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`, PORT: String(port), BRIGD_MODE: 'cli', BRIGD_CLI_ACCESS: 'standard',
    BRIGD_DB: join(folder, 'app.sqlite'), BRIGD_HOST: '127.0.0.1', BRIGD_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    BRIGD_ALLOWED_ORIGINS: origin, BRIGD_CLI_HOME: join(folder, 'cli-home'), BRIGD_DEFAULT_CWD: project,
    BRIGD_UPDATE_BACKUP_DIR: join(folder, 'update-backups'), BRIGD_WORKSPACES_DIR: join(folder, 'workspaces'),
    BRIGD_INTEGRATION_CHECKS: JSON.stringify([[process.execPath, '-e', 'process.exit(0)']]), BRIGD_INTEGRATOR: 'manual',
  });
  const child = Bun.spawn([process.execPath, join(root, 'server/index.ts')], { env, stdout: 'pipe', stderr: 'pipe' });
  const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  servers.push({ child, folder, logs });
  async function json<T>(path: string, method = 'GET', value: unknown = {}): Promise<T> {
    const response = await fetch(origin + path, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, description: string): Promise<T> {
    const deadline = Date.now() + 12_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Native MCP server exited: ${(await logs).join('\n')}`);
      try {
        const value = await read();
        if (ready(value)) return value;
      } catch (error) { lastError = error; }
      await Bun.sleep(20);
    }
    throw new Error(`${description} did not settle${lastError ? ': ' + lastError : ''}`);
  }
  await waitFor(() => json('/api/info'), () => true, 'Native server startup');
  const events = (marker: string): ReceiptEvent[] => existsSync(marker)
    ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  async function launch(mode: 'cancel' | 'restore', title: string) {
    const marker = join(folder, `${crypto.randomUUID()}.jsonl`);
    const task = await json<Task>('/api/tasks', 'POST', taskInput(project, { title: 'Native MCP controller', instruction: JSON.stringify({ mode, title, marker }) }));
    const run = await json<Run>(`/api/tasks/${task.id}/run`, 'POST');
    const history = await waitFor(() => events(marker), entries => entries.some(entry => ['stopped', 'failure'].includes(entry.type)), 'Native CLI completion');
    expect(history.find(event => event.type === 'failure')).toBeUndefined();
    return { task, run, history };
  }
  const readRun = async (taskId: string, runId: string) => (await json<TaskDetail>(`/api/tasks/${taskId}`)).runs.find(run => run.id === runId)!;
  return { folder, project, child, json, waitFor, launch, readRun };
}

function acceptedBeforeStop(history: ReceiptEvent[], tool: 'cancel_run' | 'restore_backup') {
  const index = history.findIndex(event => event.type === 'receipt' && event.tool === tool);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(history[index]!.value).toEqual({ accepted: true, status: 'queued', action: tool });
  const stopped = history.findIndex(event => event.type === 'stopped');
  expect(stopped).toBeGreaterThan(index);
  expect(history[stopped]!.received).toBe(true);
}

test('native CLI receives management receipts through SDK stdio before self-cancellation stops it', async () => {
  const app = await start();
  const { task, run, history } = await app.launch('cancel', 'Native managed card');
  acceptedBeforeStop(history, 'cancel_run');
  expect(history.find(event => event.type === 'connected')).toMatchObject({ runId: run.id, taskId: task.id });
  const created = history.find(event => event.tool === 'create_task')!.value!;
  const tasks = await app.json<Task[]>('/api/tasks');
  expect(tasks.filter(card => card.title === 'Native managed card')).toHaveLength(1);
  expect(tasks.find(card => card.id === created.id)).toMatchObject({ provider: 'codex', cwd: app.project, schedule: 'manual', paused: false });
  expect(tasks.find(card => card.id === created.id)!.archivedAt).not.toBeNull();
  expect((await app.json<BackupOverview>('/api/backups')).backups).toHaveLength(1);
  const finished = await app.waitFor(() => app.readRun(task.id, run.id), value => value.status === 'cancelled', 'Self-cancelled run');
  expect(finished.mock).toBe(false);
  expect(finished.sessionId).toBe(`native-${run.id}`);
}, 25_000);

test('native MCP restore acknowledges before stopping its CLI, restores data, and binds fresh agents to the reopened app', async () => {
  const app = await start();
  const { task: controller, run: restoredRun, history } = await app.launch('restore', 'Native snapshot card');
  acceptedBeforeStop(history, 'restore_backup');
  const original = history.find(event => event.tool === 'create_task')!.value!;
  const backup = history.find(event => event.tool === 'create_backup')!.value!;
  await app.waitFor(() => app.json<BackupOverview>('/api/backups'), overview => overview.selectedId === backup.id, 'MCP restoration');
  const tasks = await app.json<Task[]>('/api/tasks');
  expect(tasks.find(task => task.id === original.id)).toMatchObject({ title: 'Native snapshot card', archivedAt: null });
  expect(tasks.some(task => task.title === 'After native snapshot')).toBe(false);
  // The snapshot was taken with this run active. Restore marks it interrupted
  // and keeps its project occupied until the user acknowledges the stopped CLI.
  expect((await app.readRun(controller.id, restoredRun.id)).status).toBe('interrupted');
  await app.json(`/api/runs/${restoredRun.id}/cancel`, 'POST', { acknowledgeInterruption: true });
  // A fresh task must use the new Store and new TaskAppAccess after restore.
  const fresh = await app.launch('cancel', 'Native card after restore');
  acceptedBeforeStop(fresh.history, 'cancel_run');
  expect((await app.json<Task[]>('/api/tasks')).find(task => task.title === 'Native card after restore')!.archivedAt).not.toBeNull();
  await app.waitFor(() => app.readRun(fresh.task.id, fresh.run.id), run => run.status === 'cancelled', 'Fresh invocation after restore');
}, 30_000);
