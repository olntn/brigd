import type { TaskLogInput } from '../src/lib/types';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeName = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : undefined;
const safePath = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 240 && !/[\x00-\x1f\x7f$`=]/.test(value) && !value.includes('://') ? value : undefined;
const executableNames = new Set(['bun', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pytest', 'git', 'rg', 'grep', 'cat', 'sed', 'ls', 'find', 'head', 'tail', 'wc', 'pwd', 'cd', 'tsc', 'cargo', 'go', 'make', 'docker', 'curl', 'wget', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'apply_patch']);
const subcommands = new Set(['test', 'run', 'build', 'check', 'lint', 'format', 'install', 'status', 'diff', 'show', 'log', 'ls-files', 'rev-parse', 'fetch', 'pull', 'push', 'commit', 'add', 'checkout', 'switch', 'restore', 'reset', 'branch', 'merge', 'rebase', '--files', '--version']);

/** Project operation metadata only: no shell source, arbitrary arguments, output, or reasoning. */
export function commandMetadata(command: unknown): { label: string; details: string[] } {
  if (typeof command !== 'string') return { label: 'локальная команда', details: [] };
  let source = command.trim();
  const shell = source.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+([\s\S]+)$/);
  if (shell) source = shell[1]!.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  const changeDirectory = source.match(/^cd\s+([\w./-]+)\s+&&\s+([\s\S]+)$/);
  const context = changeDirectory ? [`Рабочая папка: ${changeDirectory[1]}`] : [];
  if (changeDirectory) source = changeDirectory[2]!;
  // Only summarize the first simple command. Shell expressions are never rendered.
  const segment = source.split(/[;&|\n]/, 1)[0]!;
  const tokens = segment.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) ?? [];
  const executable = tokens[0]?.split('/').at(-1);
  if (!executable || !executableNames.has(executable)) return { label: 'локальная команда', details: ['Произвольные аргументы команды скрыты.'] };
  const operation = tokens[1] && subcommands.has(tokens[1]) ? tokens[1] : '';
  const script = operation === 'run' && tokens[2] && subcommands.has(tokens[2]) ? tokens[2] : '';
  const label = [executable, operation, script].filter(Boolean).join(' ');
  const paths = tokens.slice(1).filter(token => !token.startsWith('-') &&
    /^(?:(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|svelte|json|toml|ya?ml|md|txt|py|rs|go|css|html|sql|sh)|(?:\.{0,2}\/)?(?:src|server|tests|test|e2e|scripts|dist|docs)(?:\/[\w./-]+)?)$/.test(token));
  return { label, details: [...context, `Программа: ${label}.`, ...[...new Set(paths)].slice(0, 12).map(path => `Файл или папка: ${path}`)] };
}

export function toolMetadata(input: unknown): string[] {
  if (!record(input)) return [];
  const details: string[] = [];
  if (typeof input.command === 'string') details.push(...commandMetadata(input.command).details);
  for (const key of ['path', 'file_path', 'relative_path', 'cwd', 'workdir']) {
    const path = safePath(input[key]);
    if (path) details.push(`${key === 'cwd' || key === 'workdir' ? 'Рабочая папка' : 'Файл или папка'}: ${path}`);
  }
  if (typeof input.url === 'string') {
    try { const url = new URL(input.url); if (['https:', 'http:'].includes(url.protocol)) details.push(`Источник: ${url.hostname}`); } catch { /* Omit malformed URLs. */ }
  }
  for (const key of ['offset', 'limit', 'start_line', 'end_line']) if (typeof input[key] === 'number' && Number.isFinite(input[key])) details.push(`${key}: ${input[key]}`);
  if (Object.keys(input).length) details.push(`Параметров инструмента: ${Object.keys(input).length}.`);
  return details;
}

export function codexActionLog(item: Record<string, unknown>, completed: boolean): TaskLogInput | null {
  const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.error != null;
  const state = completed ? failed ? 'завершено с ошибкой' : 'завершено' : 'выполняется';
  const details = [`Состояние: ${state}.`];
  if (item.type === 'command_execution') {
    const command = commandMetadata(item.command);
    details.push(...command.details);
    if (typeof item.exit_code === 'number') details.push(`Код завершения: ${item.exit_code}.`);
    if (typeof item.aggregated_output === 'string') details.push(`Объём вывода: ${new TextEncoder().encode(item.aggregated_output).byteLength} байт.`);
    return { kind: 'command', summary: `${completed ? failed ? 'Ошибка команды' : 'Команда завершена' : 'Выполняет команду'}: ${command.label}`, details };
  }
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes.filter(record) : [];
    for (const change of changes.slice(0, 20)) {
      const path = safePath(change.path);
      const action = ({ add: 'Создание', update: 'Изменение', delete: 'Удаление' } as Record<string, string>)[String(change.kind)] ?? 'Изменение';
      if (path) details.push(`${action}: ${path}`);
    }
    details.push(`Файлов в операции: ${changes.length}.`);
    return { kind: 'file', summary: `${completed ? failed ? 'Ошибка изменения файлов' : 'Изменения файлов сохранены' : 'Изменяет файлы'}${changes.length ? ` (${changes.length})` : ''}`, details };
  }
  if (item.type === 'mcp_tool_call') {
    const tool = safeName(item.tool) ?? 'MCP';
    const server = safeName(item.server);
    if (server) details.push(`Сервер: ${server}.`);
    details.push(`Инструмент: ${tool}.`, ...toolMetadata(item.arguments));
    if (record(item.result) && Array.isArray(item.result.content)) details.push(`Блоков результата: ${item.result.content.length}.`);
    return { kind: 'tool', summary: `${completed ? failed ? 'Ошибка инструмента' : 'Инструмент завершён' : 'Вызывает инструмент'}: ${tool}`, details };
  }
  if (item.type === 'web_search') {
    details.push('Операция: поиск во внешних источниках.');
    if (record(item.action)) details.push(...toolMetadata(item.action));
    return { kind: 'search', summary: completed ? 'Поиск во внешних источниках завершён' : 'Ищет информацию во внешних источниках', details };
  }
  return null;
}

export function claudeToolLog(tool: unknown, input: unknown, completed = false, failed = false): TaskLogInput {
  const name = safeName(tool) ?? 'локальный инструмент';
  return { kind: 'tool', summary: `${completed ? failed ? 'Ошибка инструмента' : 'Инструмент завершён' : 'Вызывает инструмент'}: ${name}`,
    details: [`Инструмент: ${name}.`, `Состояние: ${completed ? failed ? 'завершено с ошибкой' : 'завершено' : 'выполняется'}.`, ...toolMetadata(input)] };
}
