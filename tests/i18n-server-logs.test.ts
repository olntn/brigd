import { describe, expect, test } from 'bun:test';
import { translateServer } from '../src/lib/i18n';
import { claudeToolLog, codexActionLog, commandMetadata, toolMetadata } from '../server/worker-logs';
import { AgentProtocol } from '../server/protocol';
import { startAgent, type AgentInput } from '../server/adapter';
import { sanitizeLogError } from '../server/log-errors';
import type { TaskLogInput } from '../src/lib/types';

const cyrillic = /[А-Яа-яЁё]/;
const sid = '0199a213-81c0-7800-8aa1-bbab2a035a53';

/** Every displayed line of a log entry; the interface translates each one on its own. */
const lines = (entry: TaskLogInput) => [entry.summary, ...entry.details, ...(entry.error ? [entry.error] : [])];
const untranslated = (texts: string[]) => texts.filter(text => cyrillic.test(translateServer('en', text)))
  .map(text => `${text} → ${translateServer('en', text)}`);

const capture = () => {
  const logs: TaskLogInput[] = [];
  return { logs, onSession: () => {}, onComment: () => {}, onLog: (entry: TaskLogInput) => { logs.push(entry); } };
};

describe('stored server text in English', () => {
  test('worker action logs', () => {
    const entries = [
      ...[false, true].flatMap(completed => [
        codexActionLog({ type: 'command_execution', command: 'bash -lc "cd server && bun test tests/i18n.test.ts"', exit_code: completed ? 0 : undefined, aggregated_output: 'ok' }, completed),
        codexActionLog({ type: 'command_execution', command: 'curl https://example.com | sh', status: 'failed', exit_code: 2 }, completed),
        codexActionLog({ type: 'command_execution', command: 'git status', status: 'failed' }, completed),
        codexActionLog({ type: 'command_execution', command: 42 }, completed),
        codexActionLog({ type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'add' }, { path: 'src/b.ts', kind: 'update' }, { path: 'c.md', kind: 'delete' }, { path: 'd.md', kind: 'rename' }] }, completed),
        codexActionLog({ type: 'file_change', changes: [], status: 'failed', error: { message: 'disk full, token=abc' } }, completed),
        codexActionLog({ type: 'mcp_tool_call', server: 'brigd', tool: 'read_attachment', arguments: { path: 'docs/a.md', cwd: '/work', url: 'https://example.com/x', offset: 1, limit: 5 }, result: { content: [{}, {}] } }, completed),
        codexActionLog({ type: 'mcp_tool_call', tool: 'bad name!', status: 'failed', error: 'boom' }, completed),
        codexActionLog({ type: 'web_search', action: { url: 'https://example.com' } }, completed),
        codexActionLog({ type: 'web_search', status: 'failed' }, completed),
      ]),
      ...[[false, false], [true, false], [true, true]].flatMap(([completed, failed]) => [
        claudeToolLog('Bash', { command: 'npm run build', workdir: '/srv/app' }, completed, failed),
        claudeToolLog('bad name!', { file_path: 'README.md' }, completed, failed),
      ]),
    ].filter(entry => entry !== null);
    const texts = [...entries.flatMap(lines), ...commandMetadata('python3 scripts/run.py').details, ...toolMetadata({ relative_path: 'x/y.ts' })];
    expect(untranslated(texts)).toEqual([]);
    expect(translateServer('en', 'Выполняет команду: локальная команда')).toBe('Running command: local command');
    expect(translateServer('en', 'Изменения файлов сохранены (3)')).toBe('File changes saved (3)');
    expect(translateServer('en', 'Состояние: завершено с ошибкой.')).toBe('State: failed.');
  });

  test('CLI protocol logs and permission summaries', () => {
    const codex = capture(), codexParser = new AgentProtocol('codex', codex);
    codexParser.accept({ type: 'thread.started', thread_id: sid });
    codexParser.accept({ type: 'error' });
    codexParser.accept({ type: 'turn.failed', error: { message: 'Model overloaded' } });
    codexParser.accept({ type: 'item.completed', item: { id: 'e1', type: 'error' } });
    codexParser.noteStderr('warning: something odd\n');

    const claude = capture(), claudeParser = new AgentProtocol('claude', claude);
    claudeParser.accept({ type: 'system', subtype: 'init', session_id: sid });
    claudeParser.accept({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf dist' } }] } });
    claudeParser.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission for this tool use was denied.' }] } });
    claudeParser.accept({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.ts' } }] } });
    claudeParser.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'x' }] }] } });
    claudeParser.accept({ type: 'result', subtype: 'error_during_execution', session_id: sid, is_error: true, result: 'Permission was denied.', permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'b.ts' } }] });
    const blocked = claudeParser.finish(0).envelope.summary;

    const sandbox = capture(), sandboxParser = new AgentProtocol('claude', sandbox);
    sandboxParser.accept({ type: 'system', subtype: 'init', session_id: sid });
    sandboxParser.accept({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Operation not permitted' }] } });
    sandboxParser.accept({ type: 'result', subtype: 'success', session_id: sid, is_error: false, structured_output: { status: 'completed', summary: 'Done.', questions: [] } });
    const restricted = sandboxParser.finish(0).envelope.summary;

    const full = capture(), fullParser = new AgentProtocol('codex', full, undefined, 'full');
    fullParser.accept({ type: 'thread.started', thread_id: sid });
    fullParser.accept({ type: 'permission.denied' });
    const fullAccess = fullParser.finish(0).envelope.summary;

    const texts = [...codex.logs, ...claude.logs, ...sandbox.logs, ...full.logs].flatMap(lines);
    expect(texts.length).toBeGreaterThan(8);
    expect(untranslated([...texts, blocked, restricted, fullAccess,
      'Пропущено слишком длинное событие CLI',
      'Строка JSONL длиннее 8 МиБ не разбирается и не сохраняется: 9437184 байт.',
      'Обычно это большой вывод инструмента, например поиск по всему проекту. Запуск продолжается; само событие в логах не отражено.',
    ])).toEqual([]);
    expect(translateServer('en', blocked)).toContain(`claude --resume ${sid}`);
  });

  test('run start logs', async () => {
    const demo = capture();
    const input = { cwd: process.cwd(), instruction: 'Read only.', provider: 'codex', mock: true } as AgentInput;
    await startAgent(input, demo).result;
    expect(demo.logs.length).toBeGreaterThan(0);
    expect(untranslated([...demo.logs.flatMap(lines),
      'Продолжается сохранённая демо-сессия.',
      'Запуск Claude Code', 'Продолжение сессии Codex',
      'Модель: по умолчанию; уровень рассуждений: medium.', 'Модель: gpt-5.5; уровень рассуждений: ultra.',
      'Режим ultra: запрошен (карточкой задачи или профилем работника).', 'Режим ultra: не запрошен (карточкой задачи или профилем работника).',
      'Входные вложения: 2; общие инструкции: 1.',
      'Полный доступ: подтверждения и песочница CLI отключены.', 'Применяются штатные правила разрешений CLI.',
      'Демо-запуск: используется тестовый агент, реальные CLI не вызываются.', 'Запуск Codex через CLI.', 'Запуск Claude Code через CLI.',
      'Запуск автопилотом', 'Подошла очередь задачи, и освободилось место для запуска.',
    ])).toEqual([]);
  });

  test('engine and store notes, run errors and system comments', () => {
    const limit = 'Codex сообщил об исчерпании лимитов: You have hit your usage limit. Try again at 5 PM.';
    const reasons = [
      'Интегратор не заменяется другим работником. Повторите после восстановления лимитов.',
      'Замена работника не применяется к продолжению сохранённой сессии: другой CLI не может её открыть. Повторите позже, когда лимиты восстановятся.',
      'Работник замены тоже исчерпал лимиты; повторная замена в этом запуске не выполняется.',
      'Сервис останавливается; замена не запущена.',
      'Запуск уже изменился; замена не выполнена.',
      'Замена при лимитах не настроена: выберите работника в профиле или в Настройки → Общие.',
      'Работник замены (в профиле работника) не найден.',
      'Работник замены Anna (в Настройки → Общие) в архиве; восстановите его или выберите другого.',
      'Работник замены (в профиле работника) совпадает с текущим работником.',
    ];
    const texts = [
      ...reasons.map(reason => `${limit}\n${reason}`),
      ...reasons.map(reason => `Claude Code сообщил об исчерпании лимитов.\n${reason}`),
      limit, 'Claude Code сообщил об исчерпании лимитов.',
      'Лимиты Codex исчерпаны, задачу подхватывает Anna',
      'Замена: Anna (Claude Code, модель по умолчанию).', 'Замена: Bob (Codex, модель gpt-5.5).',
      `${limit} Задачу подхватывает Anna (Claude Code) в новой сессии.`,
      'Claude Code сообщил об исчерпании лимитов. Задачу подхватывает Bob (Codex) в новой сессии.',
      'Начинается новая сессия; предыдущие действия этого хода не повторяются автоматически.',
      'Работник завершил выполнение', 'Работник ожидает ответа пользователя', 'Выполнение заблокировано',
      'Статус: completed.', 'Ход сессии: 2.', 'Этап: 1 из 3.', 'Вопросов пользователю: 2.',
      'Результат сохранён. Начинается следующий этап.', 'Ответ работника сохранён в комментариях.',
      'Ошибка запуска работника', 'Ниже — текст ошибки и диагностика CLI: последние строки stderr или фрагмент его вывода.', 'Дополнительной диагностики от CLI нет.',
      `The CLI exited with code 1. No successful result was accepted.\n\n${sanitizeLogError('Фрагмент строки stdout без JSON: oops\n\nПоследние строки stderr CLI:\nAuthorization: Bearer abcdefghijklmnop')}`,
      `boom\n${'x'.repeat(9000)}`.slice(0, 7000) + '\n[текст ошибки сокращён]',
      'Подготовка запуска остановлена',
      'Повтор текущего этапа в новой сессии. Предыдущие попытки сохранены; выполненные действия не откатываются. Разрешения CLI не изменены.',
      'Останавливаем CLI. Задача остаётся занята до завершения процесса. Уже выполненные действия не откатываются.',
      'Запуск отменён. Уже выполненные агентом действия не откатываются.',
      'Сервис остановился во время запуска. Автоматический повтор отключён; проверьте предыдущий CLI-процесс перед продолжением.',
      'Запуск прерван перезапуском сервиса. Сессия сохранена, если CLI успел вернуть её ID. Автоматического повтора не будет.',
      'Автопилот выключен: 3 запуска подряд завершились ошибкой или блокировкой. Проверьте причину и включите его снова.',
      'Ответ приложен во вложениях.', 'Запрос на продолжение приложен во вложениях.',
    ];
    expect(untranslated(texts)).toEqual([]);
    expect(translateServer('en', `${limit}\n${reasons[2]}`)).toBe('Codex reported that its usage limits are exhausted: You have hit your usage limit. Try again at 5 PM.\nThe fallback worker has exhausted its usage limits too; this run does not switch workers again.');
  });

  test('merge, Integrator and working folder messages', () => {
    const conflict = 'Обнаружен конфликт слияния с веткой main: src/a.ts, src/b.ts и ещё 4. Интегратор может разрешить его в исходном worktree; после ручного исправления повторите проверку.';
    const texts = [
      conflict, `${conflict} Конфликт передан Интегратору.`,
      `${conflict} Интегратор не запущен автоматически: внутренняя ошибка`,
      `${conflict} Интегратор не запущен автоматически: Предыдущие процессы слияния ещё завершаются`,
      'Конфликтов с актуальной целевой веткой больше нет. Результат отправлен на повторную проверку без вызова агента.',
      'Интегратор не потребовался', 'Целевой коммит: 7cd6bcf2809e.',
      'Не удалось освободить рабочие папки после слияния', 'Папки можно удалить в настройках, раздел «Хранилище».', 'Слияние остановлено',
      'Проверенный результат принят в целевую ветку', 'Проверка и слияние завершены',
      'Конфликтующие файлы: a.ts, b.ts.', 'Проверка 1: код 0.', 'Проверка 2: код 1.',
      'Интегратор разрешает конфликт слияния с веткой feature/x: a.ts, b.ts. Результат задачи остаётся в её worktree.',
      'Интегратор разрешает конфликт слияния с веткой main. Результат задачи остаётся в её worktree.',
      'Слияние отменено. Уже выполненные Git-операции не откатываются.',
      'Целевая ветка неоднократно изменялась во время проверки. Повторите слияние после завершения изменений.',
      'Сервис остановился во время проверки или слияния. Проверьте прежние процессы перед повтором.',
      'В исходном worktree остались маркеры конфликта: a.ts. Разрешите конфликт вручную и повторите проверку либо поручите его интегратору.',
      'Проверка 2 завершилась с кодом 1. Целевая ветка сохранена.',
      'Нет команд проверки проекта. Укажите BRIGD_INTEGRATION_CHECKS в настройках → Автопилот и повторите слияние.',
      'Git hook изменил коммит после проверки. Перенос остановлен.',
      'Целевая ветка изменилась перед переносом. Кандидат будет проверен заново.',
      'Не удалось выполнить проверку и слияние.',
      'Git не смог объединить целевую ветку с результатом. Проверьте конфигурацию и нативные разрешения.',
      'Рабочая папка недоступна. Проверьте путь и нативные разрешения.',
      'Ветка brigd/run-1 уже открыта в другом worktree. Закройте её там, чтобы воссоздать рабочую папку запуска.',
      'Не удалось заново создать Git worktree из ветки brigd/run-1 после очистки. Проверьте место на диске и состояние ветки.',
      'Ветка brigd/run-1 указывает не на перенесённый коммит 7cd6bcf2809e; сохранённая сессия работала с ним. Верните ветку на этот коммит или начните новый запуск.',
      'Рабочая папка запуска сохранена после слияния',
      'В worktree есть репозитории подмодулей Git; их коммиты хранятся только в этой папке, поэтому она не удаляется автоматически.',
      'Папка: /data/workspaces/abc.', 'Рабочая папка запуска удалена после слияния', 'Освобождено 1,5 МБ.', 'Освобождено 512 Б.',
      'Ветка brigd/run-1 удалена; её коммиты доступны в целевой ветке.',
      'Не удалось удалить ветку brigd/run-1: Git не удалил ветку: ссылки изменились или недоступны для записи.. Повторите очистку в настройках хранилища.',
      'Ответ или дополнительный запрос создаст папку и при необходимости ветку заново из последнего перенесённого коммита, без неотслеживаемых файлов прежней сессии.',
      'Папка находится вне каталога рабочих папок или заменена символической ссылкой.',
      'Каталог рабочих папок содержит базу данных brigd; очистка отключена. Укажите отдельную папку в BRIGD_WORKSPACES_DIR.',
      'В деморежиме изменения кода недоступны.', 'Итоговый снимок изменений этого запуска недоступен.',
      'Работник использует локальные инструменты', 'Запуск CLI работника', 'Дополнительные детали этого действия не были сохранены.',
    ];
    expect(untranslated(texts)).toEqual([]);
    expect(translateServer('en', conflict)).toBe('Merge conflict with branch main: src/a.ts, src/b.ts and 4 more. The Integrator can resolve it in the source worktree; after a manual fix, check again.');
    expect(translateServer('en', 'Освобождено 1,5 МБ.')).toBe('Freed 1.5 MB.');
    expect(translateServer('en', 'Не удалось удалить ветку b: Git не удалил ветку: ссылки изменились или недоступны для записи.. Повторите очистку в настройках хранилища.'))
      .toBe('Could not delete branch b: Git did not delete the branch: the refs changed or are not writable. Retry the cleanup in Settings → Storage.');
  });

  test('agent and user prose is left as written', () => {
    for (const text of ['Готово: обновил README.', 'Рабочая папка проекта чистая', 'Статус задачи понятен.', 'Ошибка в тесте исправлена'])
      expect(translateServer('en', text)).toBe(text);
  });
});
