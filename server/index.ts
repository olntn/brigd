import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from './store';
import { Engine } from './engine';
import { createHandler } from './http';

const root = resolve(import.meta.dir, '..');
const mode = process.env.TRACKT_MODE ?? 'cli';
if (!['cli', 'mock'].includes(mode)) throw new Error('TRACKT_MODE должен быть cli или mock');
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть 1024–65535');
const hostname = process.env.TRACKT_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(hostname)) throw new Error('TRACKT_HOST должен быть 127.0.0.1 или 0.0.0.0');
const allowedHosts = process.env.TRACKT_ALLOWED_HOSTS?.split(',').map(v => v.trim());
const allowedOrigins = process.env.TRACKT_ALLOWED_ORIGINS?.split(',').map(v => v.trim());
if (hostname === '0.0.0.0' && (!allowedHosts?.length || !allowedOrigins?.length)) throw new Error('Для контейнера укажите TRACKT_ALLOWED_HOSTS и TRACKT_ALLOWED_ORIGINS явно. Публикуйте порт только на loopback хоста.');
for (const host of allowedHosts ?? []) {
  const url = new URL(`http://${host}`);
  if (!host || host.includes('*') || url.host !== host || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Недопустимый TRACKT_ALLOWED_HOSTS');
}
for (const origin of allowedOrigins ?? []) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || origin.includes('*')) throw new Error('Недопустимый TRACKT_ALLOWED_ORIGINS');
}
const dbPath = resolve(root, process.env.TRACKT_DB ?? (mode === 'mock' ? 'data/demo.sqlite' : 'data/trackt.sqlite'));
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new Store(dbPath);
if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
const lease = store.acquireLease();
const engine = new Engine(store, mode === 'mock');
const server = Bun.serve({
  hostname, port, maxRequestBodySize: 32_768,
  fetch: createHandler(engine, { port, root, dev: process.env.TRACKT_DEV === '1', allowedHosts, allowedOrigins, defaultCwd: process.env.TRACKT_DEFAULT_CWD })
});
engine.startScheduler();
console.log(`Trackt → http://127.0.0.1:${server.port} • ${mode === 'mock' ? 'ДЕМО: реальные CLI не вызываются' : 'CLI-режим'}\nБаза: ${dbPath}`);
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  server.stop();
  await engine.shutdown();
  store.releaseLease(lease);
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
