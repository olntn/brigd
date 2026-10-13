import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from './store';
import { Engine } from './engine';
import { createHandler } from './http';
import { readConfig } from './config';
import { ATTACHMENT_MAX_BYTES } from '../src/lib/attachments';
import { GitWorkspaces } from './workspaces';
import { acquireServerStartupLock, assertDatabaseIdle } from './startup-lock';

const root = resolve(import.meta.dir, '..');
const { mode, port, hostname, allowedHosts, allowedOrigins, dbPath, dev, defaultCwd, workspacesDir, maxParallel, maxPerRepository, integrationChecks, autoReconcile, cliHome } = readConfig(root);
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const managed = process.env.BRIGD_MANAGED_START === '1';
if (managed && (!process.send || !process.env.BRIGD_STARTUP_TOKEN)) throw new Error('Управляемый запуск brigd требует скрипта запуска и IPC.');
const startupLock = acquireServerStartupLock(dbPath);
assertDatabaseIdle(dbPath);
const store = new Store(dbPath);
if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
const lease = store.acquireLease();
const engine = new Engine(store, mode === 'mock', undefined, undefined, { maxParallel, maxPerRepository, integrationChecks, autoReconcile, ...(mode === 'cli' ? { workspaces: new GitWorkspaces(workspacesDir, () => store.getIntegrationChecks() ?? integrationChecks) } : {}) });
let active = false;
const handler = createHandler(engine, { port, root, dev, allowedHosts, allowedOrigins, defaultCwd, cliHome });
const server = Bun.serve({
  hostname, port, maxRequestBodySize: ATTACHMENT_MAX_BYTES,
  fetch: req => active ? handler(req) : new Response('brigd запускается', { status: 503 })
});
let attachmentCleanup: ReturnType<typeof setInterval> | undefined;
function activate() {
  if (active || exiting) return;
  store.cleanupAttachments();
  engine.startScheduler();
  attachmentCleanup = setInterval(() => store.cleanupAttachments(), 60_000);
  active = true;
  console.log(`brigd → http://127.0.0.1:${server.port} • ${mode === 'mock' ? 'ДЕМО: реальные CLI не вызываются' : 'CLI-режим'}\nБаза: ${dbPath}`);
  if (managed) process.send?.({ type: 'brigd:active' });
}
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  clearInterval(attachmentCleanup);
  server.stop();
  // A paused candidate has not started work. Keep the pre-update DB state intact.
  if (active) await engine.shutdown();
  store.releaseLease(lease);
  store.close();
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
