import type { Dictionary, Pattern } from './types';

/**
 * Text the server stores in Russian and the interface shows later: run log entries
 * (each details line separately), system comments, run, integration and cleanup errors
 * and code diff notes. Legacy action comments from activity.ts are in task.ts.
 */

const provider = '(Codex|Claude Code)';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Service markers inside CLI error text: redactions, truncation and diagnostic headings. */
const markers = (text: string) => text
  .replaceAll('[скрыто]', '[hidden]')
  .replaceAll('[текст ошибки сокращён]', '[error text truncated]')
  .replaceAll('Фрагмент строки stdout без JSON: ', 'Stdout line fragment without JSON: ')
  .replaceAll('Последние строки stderr CLI:\n', 'Last lines of CLI stderr:\n');

/** Git file lists end with «и ещё N» when shortened. */
const files = (list: string) => list.replace(/ и ещё (\d+)$/, ' and $1 more');

/** Sizes written by formatBytes() in Russian: «1,5 МБ». */
const size = (value: string, unit: string, translate: (text: string) => string) =>
  `${value.replace(',', '.').replace(/[   ]/g, ',')} ${translate(unit)}`;

const limitReached = (name: string, detail: string | undefined) =>
  `${name} reported that its usage limits are exhausted${detail === undefined ? '.' : `: ${markers(detail)}`}`;

