import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliConfigReport, CliConfigStatus } from '../src/lib/types';
import { AppError } from './errors';

/**
 * Allow rules that unattended brigd runs of Claude Code need: file edits inside the worktree, the
 * project's own check commands and read-only Git. Missing rules are appended; nothing is ever removed.
 * brigd starts Claude with `--permission-mode default`, so only these rules decide what runs without a prompt.
 */
export const CLAUDE_REQUIRED_RULES = [
  'Edit', 'Write',
  'Bash(bun install:*)', 'Bash(bun test:*)', 'Bash(bun run check:*)', 'Bash(bun run verify:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
] as const;

const claudeSettingsPath = (home: string) => join(home, '.claude', 'settings.json');
const codexConfigPath = (home: string) => join(home, '.codex', 'config.toml');
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Returns the parsed object, null for a missing file, and throws for unreadable or non-object JSON. */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ожидается JSON-объект');
  return parsed as Record<string, unknown>;
}
function allowList(data: Record<string, unknown> | null): string[] {
  const permissions = data?.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return [];
  const allow = (permissions as Record<string, unknown>).allow;
  return Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === 'string') : [];
}

export function claudeStatus(home = homedir()): CliConfigStatus {
  const path = claudeSettingsPath(home);
  const base = { provider: 'claude' as const, path, exists: existsSync(path), login: null, notes: ['brigd запускает Claude Code в режиме разрешений default: без этих правил правка файла или команда завершает запуск блокировкой.'] };
  try {
    const allow = allowList(readJsonObject(path));
    const missing = CLAUDE_REQUIRED_RULES.filter(rule => !allow.includes(rule));
    return { ...base, ready: missing.length === 0, missing, present: CLAUDE_REQUIRED_RULES.filter(rule => allow.includes(rule)), error: null };
  } catch (error) {
    return { ...base, ready: false, missing: [...CLAUDE_REQUIRED_RULES], present: [], error: `Файл не прочитан: ${describe(error)}. Исправьте его вручную, brigd не перезаписывает непонятный файл.` };
  }
}

