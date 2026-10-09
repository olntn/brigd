import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real HTTP + real service processes, but strictly mock agents and a disposable DB.
const directory = mkdtempSync(join(tmpdir(), 'brigd-smoke-'));
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port!;
reservation.stop(true);
const origin = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof Bun.spawn> | undefined;
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await read(); if (ready(result)) return result; } catch {}
    await Bun.sleep(40);
  }
  throw new Error('Smoke timeout');
}
async function start(prefix: 'TRACKT' | 'BRIGD' = 'BRIGD') {
  // Exercise both launch prefixes against the same database. Never let inherited
  // configuration turn a smoke run into a real CLI call or select user data.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TRACKT_') && !key.startsWith('BRIGD_')));
  Object.assign(env, { PORT: String(port), [`${prefix}_MODE`]: 'mock', [`${prefix}_DB`]: join(directory, 'smoke.sqlite'), [`${prefix}_HOST`]: '127.0.0.1', [`${prefix}_ALLOWED_HOSTS`]: `127.0.0.1:${port}`, [`${prefix}_ALLOWED_ORIGINS`]: origin, [`${prefix}_DEV`]: '0' });
  child = Bun.spawn([process.execPath, 'server/index.ts'], { env, stdout: 'inherit', stderr: 'inherit' });
  await poll(async () => (await fetch(origin + '/api/info')).json(), value => value.mode === 'mock');
}
async function stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') { child?.kill(signal); await child?.exited; child = undefined; }
async function request(path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, method === 'GET' ? {} : { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const create = (title: string, workerId: string | null = null) => request('/api/tasks', { workerId, title, instruction: '[ask] Mock smoke only.', provider: 'codex', cwd: directory, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false });
try {
  await start('TRACKT');
  assert((await fetch(origin)).status === 200, 'Production UI must be built');
  const avatarBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO8k2LEwMDAxMDAwMDAAAASLAF2NoNKPAAAAABJRU5ErkJggg==', 'base64');
  const upload = await fetch(origin + '/api/avatars', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'image/png' }, body: avatarBytes });
  assert(upload.status === 201, 'Avatar upload failed');
  const { avatarUrl } = await upload.json();
  const worker = await request('/api/workers', { name: 'Smoke reviewer', provider: 'codex', effort: 'high', communicationStyle: 'Кратко и по-русски.', avatarUrl });
  const task = await create('Waiting state survives restart', worker.id);
  await request(`/api/tasks/${task.id}/run`, {});
  const waiting = await poll(() => request(`/api/tasks/${task.id}`), value => value.task.status === 'waiting_input');
  const session = waiting.runs[0].sessionId;
  assert(waiting.runs[0].worker?.effort === 'high' && waiting.runs[0].worker?.avatarUrl === avatarUrl, 'Worker snapshot was not captured');
  await request(`/api/workers/${worker.id}`, { name: 'Edited reviewer', provider: 'claude', effort: 'max', communicationStyle: 'Новый стиль', avatarUrl: null }, 'PATCH');
  await request(`/api/workers/${worker.id}`, {}, 'DELETE');
  await stop();
  await start();
  const restored = await request(`/api/tasks/${task.id}`);
  assert(restored.task.status === 'waiting_input' && restored.runs.length === 1 && restored.runs[0].sessionId === session, 'Waiting/session persistence failed');
  assert(restored.task.worker.archived && restored.task.provider === 'claude', 'Archived worker assignment did not persist');
  assert(restored.runs[0].provider === 'codex' && restored.runs[0].worker.name === 'Smoke reviewer' && restored.runs[0].worker.communicationStyle === 'Кратко и по-русски.', 'Editing profile changed an existing session');
  const persistedAvatar = await fetch(origin + avatarUrl);
  assert(persistedAvatar.ok && Buffer.from(await persistedAvatar.arrayBuffer()).equals(avatarBytes), 'Snapshot avatar bytes did not persist');
  await request(`/api/runs/${restored.runs[0].id}/resume`, { answer: 'Keep the same test session.' });
  const done = await poll(() => request(`/api/tasks/${task.id}`), value => value.task.status === 'completed');
  assert(done.runs[0].sessionId === session && done.runs[0].turn === 2, 'Resume did not use exact session');
  assert(done.runs[0].worker.effort === 'high' && done.runs[0].worker.avatarUrl === avatarUrl, 'Resume lost worker snapshot');
  const crashed = await create('Crash does not replay work');
  const active = await request(`/api/tasks/${crashed.id}/run`, {});
  await poll(() => request(`/api/tasks/${crashed.id}`), value => !!value.runs[0].sessionId && value.task.status === 'running');
  await stop('SIGKILL');
  await start();
  const interrupted = await request(`/api/tasks/${crashed.id}`);
  assert(interrupted.task.status === 'interrupted' && interrupted.runs.length === 1, 'Crash was replayed instead of reconciled');
  const unconfirmed = await fetch(origin + `/api/runs/${active.id}/resume`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'Resume' }) });
  assert(unconfirmed.status === 409, 'Interrupted resume needs explicit stopped-process confirmation');
  await request(`/api/runs/${active.id}/resume`, { answer: 'Mock process is stopped; continue.', acknowledgeInterruption: true });
  const recovered = await poll(() => request(`/api/tasks/${crashed.id}`), value => value.task.status === 'completed');
  assert(recovered.runs[0].sessionId === interrupted.runs[0].sessionId, 'Crash recovery changed session');
  console.log('PASS: production HTTP, legacy TRACKT_ → BRIGD_ restart, mock clarification, exact session resume, worker/avatar persistence and frozen profiles, graceful restart, SIGKILL recovery, no replay.');
} finally {
  await stop();
  rmSync(directory, { recursive: true, force: true });
}