/** Fixed server messages. */
export const messages: Dictionary = {
  // Worker actions (worker-logs.ts, protocol.ts).
  'локальная команда': 'local command',
  'локальный инструмент': 'local tool',
  'Произвольные аргументы команды скрыты.': 'Arbitrary command arguments are hidden.',
  'Команда завершилась с ошибкой без вывода.': 'The command failed without output.',
  'Ищет информацию во внешних источниках': 'Searching external sources',
  'Поиск во внешних источниках завершён': 'External search finished',
  'Ошибка поиска во внешних источниках': 'External search failed',
  'Операция: поиск во внешних источниках.': 'Operation: external search.',
  'Пропущено слишком длинное событие CLI': 'Skipped an oversized CLI event',
  'Обычно это большой вывод инструмента, например поиск по всему проекту. Запуск продолжается; само событие в логах не отражено.':
    'This is usually large tool output, such as a search across the whole project. The run continues; the event itself is not logged.',
  'Codex прислал элемент error без текста ошибки.': 'Codex sent an error item without error text.',

  // Run start (adapter.ts, store.ts).
  'Демонстрация работы агента': 'Agent demo',
  'Режим: демо, CLI и модель не вызываются.': 'Mode: demo; no CLI or model is called.',
  'Продолжается сохранённая демо-сессия.': 'Continuing the saved demo session.',
  'Создана новая демо-сессия.': 'Started a new demo session.',
  'Полный доступ: подтверждения и песочница CLI отключены.': 'Full access: CLI approvals and sandbox are disabled.',
  'Применяются штатные правила разрешений CLI.': 'The CLI’s own permission rules apply.',
  'Демо-запуск: используется тестовый агент, реальные CLI не вызываются.': 'Demo run: a test agent is used; no real CLI is called.',
  'Запуск автопилотом': 'Started by Autopilot',
  'Подошла очередь задачи, и освободилось место для запуска.': 'The task reached the front of the queue and a run slot became free.',
  'Подготовка запуска остановлена': 'Run preparation stopped',

  // Turn results and failures (engine.ts).
  'Работник завершил выполнение': 'Worker finished',
  'Работник ожидает ответа пользователя': 'Worker is waiting for the user’s answer',
  'Работник обновил статус выполнения задачи.': 'The worker updated the task’s progress status.',
  'Выполнение заблокировано': 'Execution blocked',
  'Результат сохранён. Начинается следующий этап.': 'Result saved. The next stage is starting.',
  'Ответ работника сохранён в комментариях.': 'The worker’s answer was saved in the comments.',
  'Ошибка запуска работника': 'Worker run failed',
  'Ниже — текст ошибки и диагностика CLI: последние строки stderr или фрагмент его вывода.':
    'Below are the error text and CLI diagnostics: the last stderr lines or a fragment of its output.',
  'Дополнительной диагностики от CLI нет.': 'The CLI provided no additional diagnostics.',
  'Начинается новая сессия; предыдущие действия этого хода не повторяются автоматически.':
    'A new session is starting; earlier actions of this turn are not repeated automatically.',
  'Интегратор не заменяется другим работником. Повторите после восстановления лимитов.':
    'The Integrator is not replaced by another worker. Retry once the usage limits reset.',
  'Замена работника не применяется к продолжению сохранённой сессии: другой CLI не может её открыть. Повторите позже, когда лимиты восстановятся.':
    'A fallback worker cannot continue a saved session: another CLI cannot open it. Retry later, once the usage limits reset.',
  'Работник замены тоже исчерпал лимиты; повторная замена в этом запуске не выполняется.':
    'The fallback worker has exhausted its usage limits too; this run does not switch workers again.',
  'Сервис останавливается; замена не запущена.': 'The service is stopping; the fallback worker was not started.',
  'Запуск уже изменился; замена не выполнена.': 'The run has already changed; the fallback worker was not started.',
  'Замена при лимитах не настроена: выберите работника в профиле или в Настройки → Общие.':
    'No fallback worker for usage limits is set: choose one in the worker profile or in Settings → General.',
  'в профиле работника': 'set in the worker profile',
  'в Настройки → Общие': 'set in Settings → General',

  // Run control comments (store.ts).
  'Повтор текущего этапа в новой сессии. Предыдущие попытки сохранены; выполненные действия не откатываются. Разрешения CLI не изменены.':
    'Retrying the current stage in a new session. Earlier attempts are kept; completed actions are not rolled back. CLI permissions are unchanged.',
  'Останавливаем CLI. Задача остаётся занята до завершения процесса. Уже выполненные действия не откатываются.':
    'Stopping the CLI. The task stays busy until the process exits. Actions already performed are not rolled back.',
  'Запуск отменён. Уже выполненные агентом действия не откатываются.': 'Run cancelled. Actions the agent already performed are not rolled back.',
  'Сервис остановился во время запуска. Автоматический повтор отключён; проверьте предыдущий CLI-процесс перед продолжением.':
    'The service stopped during the run. Automatic retry is off; check the previous CLI process before continuing.',
  'Запуск прерван перезапуском сервиса. Сессия сохранена, если CLI успел вернуть её ID. Автоматического повтора не будет.':
    'The run was interrupted by a service restart. The session is saved if the CLI had returned its ID. It will not be retried automatically.',
  'Ответ приложен во вложениях.': 'The answer is in the attachments.',
  'Запрос на продолжение приложен во вложениях.': 'The follow-up request is in the attachments.',

  // Merge and Integrator (engine.ts, store.ts, integration.ts).
  'Конфликтов с актуальной целевой веткой больше нет. Результат отправлен на повторную проверку без вызова агента.':
    'There are no more conflicts with the current target branch. The result was sent for another check without calling an agent.',
  'Интегратор не потребовался': 'Integrator not needed',
  'Конфликт передан Интегратору.': 'The conflict was handed to the Integrator.',
  'внутренняя ошибка': 'internal error',
  'Не удалось освободить рабочие папки после слияния': 'Could not free working folders after the merge',
  'Папки можно удалить в настройках, раздел «Хранилище».': 'You can delete the folders in Settings → Storage.',
  'Слияние остановлено': 'Merge stopped',
  'Проверенный результат принят в целевую ветку': 'The checked result was merged into the target branch',
  'Проверка и слияние завершены': 'Checks and merge finished',
  'Слияние отменено. Уже выполненные Git-операции не откатываются.': 'Merge cancelled. Git operations already performed are not rolled back.',
  'Целевая ветка неоднократно изменялась во время проверки. Повторите слияние после завершения изменений.':
    'The target branch changed repeatedly during the checks. Retry the merge once the changes are finished.',
  'Сервис остановился во время проверки или слияния. Проверьте прежние процессы перед повтором.':
    'The service stopped during checks or the merge. Check the previous processes before retrying.',
  'Git не смог проверить состояние репозитория. Проверьте путь и нативные разрешения.':
    'Git could not check the repository state. Check the path and native permissions.',
  'Git не смог проверить состояние индекса. Проверьте путь и нативные разрешения.':
    'Git could not check the index state. Check the path and native permissions.',
  'Целевая ветка открыта в нескольких worktree. Устраните неоднозначность перед слиянием.':
    'The target branch is checked out in several worktrees. Resolve the ambiguity before merging.',
  'Запуск создан из detached HEAD. Для слияния нужна именованная целевая ветка.':
    'The run was created from a detached HEAD. Merging needs a named target branch.',
  'Не удалось сохранить изменения worktree в индексе Git.': 'Could not stage the worktree changes in the Git index.',
  'В индекс попали служебные вложения задачи. Уберите их из индекса перед слиянием.':
    'Internal task attachments were staged. Remove them from the index before merging.',
  'Не удалось создать коммит результата. Проверьте Git-конфигурацию, hooks и нативные разрешения.':
    'Could not create the result commit. Check the Git configuration, hooks and native permissions.',
  'В worktree остались несохранённые изменения. Завершите их перед слиянием.':
    'The worktree has uncommitted changes. Finish them before merging.',
  'Коммиты результата содержат служебные вложения задачи. Удалите их из изменений перед слиянием.':
    'The result commits contain internal task attachments. Remove them from the changes before merging.',
  'Нет команд проверки проекта. Укажите BRIGD_INTEGRATION_CHECKS в настройках → Автопилот и повторите слияние.':
    'There are no project check commands. Set BRIGD_INTEGRATION_CHECKS in Settings → Autopilot and retry the merge.',
  'Не удалось подготовить worktree для проверки слияния.': 'Could not prepare a worktree to check the merge.',
  'Git не смог объединить результат. Проверьте конфигурацию и нативные разрешения.':
    'Git could not merge the result. Check the configuration and native permissions.',
  'Проверки изменили отслеживаемые файлы или Git-состояние кандидата. Нужна повторная проверка неизменённого результата.':
    'The checks changed tracked files or the Git state of the candidate. The unchanged result needs to be checked again.',
  'Исходный worktree изменился во время проверки. Повторите слияние после завершения изменений.':
    'The source worktree changed during the checks. Retry the merge once the changes are finished.',
  'Целевая ветка изменилась во время проверки. Кандидат будет подготовлен заново.':
    'The target branch changed during the checks. The candidate will be prepared again.',
  'Не удалось создать проверенный коммит объединения.': 'Could not create the checked merge commit.',
  'Git hook изменил коммит после проверки. Перенос остановлен.': 'A Git hook changed the commit after the checks. The merge was stopped.',
  'Целевая ветка изменилась перед переносом. Кандидат будет проверен заново.':
    'The target branch changed before the merge. The candidate will be checked again.',
  'В рабочей папке целевой ветки есть изменения или изменена ветка. Сохраните работу перед переносом результата.':
    'The target branch working folder has changes or a different branch checked out. Save your work before merging the result.',
  'Не удалось перенести проверенный результат. Проверьте состояние целевой ветки и нативные разрешения.':
    'Could not merge the checked result. Check the target branch state and native permissions.',
  'Целевая ветка изменилась или Git запретил обновление. Повторите проверку её актуального состояния.':
    'The target branch changed or Git refused the update. Check its current state again.',
  'Не удалось выполнить проверку и слияние.': 'Could not run the checks and merge.',
  'Интегратор работает только с результатом в отдельном worktree.': 'The Integrator works only with a result in a separate worktree.',
  'Не удалось отменить незавершённое объединение в worktree задачи. Проверьте его состояние вручную.':
    'Could not abort the unfinished merge in the task worktree. Check its state manually.',
  'В worktree задачи остались несохранённые изменения. Сохраните или отмените их перед работой интегратора.':
    'The task worktree has uncommitted changes. Commit or discard them before the Integrator works.',
  'Не удалось отменить пробное объединение в worktree задачи.': 'Could not abort the trial merge in the task worktree.',
  'Git не смог объединить целевую ветку с результатом. Проверьте конфигурацию и нативные разрешения.':
    'Git could not merge the target branch with the result. Check the configuration and native permissions.',

  // Run working folders (workspaces.ts, workspace-storage.ts).
  'Git не смог проверить рабочую папку. Нужен доступный репозиторий с сохранённым коммитом.':
    'Git could not check the working folder. It needs an accessible repository with a commit.',
  'Рабочая папка недоступна. Проверьте путь и нативные разрешения.': 'The working folder is unavailable. Check the path and native permissions.',
  'Рабочая папка находится вне репозитория.': 'The working folder is outside the repository.',
  'Исходный репозиторий изменён. Восстановите рабочее окружение перед продолжением.':
    'The source repository has changed. Restore the working environment before continuing.',
  'Сохранённый worktree изменён или относится к другому репозиторию. Восстановите рабочее окружение перед продолжением.':
    'The saved worktree has changed or belongs to another repository. Restore the working environment before continuing.',
  'Не удалось убрать остатки удалённой рабочей папки. Удалите её вручную и повторите.':
    'Could not clear the remains of a deleted working folder. Delete it manually and retry.',
  'Сохранённый worktree отсутствует. Восстановите его; продолжение в новой папке не заменяет прежнюю сессию.':
    'The saved worktree is missing. Restore it; continuing in a new folder does not replace the previous session.',
  'Не удалось создать Git worktree. Проверьте место на диске и нативные разрешения Git; рабочая папка проекта сохранена.':
    'Could not create a Git worktree. Check disk space and native Git permissions; the project working folder is unchanged.',
  'Рабочая папка запуска сохранена после слияния': 'Run working folder kept after the merge',
  'В worktree есть репозитории подмодулей Git; их коммиты хранятся только в этой папке, поэтому она не удаляется автоматически.':
    'The worktree contains Git submodule repositories; their commits exist only in this folder, so it is not deleted automatically.',
  'Рабочая папка запуска удалена после слияния': 'Run working folder deleted after the merge',
  'Ответ или дополнительный запрос создаст папку и при необходимости ветку заново из последнего перенесённого коммита, без неотслеживаемых файлов прежней сессии.':
    'An answer or a follow-up request recreates the folder, and the branch if needed, from the last merged commit, without the untracked files of the previous session.',
  'Удаляются только обычные папки.': 'Only regular folders are deleted.',
  'Папка не удалена полностью. Проверьте права доступа и открытые файлы.': 'The folder was not fully deleted. Check access rights and open files.',
  'Git не удалил ветку: ссылки изменились или недоступны для записи.': 'Git did not delete the branch: the refs changed or are not writable.',
  'Каталог рабочих папок совпадает с корнем или домашней папкой; brigd не управляет таким каталогом. Укажите отдельную папку в BRIGD_WORKSPACES_DIR.':
    'The working folders directory is the root or the home folder; brigd does not manage such a directory. Set a separate folder in BRIGD_WORKSPACES_DIR.',
  'Каталог рабочих папок содержит базу данных brigd; очистка отключена. Укажите отдельную папку в BRIGD_WORKSPACES_DIR.':
    'The working folders directory contains the brigd database; cleanup is disabled. Set a separate folder in BRIGD_WORKSPACES_DIR.',
  'Папка находится вне каталога рабочих папок.': 'The folder is outside the working folders directory.',
  'Папка находится вне каталога рабочих папок или заменена символической ссылкой.':
    'The folder is outside the working folders directory or was replaced by a symbolic link.',
  'В worktree есть репозитории подмодулей Git; их локальные коммиты нужно сохранить перед удалением.':
    'The worktree contains Git submodule repositories; save their local commits before deleting it.',
  'Git не смог удалить worktree, а папка находится вне каталога рабочих папок.':
    'Git could not remove the worktree, and the folder is outside the working folders directory.',

  // Code changes of a run (code-diff.ts).
  'Git не смог прочитать изменения рабочей папки.': 'Git could not read the working folder changes.',
  'В деморежиме изменения кода недоступны.': 'Code changes are unavailable in demo mode.',
  'Для этого запуска нет подтверждённого Git worktree.': 'This run has no confirmed Git worktree.',
  'Сохранённый Git worktree недоступен или изменён.': 'The saved Git worktree is unavailable or has changed.',
  'Git вернул недопустимый путь.': 'Git returned an invalid path.',
  'Git вернул неожиданное содержимое файла.': 'Git returned unexpected file contents.',
  'Путь файла выходит за пределы worktree.': 'The file path leads outside the worktree.',
  'Слишком много несохранённых файлов для точного снимка изменений запуска.':
    'Too many uncommitted files for an exact snapshot of the run changes.',
  'Исходные несохранённые файлы слишком велики для точного снимка изменений запуска.':
    'The initial uncommitted files are too large for an exact snapshot of the run changes.',
  'Не удалось прочитать Git worktree запуска.': 'Could not read the run’s Git worktree.',
  'Для этого запуска нет сохранённого снимка изменений.': 'This run has no saved snapshot of changes.',
  'Итоговый снимок изменений этого запуска недоступен.': 'The final snapshot of this run’s changes is unavailable.',

  // Failed check triage and hand-backs (integration.ts, store.ts, engine.ts).
  'Не удалось подготовить отдельный worktree целевой ветки для разбора упавшей проверки.': 'Could not prepare a separate target branch worktree for failed check triage.',
  'Возврат после упавшей проверки работает только с результатом в отдельном worktree.': 'A hand-back after a failed check works only with a result in its own worktree.',
  'В worktree задачи осталось незавершённое объединение. Завершите или отмените его перед возвратом работнику.':
    'An unfinished merge is left in the task worktree. Finish or abort it before handing the task back to the worker.',
  'В worktree задачи остались несохранённые изменения. Сохраните или отмените их перед возвратом работнику.':
    'Uncommitted changes are left in the task worktree. Commit or discard them before handing the task back to the worker.',
  'Не удалось создать merge-коммит проверенной целевой ветки в worktree задачи. Проверьте Git-конфигурацию, hooks и нативные разрешения.':
    'Could not create the merge commit of the tested target branch in the task worktree. Check the Git configuration, hooks and native permissions.',
  'Автоматический возврат выключен в настройках → Автопилот. Отправьте дополнительный запрос работнику вручную.':
    'Automatic hand-back is switched off in Settings → Autopilot. Send the worker a follow-up yourself.',
  'Задача с этапами не возвращается автоматически: по коду возврата не видно, какой этап внёс ошибку. Выберите этап и отправьте дополнительный запрос.':
    'A multi-stage task is not handed back automatically: an exit code does not show which stage introduced the failure. Choose a stage and send a follow-up.',
  'Автоматический возврат не выполнен: CLI не сохранил ID сессии работника, а продолжить можно только её. Исправьте результат вручную или поставьте задачу заново.':
    'Automatic hand-back not sent: the CLI did not save the worker’s session ID, and only that session can be continued. Fix the result by hand or set the task again.',
  'в записи слияния нет данных упавшей проверки.': 'the merge record has no data of the failed check.',
  'у результата нет сохранённой рабочей папки.': 'the result has no saved working folder.',
  'Задача возвращена работнику после упавшей проверки': 'Task handed back to the worker after a failed check',
  'Автоматический возврат после упавшей проверки не выполнен': 'No automatic hand-back after the failed check',
  'Проверенная целевая ветка объединена в worktree задачи': 'The tested target branch was merged into the task worktree',
  'Работник продолжит на том же коде, на котором упала проверка слияния.': 'The worker continues on the same code the merge check failed on.',
};