/** Appends the missing allow rules, keeping every other key; the previous file is copied to settings.json.bak first. */
export function configureClaude(home = homedir()): CliConfigReport {
  const path = claudeSettingsPath(home);
  let data: Record<string, unknown>;
  try { data = readJsonObject(path) ?? {}; }
  catch (error) { throw new AppError(`${path}: ${describe(error)}. Исправьте файл вручную, brigd не перезаписывает непонятный файл.`, 409); }
  const allow = allowList(data);
  const added = CLAUDE_REQUIRED_RULES.filter(rule => !allow.includes(rule));
  let backup: string | null = null;
  if (added.length) {
    const permissions = data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions) ? data.permissions as Record<string, unknown> : {};
    const current = Array.isArray(permissions.allow) ? permissions.allow : [];
    data.permissions = { ...permissions, allow: [...current, ...added] };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) { backup = `${path}.bak`; copyFileSync(path, backup); }
    // Write whole, then rename: a crash mid-write cannot leave the CLI with a truncated file.
    const temp = `${path}.brigd-tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, path);
  }
  return { status: claudeStatus(home), added: [...added], backup };
}

/**
 * Codex settings mirrored into config.toml: the same sandbox, approval policy and network that brigd passes on the
 * command line, so an interactive codex in the same folders behaves like brigd runs. Keys are added or corrected in place.
 */
export const CODEX_REQUIRED_SETTINGS = [
  { table: null, key: 'sandbox_mode', literal: '"workspace-write"', expected: 'workspace-write' },
  { table: null, key: 'approval_policy', literal: '"on-request"', expected: 'on-request' },
  { table: 'sandbox_workspace_write', key: 'network_access', literal: 'true', expected: true },
] as const;
type CodexSetting = (typeof CODEX_REQUIRED_SETTINGS)[number];
const settingLabel = (setting: CodexSetting) => `${setting.table ? `${setting.table}.` : ''}${setting.key} = ${setting.literal}`;
const HEADER = /^\s*\[\[?([^\[\]]+)\]\]?\s*(?:#.*)?$/;
const isHeader = (line: string) => HEADER.test(line);
const headerName = (line: string) => HEADER.exec(line)?.[1]?.trim() ?? null;

function parseToml(text: string): Record<string, unknown> {
  return text.trim() ? Bun.TOML.parse(text) as Record<string, unknown> : {};
}
function codexMissing(data: Record<string, unknown>): CodexSetting[] {
  return CODEX_REQUIRED_SETTINGS.filter(setting => {
    const scope = setting.table ? data[setting.table] : data;
    return !scope || typeof scope !== 'object' || (scope as Record<string, unknown>)[setting.key] !== setting.expected;
  });
}
/** Text-level edit that keeps comments, order and every other key: a value is replaced on its own line, a missing key joins the end of its section. */
export function applyCodexSettings(text: string, settings: readonly CodexSetting[]): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const setting of settings) {
    const assignment = `${setting.key} = ${setting.literal}`;
    let start = 0;
    let end = lines.findIndex(isHeader);
    if (end === -1) end = lines.length;
    if (setting.table) {
      const header = lines.findIndex(line => isHeader(line) && headerName(line) === setting.table);
      if (header === -1) {
        if (lines.length && lines.at(-1) !== '') lines.push('');
        lines.push(`[${setting.table}]`, assignment);
        continue;
      }
      start = header + 1;
      end = lines.findIndex((line, index) => index > header && isHeader(line));
      if (end === -1) end = lines.length;
    }
    const pattern = new RegExp(`^\\s*${setting.key}\\s*=`);
    const existing = lines.findIndex((line, index) => index >= start && index < end && pattern.test(line));
    if (existing !== -1) { lines[existing] = assignment; continue; }
    let at = end;
    while (at > start && lines[at - 1] === '') at--;
    lines.splice(at, 0, assignment);
  }
  return `${lines.join('\n')}\n`;
}

export function codexStatus(home = homedir()): CliConfigStatus {
  const path = codexConfigPath(home);
  const base = { provider: 'codex' as const, path, exists: existsSync(path), login: existsSync(join(home, '.codex', 'auth.json')),
    notes: ['brigd передаёт те же параметры флагами при каждом запуске: --sandbox workspace-write, approval_policy=on-request, сеть внутри песочницы.'] };
  try {
    const missing = codexMissing(parseToml(base.exists ? readFileSync(path, 'utf8') : ''));
    return { ...base, ready: missing.length === 0, missing: missing.map(settingLabel), present: CODEX_REQUIRED_SETTINGS.filter(setting => !missing.includes(setting)).map(settingLabel), error: null };
  } catch (error) {
    return { ...base, ready: false, missing: CODEX_REQUIRED_SETTINGS.map(settingLabel), present: [], error: `Файл не прочитан: ${describe(error)}. Исправьте его вручную, brigd не перезаписывает непонятный файл.` };
  }
}

/** Adds or corrects the mirrored settings; the previous file is copied to config.toml.bak first and the result is parsed before it replaces the file. */
export function configureCodex(home = homedir()): CliConfigReport {
  const path = codexConfigPath(home);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let missing: CodexSetting[];
  try { missing = codexMissing(parseToml(text)); }
  catch (error) { throw new AppError(`${path}: ${describe(error)}. Исправьте файл вручную, brigd не перезаписывает непонятный файл.`, 409); }
  let backup: string | null = null;
  if (missing.length) {
    const next = applyCodexSettings(text, missing);
    let check: Record<string, unknown>;
    try { check = parseToml(next); }
    catch (error) { throw new AppError(`${path}: не удалось дописать параметры (${describe(error)}). Добавьте их вручную.`, 409); }
    if (codexMissing(check).length) throw new AppError(`${path}: параметры не применились, добавьте их вручную.`, 409);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) { backup = `${path}.bak`; copyFileSync(path, backup); }
    const temp = `${path}.brigd-tmp`;
    writeFileSync(temp, next);
    renameSync(temp, path);
  }
  return { status: codexStatus(home), added: missing.map(settingLabel), backup };
}
