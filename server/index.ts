import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from './store';
import { Engine } from './engine';
import { createHandler } from './http';
import { readConfig } from './config';
import { ATTACHMENT_MAX_BYTES } from '../src/lib/attachments';

const root = resolve(import.meta.dir, '..');
const { mode, port, hostname, allowedHosts, allowedOrigins, dbPath, dev, defaultCwd } = readConfig(root);
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new Store(dbPath);
if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
const lease = store.acquireLease();
const engine = new Engine(store, mode === 'mock');
const server = Bun.serve({
  hostname, port, maxRequestBodySize: ATTACHMENT_MAX_BYTES,
  fetch: createHandler(engine, { port, root, dev, allowedHosts, allowedOrigins, defaultCwd })
});
store.cleanupAttachments();
const attachmentCleanup = setInterval(() => store.cleanupAttachments(), 60_000);
engine.startScheduler();
console.log(`brigd → http://127.0.0.1:${server.port} • ${mode === 'mock' ? 'ДЕМО: реальные CLI не вызываются' : 'CLI-режим'}\nБаза: ${dbPath}`);
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  clearInterval(attachmentCleanup);
  server.stop();
  await engine.shutdown();
  store.releaseLease(lease);
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