const blockedReasons: Dictionary = {
  'Claude Code не разрешил использование инструмента.': 'Claude Code did not allow the tool to be used.',
  'Claude Code сообщил об отказе доступа или ограничении среды.': 'Claude Code reported denied access or an environment restriction.',
};
const blockedNext: Dictionary = {
  'Откройте Настройки → Разрешения → Настроить разрешения Claude Code. Если базовые правила уже добавлены, проверьте отклонённую операцию в логах и правила ask/deny через /permissions в терминале Claude Code: они имеют приоритет над allow.':
    'Open Settings → Permissions → Configure Claude Code permissions. If the base rules are already added, check the denied operation in the logs and the ask/deny rules with /permissions in the Claude Code terminal: they take precedence over allow.',
  'Проверьте отклонённую операцию в логах и права доступа в рабочей папке; добавление allow-правила не устраняет ограничения файловой системы или песочницы.':
    'Check the denied operation in the logs and the access rights in the working folder; adding an allow rule does not lift file system or sandbox restrictions.',
};

/** Server messages with embedded values. The first matching pattern wins. */
export const patterns: Pattern[] = [
  // Notes appended to a merge conflict (store.noteIntegration joins them with a space).
  [/^([\s\S]+) Конфликт передан Интегратору\.$/, (match, translate) => `${translate(match[1]!)} The conflict was handed to the Integrator.`],
  [/^(?:([\s\S]+?) )?Интегратор не запущен автоматически: ([\s\S]+)$/, (match, translate) =>
    `${match[1] ? `${translate(match[1])} ` : ''}The Integrator was not started automatically: ${translate(match[2]!)}`],

  // Usage limits and fallback workers (engine.ts, store.ts).
  [new RegExp(`^${provider} сообщил об исчерпании лимитов(?:: (.*?)|\\.) Задачу подхватывает (.+) \\(${provider}\\) в новой сессии\\.$`), match =>
    `${limitReached(match[1]!, match[2])} ${match[3]} (${match[4]}) takes over the task in a new session.`],
  [new RegExp(`^${provider} сообщил об исчерпании лимитов(?:: (.*)|\\.)\\n([\\s\\S]+)$`), (match, translate) =>
    `${limitReached(match[1]!, match[2])}\n${translate(match[3]!)}`],
  [new RegExp(`^${provider} сообщил об исчерпании лимитов(?:: (.*)|\\.)$`), match => limitReached(match[1]!, match[2])],
  [new RegExp(`^Лимиты ${provider} исчерпаны, задачу подхватывает (.+)$`), '$1 usage limits exhausted; $2 takes over the task'],
  [new RegExp(`^Замена: (.+) \\(${provider}, модель (.+)\\)\\.$`), match =>
    `Fallback worker: ${match[1]} (${match[2]}, model ${match[3] === 'по умолчанию' ? 'default' : match[3]}).`],
  [/^Работник замены \((в профиле работника|в Настройки → Общие)\) не найден\.$/, (match, translate) =>
    `The fallback worker (${translate(match[1]!)}) was not found.`],
  [/^Работник замены (.+) \((в профиле работника|в Настройки → Общие)\) в архиве; восстановите его или выберите другого\.$/, (match, translate) =>
    `The fallback worker ${match[1]} (${translate(match[2]!)}) is archived; restore it or choose another one.`],
  [/^Работник замены \((в профиле работника|в Настройки → Общие)\) совпадает с текущим работником\.$/, (match, translate) =>
    `The fallback worker (${translate(match[1]!)}) is the current worker.`],

  // Permission denials (protocol.ts).
  [new RegExp(`^${provider} сообщил об отказе доступа\\. ${escape('Полный доступ уже выбран: подтверждения и песочница CLI отключены. Проверьте текст ошибки в логах, права пользователя сервиса и ограничения ОС, контейнера или провайдера. Изменение allow-правил ограниченного режима здесь не требуется.')}$`),
    '$1 reported denied access. Full access is already selected: CLI approvals and sandbox are disabled. Check the error text in the logs, the service user’s rights and OS, container or provider restrictions. Changing allow rules of the restricted mode is not needed here.'],
  [new RegExp(`^(${Object.keys(blockedReasons).map(escape).join('|')})(?: Инструменты: (.+?)\\.)? (${Object.keys(blockedNext).map(escape).join('|')}) ${escape('Сессию можно открыть из рабочей папки запуска: claude --resume ')}(\\S*)\\. ${escape('Комментарий в задаче не выдаёт разрешений CLI. После устранения причины отправьте «Продолжи задачу» через «Отправить агенту»; для этапа сложной задачи используйте повтор этапа.')}$`),
    match => `${blockedReasons[match[1]!]}${match[2] ? ` Tools: ${match[2]}.` : ''} ${blockedNext[match[3]!]} You can open the session from the run’s working folder: claude --resume ${match[4]}. A task comment does not grant CLI permissions. Once the cause is fixed, send “Continue the task” with “Send to agent”; for a stage of a multi-stage task, retry the stage.`],
  [/^(CLI отклонил инструмент|Ошибка доступа при вызове инструмента): (.+)$/, (match, translate) =>
    `${match[1] === 'CLI отклонил инструмент' ? 'The CLI denied the tool' : 'Access error while calling the tool'}: ${translate(match[2]!)}`],

  // Worker actions: summaries (worker-logs.ts, protocol.ts).
  [/^(Выполняет команду|Команда завершена|Ошибка команды): (.+)$/, (match, translate) =>
    `${({ 'Выполняет команду': 'Running command', 'Команда завершена': 'Command finished', 'Ошибка команды': 'Command failed' })[match[1]!]}: ${translate(match[2]!)}`],
  [/^(Вызывает инструмент|Инструмент завершён|Ошибка инструмента): (.+)$/, (match, translate) =>
    `${({ 'Вызывает инструмент': 'Calling tool', 'Инструмент завершён': 'Tool finished', 'Ошибка инструмента': 'Tool failed' })[match[1]!]}: ${translate(match[2]!)}`],
  [/^(Изменяет файлы|Изменения файлов сохранены|Ошибка изменения файлов)( \(\d+\))?$/, match =>
    `${({ 'Изменяет файлы': 'Changing files', 'Изменения файлов сохранены': 'File changes saved', 'Ошибка изменения файлов': 'File change failed' })[match[1]!]}${match[2] ?? ''}`],
  [new RegExp(`^Ошибка ${provider}$`), '$1 error'],
  [new RegExp(`^(Продолжение сессии|Запуск) ${provider}$`), match => match[1] === 'Запуск' ? `Starting ${match[2]}` : `Resuming the ${match[2]} session`],

  // Worker actions: details lines.
  [/^Состояние: (выполняется|завершено|завершено с ошибкой|доступ отклонён CLI|ошибка доступа)\.$/, match =>
    `State: ${({ 'выполняется': 'running', 'завершено': 'finished', 'завершено с ошибкой': 'failed', 'доступ отклонён CLI': 'access denied by the CLI', 'ошибка доступа': 'access error' })[match[1]!]}.`],
  [/^Рабочая папка: (.+)$/, 'Working folder: $1'],
  [/^Программа: (.+)\.$/, 'Program: $1.'],
  [/^Файл или папка: (.+)$/, 'File or folder: $1'],
  [/^Источник: (.+)$/, 'Source: $1'],
  [/^Параметров инструмента: (\d+)\.$/, 'Tool parameters: $1.'],
  [/^Код завершения: (-?\d+)\.$/, 'Exit code: $1.'],
  [/^Объём вывода: (\d+) байт\.$/, 'Output size: $1 bytes.'],
  [/^Объём результата: (\d+) байт\.$/, 'Result size: $1 bytes.'],
  [/^Команда завершилась с кодом (-?\d+) без вывода\.$/, 'The command exited with code $1 without output.'],
  [/^(Создание|Изменение|Удаление): (.+)$/, match => `${({ 'Создание': 'Create', 'Изменение': 'Update', 'Удаление': 'Delete' })[match[1]!]}: ${match[2]}`],
  [/^Файлов в операции: (\d+)\.$/, 'Files in the operation: $1.'],
  [/^Сервер: (.+)\.$/, 'Server: $1.'],
  [/^Инструмент: (.+)\.$/, (match, translate) => `Tool: ${translate(match[1]!)}.`],
  [/^Блоков результата: (\d+)\.$/, 'Result blocks: $1.'],
  [/^Строка JSONL длиннее ([\d.]+) МиБ не разбирается и не сохраняется: (\d+) байт\.$/, 'JSONL lines longer than $1 MiB are not parsed or stored: $2 bytes.'],
  [/^Событие CLI: ([^,\s]+)(, элемент error)?\.$/, match => `CLI event: ${match[1]}${match[2] ? ', error item' : ''}.`],
  [new RegExp(`^${provider} прислал событие (\\S+) без текста ошибки\\.$`), '$1 sent a $2 event without error text.'],
  [/^Результат Claude Code: (.+)\.$/, 'Claude Code result: $1.'],
  [/^Claude Code завершил ход с результатом (.+) без текста ошибки\.$/, 'Claude Code ended the turn with result $1 without error text.'],

  // Run start details (adapter.ts) and the start comment (store.ts).
  [/^Входные вложения: (\d+)\.$/, 'Input attachments: $1.'],
  [/^Входные вложения: (\d+); общие инструкции: (\d+)\.$/, 'Input attachments: $1; shared instructions: $2.'],
  [/^Модель: (.+); уровень рассуждений: (\S+)\.$/, match => `Model: ${match[1] === 'по умолчанию' ? 'default' : match[1]}; reasoning effort: ${match[2]}.`],
  [/^Режим ultra: (запрошен|не запрошен) \(карточкой задачи или профилем работника\)\.$/, match =>
    `Ultra mode: ${match[1] === 'запрошен' ? 'requested' : 'not requested'} (by the task card or the worker profile).`],
  [new RegExp(`^Запуск ${provider} через CLI\\.$`), 'Starting $1 through its CLI.'],

  // Turn results (engine.ts) and merge results (store.ts).
  [/^Статус: ([\w-]+)\.$/, 'Status: $1.'],
  [/^Статус выполнения: (.+)$/s, 'Progress: $1'],
  [/^Ход сессии: (\d+)\.$/, 'Session turn: $1.'],
  [/^Этап: (\d+) из (\d+)\.$/, 'Stage: $1 of $2.'],
  [/^Вопросов пользователю: (\d+)\.$/, 'Questions for the user: $1.'],
  [/^Целевой коммит: ([0-9a-f]+)\.$/, 'Target commit: $1.'],
  [/^Конфликтующие файлы: (.+)\.$/, 'Conflicting files: $1.'],
  [/^Проверка (\d+): код (-?\d+)\.$/, 'Check $1: exit code $2.'],
  [/^Интегратор разрешает конфликт слияния с веткой ([^:]+?)(?:: (.+))?\. Результат задачи остаётся в её worktree\.$/, match =>
    `The Integrator is resolving a merge conflict with branch ${match[1]}${match[2] ? `: ${match[2]}` : ''}. The task result stays in its worktree.`],
  [/^Автопилот выключен: (\d+) запуска подряд завершились ошибкой или блокировкой\. Проверьте причину и включите его снова\.$/,
    'Autopilot turned off: $1 runs in a row failed or were blocked. Check the cause and turn it on again.'],

  // Merge checks (integration.ts).
  [/^В исходном worktree остались маркеры конфликта: (.+)\. Разрешите конфликт вручную и повторите проверку либо поручите его интегратору\.$/, match =>
    `Conflict markers remain in the source worktree: ${files(match[1]!)}. Resolve the conflict manually and check again, or hand it to the Integrator.`],
  [/^Обнаружен конфликт слияния с веткой ([^:]+): (.+)\. Интегратор может разрешить его в исходном worktree; после ручного исправления повторите проверку\.$/, match =>
    `Merge conflict with branch ${match[1]}: ${files(match[2]!)}. The Integrator can resolve it in the source worktree; after a manual fix, check again.`],
  [/^Проверка (\d+) завершилась с кодом (-?\d+)\. Целевая ветка сохранена\.$/, 'Check $1 exited with code $2. The target branch is unchanged.'],

  // Failed check triage (integration.ts) and its hand-back notes, appended with a space (store.ts).
  [/^(Проверка \d+ \([\s\S]+\) завершилась с кодом -?\d+, при повторе — с кодом -?\d+, а на целевой ветке .+? проходит: причина в результате задачи\.) ([\s\S]+)$/,
    (match, translate) => `${translate(match[1]!)} ${translate(match[2]!)}`],
  [/^Проверка (\d+) \(([\s\S]+)\) завершилась с кодом (-?\d+), при повторе — с кодом (-?\d+), а на целевой ветке (.+?) проходит: причина в результате задачи\.$/,
    'Check $1 ($2) exited with code $3, with code $4 on its rerun, and passes on target branch $5: the cause is in the task result.'],
  [/^Целевая ветка (.+?) не проходит проверку ([\s\S]+): код (-?\d+) на коммите ([0-9a-f]+)\. Задача не возвращена работнику; исправьте целевую ветку и повторите проверку\.$/,
    'Target branch $1 fails check $2: exit code $3 on commit $4. The task was not handed back to the worker; fix the target branch and check again.'],
  [/^Разбор упавшей проверки (\d+) остановлен: повтор и проверка целевой ветки вместе превысили лимит (\d+) мин\. Задача не возвращена работнику\.$/,
    'Triage of failed check $1 stopped: the rerun and the target branch check together exceeded the $2 min limit. The task was not handed back to the worker.'],
  [/^Задача возвращена работнику в его сохранённую сессию: возврат (\d+) из (\d+)\.$/, 'The task was handed back to the worker’s saved session: hand-back $1 of $2.'],
  [/^Лимит автоматических возвратов исчерпан: (\d+) из (\d+)\. Нужно решение человека: отправьте дополнительный запрос или исправьте результат вручную\.$/,
    'The automatic hand-back limit is reached: $1 of $2. A person decides: send a follow-up or fix the result by hand.'],
  [/^Автоматический возврат не выполнен: ([\s\S]+)$/, (match, translate) => `Automatic hand-back not sent: ${translate(match[1]!)}`],
  [/^Проверка слияния ([\s\S]+) не прошла и при повторе \(код (-?\d+)\), а на целевой ветке (.+?) проходит\. brigd возвращает задачу работнику: возврат (\d+) из (\d+)\.$/,
    'Merge check $1 failed again on its rerun (exit code $2) and passes on target branch $3. brigd hands the task back to the worker: hand-back $4 of $5.'],
  [/^Повтор проверки (\d+): код (-?\d+)\.$/, 'Rerun of check $1: exit code $2.'],
  [/^Повтор проверки (\d+) остановлен\.$/, 'Rerun of check $1 stopped.'],
  [/^Целевая ветка на коммите ([0-9a-f]+): проверка (проходит|не проходит|остановлена)\.$/, match =>
    `Target branch at commit ${match[1]}: the check ${match[2] === 'проходит' ? 'passes' : match[2] === 'не проходит' ? 'fails' : 'was stopped'}.`],
  [/^Не удалось объединить проверенный коммит ветки (.+) с worktree задачи\. Разрешите расхождение вручную и отправьте дополнительный запрос\.$/,
    'Could not merge the tested commit of branch $1 into the task worktree. Resolve the divergence by hand and send a follow-up.'],

  // Run working folders (workspaces.ts, workspace-storage.ts).
  [/^Ветка (.+) уже открыта в другом worktree\. Закройте её там, чтобы воссоздать рабочую папку запуска\.$/,
    'Branch $1 is already checked out in another worktree. Close it there to recreate the run working folder.'],
  [/^Не удалось заново создать Git worktree из ветки (.+) после очистки\. Проверьте место на диске и состояние ветки\.$/,
    'Could not recreate the Git worktree from branch $1 after cleanup. Check disk space and the branch state.'],
  [/^Ветка (.+) указывает не на перенесённый коммит ([0-9a-f]+); сохранённая сессия работала с ним\. Верните ветку на этот коммит или начните новый запуск\.$/,
    'Branch $1 does not point to the merged commit $2 that the saved session worked with. Move the branch back to that commit or start a new run.'],
  [/^Ветка (.+) удалена; её коммиты доступны в целевой ветке\.$/, 'Branch $1 deleted; its commits are in the target branch.'],
  [/^Не удалось удалить ветку ([^:]+): ([\s\S]+)\. Повторите очистку в настройках хранилища\.$/, (match, translate) =>
    `Could not delete branch ${match[1]}: ${translate(match[2]!).replace(/\.$/, '')}. Retry the cleanup in Settings → Storage.`],
  [/^Освобождено (.+) (Б|КБ|МБ|ГБ|ТБ)\.$/, (match, translate) => `Freed ${size(match[1]!, match[2]!, translate)}.`],
  [/^Папка: (.+)\.$/, 'Folder: $1.'],

  // Error text blocks with service markers; the CLI text itself stays as written. Keep this pattern last.
  [/^[\s\S]*(?:\[скрыто\]|\[текст ошибки сокращён\]|Фрагмент строки stdout без JSON: |Последние строки stderr CLI:\n)[\s\S]*$/, match => markers(match[0])],
];
