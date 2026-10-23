/** Local agent client. Uses the same API as the UI; no MCP setup or direct SQLite access. */
import { isTaskPriority, TASK_PRIORITIES, TASK_PRIORITY_LABELS } from '../src/lib/priority';

type Worker = { id: string; name: string; provider: 'codex' | 'claude'; archived: boolean };
type Info = { mode: 'cli' | 'mock'; cwd: string; scheduler: string };

export function createBrigdClient(env: Record<string, string | undefined> = process.env) {
  const setting = (name: string) => env[`BRIGD_${name}`] ?? env[`TRACKT_${name}`];
  const port = Number(env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть 1024–65535.');
  const base = `http://127.0.0.1:${port}`;
  const host = setting('ALLOWED_HOSTS')?.split(',')[0]?.trim() || `127.0.0.1:${port}`;
  const origin = setting('ALLOWED_ORIGINS')?.split(',')[0]?.trim() || base;
  async function request(path: string, body?: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error(body
        ? 'Ответ на создание задачи не получен. Проверьте список задач перед повтором: карточка могла сохраниться.'
        : `brigd недоступен из этой среды по адресу ${base}. Нужен доступ к уже запущенному приложению; настройка MCP не требуется.`);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new Error(`brigd вернул неожиданный ответ (HTTP ${response.status}).${body ? ' Проверьте список задач перед повтором.' : ''}`); }
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return value;
  }
  async function info(): Promise<Info> {
    const value = await request('/api/info') as Partial<Info> | null;
    if (!value || !['cli', 'mock'].includes(value.mode ?? '') || typeof value.cwd !== 'string' || value.scheduler !== 'running') {
      throw new Error('По локальному адресу не найден работающий brigd.');
    }
    return value as Info;
  }
  async function workers(): Promise<Worker[]> {
    const value = await request('/api/workers');
    if (!Array.isArray(value) || value.some(worker => !worker || typeof worker.id !== 'string' || typeof worker.name !== 'string' ||
        !['codex', 'claude'].includes(worker.provider) || typeof worker.archived !== 'boolean')) throw new Error('Не удалось прочитать сотрудников brigd.');
    return value;
  }
  return {
    info,
    workers,
    tasks: () => request('/api/tasks'),
    async createTask(raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ожидается JSON-объект задачи.');
      const args = raw as Record<string, unknown>;
      if (Object.keys(args).some(key => !['worker', 'title', 'instruction', 'cwd', 'priority', 'dependsOn'].includes(key))) throw new Error('Допустимы только worker, title, instruction, cwd, priority, dependsOn.');
      for (const name of ['worker', 'title', 'instruction']) {
        if (typeof args[name] !== 'string' || !(args[name] as string).trim()) throw new Error(`Нужно поле ${name}.`);
      }
      if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd.trim())) throw new Error('cwd должен быть путём к рабочей папке.');
      if (args.priority !== undefined && !isTaskPriority(args.priority)) {
        throw new Error(`priority: ${TASK_PRIORITIES.map(priority => `${priority} (${TASK_PRIORITY_LABELS[priority]})`).join(', ')}.`);
      }
      if (args.dependsOn !== undefined && (!Array.isArray(args.dependsOn) || args.dependsOn.length > 10 ||
          args.dependsOn.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) || new Set(args.dependsOn).size !== args.dependsOn.length)) {
        throw new Error('dependsOn: укажите массив до 10 уникальных ID задач.');
      }
      const app = await info();
      const all = await workers(), selected = (args.worker as string).trim();
      const active = all.filter(worker => !worker.archived);
      const byId = active.find(worker => worker.id === selected);
      const matches = byId ? [byId] : active.filter(worker => worker.name.toLocaleLowerCase() === selected.toLocaleLowerCase());
      if (!matches.length) throw new Error(`Сотрудник «${selected}» не найден среди активных. Прочитайте workers; нового сотрудника автоматически создавать не нужно.`);
      if (matches.length !== 1) throw new Error(`Имя «${selected}» неоднозначно. Укажите ID: ${matches.map(worker => worker.id).join(', ')}.`);
      const worker = matches[0]!;
      // Always create a manual card. Scheduling or starting work is a separate user intent.
      return request('/api/tasks', { title: args.title, instruction: args.instruction, workerId: worker.id, provider: worker.provider,
        cwd: args.cwd ?? app.cwd, ...(args.dependsOn !== undefined ? { dependsOnTaskIds: args.dependsOn } : {}), ...(args.priority !== undefined ? { priority: args.priority } : {}), schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false });
    },
  };
}

if (import.meta.main) {
  try {
    const command = process.argv[2];
    if (!command || command === '--help') {
      console.log('brigd agent client: info | workers | tasks | create-task\ncreate-task читает JSON из stdin: {"worker":"имя или ID","title":"Название","instruction":"Задание","cwd":"необязательная рабочая папка","priority":"необязательно: critical, high, normal или low","dependsOn":["ID задачи-предшественницы"]}');
    } else {
      const client = createBrigdClient();
      let result: unknown;
      if (command === 'info') result = await client.info();
      else if (command === 'workers') result = await client.workers();
      else if (command === 'tasks') result = await client.tasks();
      else if (command === 'create-task') result = await client.createTask(JSON.parse(await Bun.stdin.text()));
      else throw new Error('Неизвестная команда. Доступны info, workers, tasks, create-task.');
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Не удалось выполнить команду brigd.');
    process.exitCode = 1;
  }
}
