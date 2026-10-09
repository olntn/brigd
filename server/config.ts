import { resolve } from 'node:path';

type Environment = Record<string, string | undefined>;

// New installations may use BRIGD_; old launch commands and container defaults
// keep working. An explicitly set new value wins, including invalid/empty values
// so configuration mistakes still fail validation rather than silently falling back.
export function readConfig(root: string, env: Environment = process.env) {
  const setting = (name: string) => env[`BRIGD_${name}`] ?? env[`TRACKT_${name}`];
  const mode = setting('MODE') ?? 'cli';
  if (!['cli', 'mock'].includes(mode)) throw new Error('BRIGD_MODE / TRACKT_MODE должен быть cli или mock');
  const port = Number(env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть 1024–65535');
  const hostname = setting('HOST') ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(hostname)) throw new Error('BRIGD_HOST / TRACKT_HOST должен быть 127.0.0.1 или 0.0.0.0');
  const allowedHosts = setting('ALLOWED_HOSTS')?.split(',').map(v => v.trim());
  const allowedOrigins = setting('ALLOWED_ORIGINS')?.split(',').map(v => v.trim());
  if (hostname === '0.0.0.0' && (!allowedHosts?.length || !allowedOrigins?.length)) throw new Error('Для контейнера укажите BRIGD_ALLOWED_HOSTS и BRIGD_ALLOWED_ORIGINS (или TRACKT_ аналоги) явно. Публикуйте порт только на loopback хоста.');
  for (const host of allowedHosts ?? []) {
    const url = new URL(`http://${host}`);
    if (!host || host.includes('*') || url.host !== host || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Недопустимый BRIGD_ALLOWED_HOSTS / TRACKT_ALLOWED_HOSTS');
  }
  for (const origin of allowedOrigins ?? []) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || origin.includes('*')) throw new Error('Недопустимый BRIGD_ALLOWED_ORIGINS / TRACKT_ALLOWED_ORIGINS');
  }
  // Do not rename the default database: existing tasks must remain visible.
  const dbPath = resolve(root, setting('DB') ?? (mode === 'mock' ? 'data/demo.sqlite' : 'data/trackt.sqlite'));
  return { mode, port, hostname, allowedHosts, allowedOrigins, dbPath, dev: setting('DEV') === '1', defaultCwd: setting('DEFAULT_CWD') };
}
