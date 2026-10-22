import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from './store';
import { Engine } from './engine';
import { createHandler, type HttpOptions } from './http';
import { readConfig } from './config';
import { ATTACHMENT_MAX_BYTES } from '../src/lib/attachments';
import { GitWorkspaces } from './workspaces';
import { acquireServerStartupLock, assertDatabaseIdle } from './startup-lock';
import { BACKUP_MAX_BYTES, BackupManager } from './backups';
import { BackupAutoUpdater } from './backup-auto-update';
import { restoreBackup } from './backup-restore';
import { AppError } from './errors';
import type { AppAccess } from './task-mcp-app';
import { createMcpHandler } from './mcp';

const root = resolve(import.meta.dir, '..');
const { mode, cliAccess, port, hostname, allowedHosts, allowedOrigins, dbPath, dev, defaultCwd, workspacesDir, maxParallel, maxPerRepository, integrationChecks, autoReconcile, cliHome, updateBackupDir, mcpToken } = readConfig(root);
// The external credential belongs to this server, not its task agents or checks.
delete process.env.BRIGD_MCP_TOKEN;
delete process.env.TRACKT_MCP_TOKEN;
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const managed = process.env.BRIGD_MANAGED_START === '1';
if (managed && (!process.send || !process.env.BRIGD_STARTUP_TOKEN)) throw new Error('Управляемый запуск brigd требует скрипта запуска и IPC.');
const startupLock = acquireServerStartupLock(dbPath);
assertDatabaseIdle(dbPath);
let store = new Store(dbPath);
let storeOpen = true;
if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
let lease = store.acquireLease();
const createEngine = (database: Store) => new Engine(database, mode === 'mock', undefined, undefined, { cliAccess, maxParallel, maxPerRepository, integrationChecks, autoReconcile, ...(mode === 'cli' ? { workspaces: new GitWorkspaces(workspacesDir, () => database.getIntegrationChecks() ?? integrationChecks) } : {}) });
let engine = createEngine(store);
const backups = new BackupManager({ dbPath, updateBackupDir });
const backupAutoUpdater = new BackupAutoUpdater(backups, () => store.db, error => {
  console.error('[brigd] Не удалось автоматически обновить выбранный бэкап:', error instanceof Error ? error.message : error);
});
let engineStopped = false;
let active = false;
let requests = 0;
let restoring = false;
let restoreInFlight: Promise<void> | null = null;
const internalHost = allowedHosts?.[0] ?? `127.0.0.1:${port}`;
const internalOrigin = allowedOrigins?.[0] ?? `http://${internalHost}`;
const createAppHandler = (): ReturnType<typeof createHandler> => {
  const owner = engine;
  const options: HttpOptions = { port, root, dev, allowedHosts, allowedOrigins, defaultCwd, cliHome, updateBackupDir, backupManager: backups, startedAt: Date.now(),
  async restoreBackup(backups, id) {
    if (restoring || exiting) throw new AppError('Дождитесь завершения восстановления.', 409);
    restoring = true;
    const operation = restoreBackup(backups, id, {
      dbPath,
      async pause() {
        active = false;
        backupAutoUpdater.stop();
        clearInterval(attachmentCleanup);
        // Let uploads and writes already accepted by the old handler finish.
        // The restoring request itself remains counted until its response returns.
        const deadline = Date.now() + 15_000;
        while (requests > 1) {
          if (exiting) throw new AppError('Сервис останавливается.', 503);
          if (Date.now() > deadline) throw new AppError('Дождитесь завершения других запросов и повторите восстановление.', 409);
          await Bun.sleep(10);
        }
        try { await engine.shutdown(); }
        finally { engineStopped = true; }
      },
      close() {
        if (!storeOpen) return;
        store.releaseLease(lease);
        store.close();
        storeOpen = false;
      },
      open() {
        const database = new Store(dbPath);
        try {
          const nextLease = database.acquireLease();
          const nextEngine = createEngine(database);
          store = database;
          storeOpen = true;
          lease = nextLease;
          engine = nextEngine;
          engineStopped = false;
          handler = createAppHandler();
        } catch (error) { database.close(); throw error; }
      },
      resume() {
        // A failed safety snapshot can leave the original Store open with an
        // Engine already stopped. Give that Store a working scheduler again.
        if (engineStopped && storeOpen) {
          engine = createEngine(store);
          engineStopped = false;
          handler = createAppHandler();
        }
        activate();
      },
    });
    restoreInFlight = operation;
    try { await operation; }
    finally { restoring = false; restoreInFlight = null; }
  },
  };
  const appHandler = createHandler(owner, options);
  const assertAvailable = () => {
    if (restoring) throw new AppError('Дождитесь завершения восстановления.', 409);
    if (exiting || !active || owner !== engine) throw new AppError('Сервис недоступен для этого вызова агента.', 503);
  };
  const request = async (method: string, path: string, value: Record<string, unknown> | undefined, invocation: Parameters<AppAccess['request']>[3]) => {
    const authorize = () => {
      assertAvailable();
      if (!invocation.isCurrent()) throw new AppError('Вызов агента уже завершён или отменён.', 409);
    };
    authorize();
    const req = new Request(`${internalOrigin}${path}`, { method,
      headers: { Host: internalHost, Origin: internalOrigin, 'Content-Type': 'application/json' },
      ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(value ?? {}) } : {}),
    });
    const scopedHandler = createHandler(owner, { ...options, authorizeMutation: authorize });
    requests++;
    try { return await scopedHandler(req); }
    finally { requests--; }
  };
  const access: AppAccess = { async request(method, path, value, invocation) {
    assertAvailable();
    if (!invocation.isCurrent()) throw new AppError('Вызов агента уже завершён или отменён.', 409);
    const restore = method === 'POST' ? path.match(/^\/api\/backups\/([^/]+)\/select$/) : null;
    const cancellingSelf = invocation.runId !== undefined && method === 'POST' && path === `/api/runs/${invocation.runId}/cancel`;
    if (restore || cancellingSelf) {
      // Stopping this invocation inline would close its private socket before
      // the receipt and can make restore wait for its own unanswered MCP call.
      if (restore) {
        if (Object.keys(value ?? {}).length) throw new AppError('Ожидается пустой JSON-объект');
        let id: string;
        try { id = decodeURIComponent(restore[1]!); }
        catch { throw new AppError('Бэкап не найден', 404); }
        backups.validate(id);
      } else {
        const run = owner.store.getRun(invocation.runId!);
        if (run.taskId !== invocation.taskId || !['running', 'preparing', 'queued'].includes(run.status)) {
          throw new AppError('Текущий запуск уже завершён или отменён.', 409);
        }
      }
      let dispatched = false;
      return { response: Response.json({ accepted: true, status: 'queued', action: restore ? 'restore_backup' : 'cancel_run' }, { status: 202 }),
        afterResponse() {
          if (dispatched) return;
          dispatched = true;
          void request(method, path, value, invocation).then(async response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
          }).catch(error => {
            console.error(`[brigd] Отложенная операция MCP ${method} ${path} не выполнена:`, error instanceof Error ? error.message : error);
          });
        },
      };
    }
    return request(method, path, value, invocation);
  } };
  owner.setTaskAppAccess(access);
  if (mcpToken) options.mcp = createMcpHandler({ token: mcpToken, store: owner.store, access,
    defaultCwd: () => owner.store.getDefaultCwd() ?? defaultCwd ?? process.cwd(),
    isCurrent: () => active && !restoring && !exiting && owner === engine,
  });
  return appHandler;
};
let handler = createAppHandler();
const server = Bun.serve({
  hostname, port, maxRequestBodySize: Math.max(ATTACHMENT_MAX_BYTES, BACKUP_MAX_BYTES),
  async fetch(req) {
    if (!active) return new Response(restoring ? 'brigd восстанавливает бэкап' : 'brigd запускается', { status: 503 });
    requests++;
    try { return await handler(req); }
    finally { requests--; }
  },
});
let attachmentCleanup: ReturnType<typeof setInterval> | undefined;
function activate() {
  if (active || exiting) return;
  store.cleanupAttachments();
  engine.startScheduler();
  backupAutoUpdater.start();
  attachmentCleanup = setInterval(() => store.cleanupAttachments(), 60_000);
  active = true;
  console.log(`brigd → http://127.0.0.1:${server.port} • ${mode === 'mock' ? 'ДЕМО: реальные CLI не вызываются' : 'CLI-режим'}\nБаза: ${dbPath}`);
  if (managed) process.send?.({ type: 'brigd:active' });
}
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  const wasActive = active;
  const wasRestoring = restoring;
  active = false;
  backupAutoUpdater.stop();
  clearInterval(attachmentCleanup);
  server.stop();
  // A paused candidate has not started work. Keep the pre-update DB state intact.
  if (restoreInFlight) await restoreInFlight.catch(() => {});
  if (storeOpen) {
    if (wasActive || wasRestoring) await engine.shutdown();
    store.releaseLease(lease);
    if (wasActive || wasRestoring) backupAutoUpdater.flush();
    store.close();
  }
  startupLock.release();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
if (managed) {
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'brigd:activate') activate();
  });
  process.on('disconnect', () => void shutdown());
  process.send?.({ type: 'brigd:ready' });
} else activate();
