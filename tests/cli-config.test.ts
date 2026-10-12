import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../server/store';
import { CLAUDE_REQUIRED_RULES, claudeStatus, codexStatus, configureClaude, configureCodex } from '../server/cli-config';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'brigd-cli-home-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const settingsPath = () => join(home, '.claude', 'settings.json');
const read = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

describe('Claude Code setup button', () => {
  test('a missing file is created with exactly the required rules and no backup', () => {
    expect(claudeStatus(home)).toMatchObject({ provider: 'claude', path: settingsPath(), exists: false, ready: false, missing: [...CLAUDE_REQUIRED_RULES], present: [], error: null });
    const report = configureClaude(home);
    expect(report).toMatchObject({ added: [...CLAUDE_REQUIRED_RULES], backup: null, status: { ready: true, exists: true, missing: [] } });
    expect(read()).toEqual({ permissions: { allow: [...CLAUDE_REQUIRED_RULES] } });
    expect(readFileSync(settingsPath(), 'utf8').endsWith('\n')).toBe(true);
  });

  test('existing keys, unknown rules and the deny list survive; only missing rules are appended after a backup', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const original = { model: 'fable', theme: 'dark', permissions: { allow: ['Bash(bun test:*)', 'Read(~/notes/**)'], deny: ['Read(./.env)'], defaultMode: 'plan' } };
    writeFileSync(settingsPath(), JSON.stringify(original));
    expect(claudeStatus(home)).toMatchObject({ exists: true, ready: false, present: ['Bash(bun test:*)'] });
    const report = configureClaude(home);
    expect(report.added).toEqual(CLAUDE_REQUIRED_RULES.filter(rule => rule !== 'Bash(bun test:*)'));
    expect(report.backup).toBe(`${settingsPath()}.bak`);
    expect(JSON.parse(readFileSync(report.backup!, 'utf8'))).toEqual(original);
    expect(read()).toEqual({ model: 'fable', theme: 'dark', permissions: { allow: ['Bash(bun test:*)', 'Read(~/notes/**)', ...report.added], deny: ['Read(./.env)'], defaultMode: 'plan' } });
    // A second press changes nothing and overwrites no backup.
    writeFileSync(report.backup!, 'marker');
    expect(configureClaude(home)).toMatchObject({ added: [], backup: null, status: { ready: true } });
    expect(readFileSync(report.backup!, 'utf8')).toBe('marker');
  });

  test('an unreadable or non-object file is reported and never overwritten', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), '{ "permissions": ');
    expect(claudeStatus(home)).toMatchObject({ exists: true, ready: false, missing: [...CLAUDE_REQUIRED_RULES] });
    expect(claudeStatus(home).error).toContain('Файл не прочитан');
    expect(() => configureClaude(home)).toThrow(AppError);
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ "permissions": ');
    writeFileSync(settingsPath(), '[1, 2]');
    expect(() => configureClaude(home)).toThrow('JSON-объект');
    expect(existsSync(`${settingsPath()}.bak`)).toBe(false);
  });
});

describe('Codex setup button', () => {
  const configPath = () => join(home, '.codex', 'config.toml');
  const parse = () => Bun.TOML.parse(readFileSync(configPath(), 'utf8')) as Record<string, any>;

  test('a missing file is created with the mirrored sandbox settings; login is reported separately', () => {
    const before = codexStatus(home);
    expect(before).toMatchObject({ provider: 'codex', path: configPath(), exists: false, ready: false, login: false, error: null });
    expect(before.missing).toEqual(['sandbox_mode = "workspace-write"', 'approval_policy = "on-request"', 'sandbox_workspace_write.network_access = true']);
    const report = configureCodex(home);
    expect(report).toMatchObject({ backup: null, status: { exists: true, ready: true, login: false, missing: [] } });
    expect(report.added).toHaveLength(3);
    expect(parse()).toEqual({ sandbox_mode: 'workspace-write', approval_policy: 'on-request', sandbox_workspace_write: { network_access: true } });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    expect(codexStatus(home).login).toBe(true);
    expect(configureCodex(home)).toMatchObject({ added: [], backup: null });
  });

  test('existing keys, tables and comments survive; top-level keys land before the first table and a backup is kept', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = '# my config\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "ultra"\n\n[projects."/srv/app"]\ntrust_level = "trusted"\n';
    writeFileSync(configPath(), original);
    const report = configureCodex(home);
    expect(report.added).toHaveLength(3);
    expect(report.backup).toBe(`${configPath()}.bak`);
    expect(readFileSync(report.backup!, 'utf8')).toBe(original);
    const text = readFileSync(configPath(), 'utf8');
    expect(text.indexOf('approval_policy = "on-request"')).toBeLessThan(text.indexOf('[projects."/srv/app"]'));
    expect(text.startsWith('# my config\nmodel = "gpt-6.1-sol"\n')).toBe(true);
    expect(parse()).toMatchObject({ model: 'gpt-6.1-sol', model_reasoning_effort: 'ultra', sandbox_mode: 'workspace-write', approval_policy: 'on-request',
      projects: { '/srv/app': { trust_level: 'trusted' } }, sandbox_workspace_write: { network_access: true } });
  });

  test('wrong values are corrected on their own lines inside the right table, other keys stay', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath(), 'sandbox_mode = "read-only"\napproval_policy = "never"\n\n[sandbox_workspace_write]\nwritable_roots = ["/x"]\nnetwork_access = false\n\n[mcp_servers.demo]\ncommand = "demo"\n');
    expect(codexStatus(home)).toMatchObject({ ready: false, present: [] });
    expect(configureCodex(home).added).toHaveLength(3);
    expect(readFileSync(configPath(), 'utf8')).toBe('sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nwritable_roots = ["/x"]\nnetwork_access = true\n\n[mcp_servers.demo]\ncommand = "demo"\n');
    expect(codexStatus(home)).toMatchObject({ ready: true, missing: [] });
  });

  test('an unreadable file is reported and never overwritten', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath(), 'model = \n');
    expect(codexStatus(home)).toMatchObject({ ready: false });
    expect(codexStatus(home).error).toContain('Файл не прочитан');
    expect(() => configureCodex(home)).toThrow(AppError);
    expect(readFileSync(configPath(), 'utf8')).toBe('model = \n');
    expect(existsSync(`${configPath()}.bak`)).toBe(false);
  });
});
