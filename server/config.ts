import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseIntegrationChecks } from '../src/lib/integration-checks';
import type { CliAccessMode } from '../src/lib/types';

type Environment = Record<string, string | undefined>;

// New installations may use BRIGD_; old launch commands and container defaults
// keep working. An explicitly set new value wins, including invalid/empty values
// so configuration mistakes still fail validation rather than silently falling back.
export function readConfig(root: string, env: Environment = process.env) {
  const setting = (name: string) => env[`BRIGD_${name}`] ?? env[`TRACKT_${name}`];
  const mode = setting('MODE') ?? 'cli';
  if (!['cli', 'mock'].includes(mode)) throw new Error('BRIGD_MODE / TRACKT_MODE должен быть cli или mock');
  const cliAccess = setting('CLI_ACCESS') ?? 'full';
  if (cliAccess !== 'standard' && cliAccess !== 'full') throw new Error('BRIGD_CLI_ACCESS / TRACKT_CLI_ACCESS должен быть standard или full');
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
  const workspacesDir = resolve(root, setting('WORKSPACES_DIR') ?? resolve(dirname(dbPath), 'workspaces'));
  const maxParallel = Number(setting('MAX_PARALLEL') ?? 4);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 32) throw new Error('BRIGD_MAX_PARALLEL / TRACKT_MAX_PARALLEL должен быть 1–32');
  const maxPerRepository = Number(setting('MAX_PER_REPOSITORY') ?? 1);
  if (!Number.isInteger(maxPerRepository) || maxPerRepository < 1 || maxPerRepository > 32) throw new Error('BRIGD_MAX_PER_REPOSITORY / TRACKT_MAX_PER_REPOSITORY должен быть 1–32');
  let integrationChecks: string[][] | undefined;
  if (setting('INTEGRATION_CHECKS') !== undefined) {
    integrationChecks = parseIntegrationChecks(setting('INTEGRATION_CHECKS')!);
  }
  // Where the CLI setup buttons look for ~/.claude and ~/.codex; tests point it at a scratch folder.
  const cliHome = resolve(root, setting('CLI_HOME') ?? homedir());
  const updateBackupDir = resolve(root, setting('UPDATE_BACKUP_DIR') ?? '.brigd-updates/backup');
  const integrator = setting('INTEGRATOR') ?? 'auto';
  if (!['auto', 'manual'].includes(integrator)) throw new Error('BRIGD_INTEGRATOR должен быть auto или manual');
  return { mode, cliAccess: cliAccess as CliAccessMode, port, hostname, allowedHosts, allowedOrigins, dbPath, workspacesDir, maxParallel, maxPerRepository, integrationChecks, autoReconcile: integrator === 'auto', dev: setting('DEV') === '1', defaultCwd: setting('DEFAULT_CWD'), cliHome, updateBackupDir };
}
