import type { Dictionary, Pattern } from './types';

/**
 * Fixed server messages: API errors from routing, validation, backups, documentation,
 * attachments and the engine. Messages that store.ts shares are in server-store.ts.
 */
export const messages: Dictionary = {
  // Requests and routing.
  'Недопустимый Host': 'Host not allowed',
  'Недопустимый Origin': 'Origin not allowed',
  'Межсайтовые запросы запрещены': 'Cross-site requests are not allowed',
  'Внешний MCP отключён. Задайте BRIGD_MCP_TOKEN и перезапустите brigd.': 'External MCP is disabled. Set BRIGD_MCP_TOKEN and restart brigd.',
  'Изменения разрешены только из локального интерфейса (Origin обязателен)': 'Changes are allowed only from the local interface (Origin is required)',
  'Слишком большой запрос': 'Request too large',
  'Нужен Content-Type: application/json': 'Content-Type: application/json is required',
  'Нужен Content-Type: application/octet-stream': 'Content-Type: application/octet-stream is required',
  'Некорректный JSON': 'Invalid JSON',
  'Ожидается JSON-объект': 'Expected a JSON object',
  'Ожидается пустой JSON-объект': 'Expected an empty JSON object',
  'Маршрут не найден': 'Route not found',
  'Метод не поддерживается': 'Method not supported',
  'Некорректный URL': 'Invalid URL',
  'Недопустимый путь': 'Path not allowed',
  'Внутренняя ошибка. Подробности в терминале сервиса.': 'Internal error. See the service terminal for details.',
  'Слишком много одновременных загрузок. Повторите через несколько секунд.': 'Too many uploads at once. Try again in a few seconds.',
  'Укажите только поле mode': 'Specify only the mode field',
  'Допускается только поле includeCandidates типа boolean': 'Only the boolean includeCandidates field is allowed',
  'Укажите только поле integrationChecks': 'Specify only the integrationChecks field',
  'Укажите только archivedBefore: время в миллисекундах, не позже которого задачи попали в архив':
    'Specify only archivedBefore: the time in milliseconds by which the tasks were archived',
  'paused должен быть boolean': 'paused must be a boolean',

  // Service lifecycle and agent calls.
  'Сервис останавливается': 'The service is shutting down',
  'Сервис останавливается.': 'The service is shutting down.',
  'Дождитесь завершения восстановления.': 'Wait for the restore to finish.',
  'Дождитесь завершения других запросов и повторите восстановление.': 'Wait for other requests to finish, then retry the restore.',
  'Сервис недоступен для этого вызова агента.': 'The service is unavailable for this agent call.',
  'Вызов агента уже завершён или отменён.': 'The agent call has already finished or been cancelled.',
  'Текущий запуск уже завершён или отменён.': 'The current run has already finished or been cancelled.',

  // Runs, merges and cleanup.
  'Проверьте команды BRIGD_INTEGRATION_CHECKS': 'Check the BRIGD_INTEGRATION_CHECKS commands',
  'Сначала выключите автопилот и завершите или отмените активные запуски и слияния, затем очистите BRIGD_INTEGRATION_CHECKS.':
    'Turn off Autopilot and finish or cancel active runs and merges first, then clear BRIGD_INTEGRATION_CHECKS.',
  'В этом режиме отдельные worktree не создаются; очищать нечего.': 'This mode does not create separate worktrees; there is nothing to clean up.',
  'Очистка уже выполняется. Дождитесь её завершения.': 'Cleanup is already running. Wait for it to finish.',
  'Перед запуском настройте BRIGD_INTEGRATION_CHECKS в настройках, раздел «Автопилот».':
    'Before running, set BRIGD_INTEGRATION_CHECKS in Settings, “Autopilot” section.',
  'Предыдущий CLI-процесс этой задачи ещё завершается': 'The previous CLI process of this task is still finishing',
  'Процессы этой задачи ещё завершаются. Повторите через несколько секунд.': 'This task’s processes are still finishing. Try again in a few seconds.',
  'Предыдущий CLI-процесс ещё завершается': 'The previous CLI process is still finishing',
  'Предыдущие процессы слияния ещё завершаются': 'Previous merge processes are still finishing',
  'Для слияния нужен завершённый запуск в отдельном worktree': 'Merging needs a completed run in a separate worktree',

  // Task, worker and schedule validation.
  'Некорректный работник': 'Invalid worker',
  'Выберите Codex или Claude Code': 'Choose Codex or Claude Code',
  'Неизвестное расписание': 'Unknown schedule',
  'Интервал: от 1 до 525600 минут': 'Interval: 1 to 525600 minutes',
  'Некорректное время первого запуска': 'Invalid first run time',
  'enabled должен быть boolean': 'enabled must be a boolean',
  'archived должен быть boolean': 'archived must be a boolean',
  'Некорректное время остановки': 'Invalid stop time',
  'Время остановки уже прошло': 'The stop time has already passed',
  'Время остановки: не больше 31 дня вперёд': 'Stop time: at most 31 days ahead',
  'Укажите только поле beforeTaskId': 'Specify only the beforeTaskId field',
  'beforeTaskId: укажите ID задачи или null': 'beforeTaskId: specify a task ID or null',
  'Задачу нельзя поставить перед самой собой': 'A task cannot be placed before itself',
  'Этот effort не поддерживается выбранным провайдером': 'This effort is not supported by the selected provider',
  'Используйте загруженный аватар': 'Use an uploaded avatar',
  'Выберите, откуда Интегратор берёт настройки: как у запуска или свои': 'Choose where the Integrator gets its settings: from the run or its own',

  // Follow-ups.
  'Ожидается запрос на продолжение': 'Expected a follow-up request',
  'Укажите исходный запуск, этап, текст, вложения и ID запроса': 'Specify the source run, stage, text, attachments and request ID',
  'Некорректный исходный запуск': 'Invalid source run',
  'Укажите номер исходного этапа или null': 'Specify the source stage number or null',
  'Некорректный ID запроса': 'Invalid request ID',
  'Вложения должны быть массивом': 'Attachments must be an array',
  'Продолжение: введите от 1 до 8000 символов или приложите файлы': 'Follow-up: enter 1 to 8000 characters or attach files',

  // Complex tasks.
  'Этапы должны быть массивом': 'Stages must be an array',

  // Models.
  'Укажите только provider, modelId или label модели': 'Specify only the model provider, modelId or label',
  'Неизвестный провайдер модели': 'Unknown model provider',
  'Некорректный ID модели': 'Invalid model ID',
  'Укажите непустой ID модели': 'Specify a non-empty model ID',
  'Название модели должно быть текстом без управляющих символов': 'The model name must be text without control characters',
  'Укажите provider, modelId и label модели': 'Specify the model provider, modelId and label',

  // Instructions.
  'Укажите только название, текст или enabled инструкции': 'Specify only the instruction title, text or enabled',
  'Укажите название, текст и enabled инструкции': 'Specify the instruction title, text and enabled',
  'Некорректный снимок инструкции': 'Invalid instruction snapshot',

  // Tags.
  'Укажите только название или цвет тега': 'Specify only the tag name or color',
  'Цвет тега: укажите HEX в формате #RRGGBB': 'Tag color: specify a HEX value in the #RRGGBB format',
  'Укажите название тега': 'Specify a tag name',
  'Укажите только tagIds задачи': 'Specify only the task’s tagIds',

  // Documentation pages.
  'Некорректная родительская страница': 'Invalid parent page',
  'Укажите title или markdown': 'Specify title or markdown',
  'blocks должен быть массивом': 'blocks must be an array',
  'Укажите title, blocks и version страницы': 'Specify the page title, blocks and version',
  'version должен быть целым числом от 1': 'version must be an integer from 1',
  'Укажите parentId или position': 'Specify parentId or position',

  // Attachments and avatars.
  'Вложения не должны повторяться': 'Attachments must not repeat',
  'Некорректное имя вложения: используйте имя файла без пути и управляющих символов':
    'Invalid attachment name: use a file name without a path or control characters',
  'Некорректное имя вложения': 'Invalid attachment name',
  'Вложение должно быть не больше 10 МиБ': 'An attachment must be at most 10 MiB',
  'Предпросмотр занят. Повторите загрузку через несколько секунд.': 'Preview processing is busy. Retry the upload in a few seconds.',
  'Вложение не подготовлено': 'The attachment is not prepared',
  'Обработка изображений занята. Повторите через несколько секунд.': 'Image processing is busy. Try again in a few seconds.',
  'Не удалось подготовить изображение к просмотру': 'Could not prepare the image for preview',
  'Не удалось прочитать изображение аватара': 'Could not read the avatar image',
  'Используйте неподвижный аватар': 'Use a still, non-animated avatar',
  'Аватар: нужен PNG, JPEG или WebP': 'Avatar: PNG, JPEG or WebP is required',
  'Аватар должен быть не больше 256 КиБ': 'An avatar must be at most 256 KiB',
  'Аватар должен быть не больше 1024 × 1024 пикселей': 'An avatar must be at most 1024 × 1024 pixels',

  // Backups.
  'Дождитесь завершения загрузки бэкапа.': 'Wait for the backup upload to finish.',
  'Некорректное имя бэкапа': 'Invalid backup name',
  'Бэкап не найден': 'Backup not found',
  'Укажите одно поле: name или autoUpdate': 'Specify one field: name or autoUpdate',
  'Восстановление недоступно для этого запуска сервера.': 'Restoring is not available for this server process.',
  'Повреждены настройки бэкапов. Восстановите файл state.json перед изменением бэкапов.':
    'Backup settings are corrupted. Restore the state.json file before changing backups.',
  'Укажите имя файла бэкапа': 'Specify the backup file name',
  'Некорректное имя файла бэкапа': 'Invalid backup file name',
  'Файл повреждён или не является совместимым бэкапом brigd': 'The file is corrupted or is not a compatible brigd backup',
  'Папка бэкапов недоступна': 'The backup folder is unavailable',
  'Не удалось создать бэкап базы данных': 'Could not create a database backup',
  'Выберите файл бэкапа SQLite': 'Choose an SQLite backup file',
  'Размер бэкапа не должен превышать 256 МБ': 'A backup must not exceed 256 MB',
  'Автообновление должно быть boolean': 'Auto-update must be a boolean',
  'Автообновление доступно только для выбранного бэкапа': 'Auto-update is available only for the selected backup',
  'Не удалось переименовать бэкап. Попробуйте ещё раз.': 'Could not rename the backup. Try again.',
  'Текущий выбранный бэкап удалить нельзя': 'The currently selected backup cannot be deleted',
  'Не удалось обновить выбранный бэкап базы данных': 'Could not update the selected database backup',
  'Бэкап несовместим с текущей версией приложения': 'The backup is incompatible with the current app version',
  'Восстановление бэкапа уже выполняется': 'A backup restore is already in progress',
  'Не удалось восстановить бэкап и открыть предыдущую базу. Резервная копия перед восстановлением сохранена в папке бэкапов.':
    'Could not restore the backup or reopen the previous database. The copy made before the restore is in the backup folder.',
  'Не удалось восстановить бэкап. Предыдущие данные сохранены.': 'Could not restore the backup. The previous data is kept.',

  // CLI permission files: status notes and the reason a file was not read.
  'brigd запускает Claude Code в режиме разрешений default: без этих правил правка файла или команда завершает запуск блокировкой.':
    'brigd runs Claude Code in the default permission mode: without these rules, a file edit or command ends the run as blocked.',
  'brigd передаёт те же параметры флагами при каждом запуске: --sandbox workspace-write, approval_policy=on-request, сеть внутри песочницы.':
    'brigd passes the same settings as flags on every run: --sandbox workspace-write, approval_policy=on-request, network inside the sandbox.',
  'ожидается JSON-объект': 'expected a JSON object',
};

/** Field names that validation puts in front of a message. */
const fields: Record<string, string> = {
  'Название': 'Title',
  'Инструкция': 'Instruction',
  'Рабочая папка': 'Working folder',
  'Имя работника': 'Worker name',
  'Комментарий': 'Comment',
  'Ответ': 'Answer',
  'Личные инструкции': 'Personal instructions',
  'Указания Интегратору': 'Instructions for the Integrator',
  'Название инструкции': 'Instruction title',
  'Текст инструкции': 'Instruction text',
  'Название тега': 'Tag name',
};
const field = (name: string) => fields[name] ?? name;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A known Russian field name, or a label without Russian letters that needs no translation. */
const label = `(${Object.keys(fields).map(escape).join('|')}|[^:\\nА-Яа-яЁё]{1,40})`;
const stageFields: Record<string, string> = { 'название': 'title', 'инструкция': 'instruction' };

/** What is wrong with one documentation block; the server prefixes it with «Блок N: ». */
const blockProblems: Pattern[] = [
  [/^ожидается объект$/, 'expected an object'],
  [/^некорректный id$/, 'invalid id'],
  [/^id повторяется$/, 'duplicate id'],
  [/^неизвестный тип$/, 'unknown type'],
  [/^поле (\S+) недопустимо для блока «(.+)»$/, 'field $1 is not allowed in a “$2” block'],
  [/^текст до (\d+) символов без нулевых байтов$/, 'text up to $1 characters without null bytes'],
  [/^у блока «(.+)» нет текста$/, 'a “$1” block has no text'],
  [/^вложенность от 0 до (\d+)$/, 'indent from 0 to $1'],
  [/^(\S+) должен быть boolean$/, '$1 must be a boolean'],
  [/^язык до (\d+) символов: буквы, цифры, \+#\._-$/, 'language up to $1 characters: letters, digits, +#._-'],
  [/^иконка до (\d+) символов в одну строку$/, 'icon up to $1 characters on one line'],
  [/^неизвестный цвет выноски$/, 'unknown callout color'],
  [/^таблица содержит от 1 до (\d+) строк$/, 'a table has 1 to $1 rows'],
  [/^таблица содержит от 1 до (\d+) столбцов$/, 'a table has 1 to $1 columns'],
  [/^строка (\d+) должна содержать (\d+) ячеек$/, 'row $1 must have $2 cells'],
  [/^ячейка до (\d+) символов в одну строку$/, 'a cell holds up to $1 characters on one line'],
  [/^некорректный идентификатор изображения$/, 'invalid image ID'],
  [/^некорректный идентификатор задачи$/, 'invalid task ID'],
];

/** «Блок 3: id повторяется» → «Block 3: duplicate id»; the prefix word is optional, the number is not. */
const blockPatterns: Pattern[] = blockProblems.map(([problem, replacement]) => [
  new RegExp(`^(?:Блок )?(\\d+): (${problem.source.slice(1, -1)})$`),
  match => `Block ${match[1]}: ${match[2]!.replace(problem, replacement as string)}`,
] as const);

const fileNotParsed = 'Fix the file manually; brigd does not overwrite a file it cannot parse.';

/** Server messages with embedded values. The first matching pattern wins. */
export const patterns: Pattern[] = [
  // Text fields: «Название: введите от 1 до 140 символов» and the instruction variant without null bytes.
  [new RegExp(`^${label}: введите от 1 до (\\d+) символов( без нулевых байтов)?$`),
    match => `${field(match[1]!)}: enter 1 to ${match[2]} characters${match[3] ? ' without null bytes' : ''}`],
  [new RegExp(`^${label}: не больше (\\d+) символов$`), match => `${field(match[1]!)}: at most ${match[2]} characters`],

  // Complex tasks.
  [/^Сложная задача: от (\d+) до (\d+) этапов$/, 'Complex task: $1 to $2 stages'],
  [/^Этап (\d+): ожидается объект$/, 'Stage $1: expected an object'],
  [/^Этап (\d+): неизвестное поле$/, 'Stage $1: unknown field'],
  [/^Этап (\d+): выберите работника$/, 'Stage $1: choose a worker'],
  [/^Этап (\d+), ([^:\n]+): от (\d+) до (\d+) символов без нулевых байтов$/,
    match => `Stage ${match[1]}, ${stageFields[match[2]!] ?? match[2]}: ${match[3]} to ${match[4]} characters without null bytes`],
  [/^Все этапы вместе: не больше (\d+) символов$/, 'All stages together: at most $1 characters'],
  [/^Все этапы вместе: не больше (\d+) байтов UTF-8$/, 'All stages together: at most $1 UTF-8 bytes'],

  // Instructions, models, tags and attachments.
  [/^Допустимо не больше (\d+) инструкций$/, 'At most $1 instructions are allowed'],
  [/^Во включённых инструкциях допускается не больше (\d+) символов вместе с названиями\. Сократите текст или выключите часть инструкций\.$/,
    'Enabled instructions can have at most $1 characters including titles. Shorten the text or turn off some instructions.'],
  [/^Включённые инструкции превышают (\d+) байт с учётом JSON-кодирования\. Сократите текст или сохраните инструкцию выключенной\.$/,
    'Enabled instructions exceed $1 bytes after JSON encoding. Shorten the text or save the instruction turned off.'],
  [/^Название модели: от 1 до (\d+) символов$/, 'Model name: 1 to $1 characters'],
  [/^tagIds: укажите массив не больше чем из (\d+) идентификаторов тегов$/, 'tagIds: specify an array of at most $1 tag IDs'],
  [/^Вложения: выберите не больше (\d+) файлов$/, 'Attachments: choose at most $1 files'],
  [/^Статус выполнения: одна строка до (\d+) символов$/, 'Progress status: one line of up to $1 characters'],

  // Documentation pages.
  [/^Допустимы только поля: (.+)$/, 'Only these fields are allowed: $1'],
  [/^Название страницы: не больше (\d+) символов без нулевых байтов$/, 'Page title: at most $1 characters without null bytes'],
  [/^markdown: до (\d+) символов без нулевых байтов$/, 'markdown: up to $1 characters without null bytes'],
  [/^position: целое число от 0 до (\d+)$/, 'position: an integer from 0 to $1'],
  [/^На одной странице допустимо не больше (\d+) блоков\. Разделите её на подстраницы\.$/, 'A page can have at most $1 blocks. Split it into subpages.'],
  [/^Страница превышает (\d+) КиБ\. Вынесите часть содержимого на подстраницу\.$/, 'The page exceeds $1 KiB. Move part of its content to a subpage.'],
  ...blockPatterns,

  // CLI permission files; the path comes first and the parser's reason follows.
  [/^Файл не прочитан: (.+)\. Исправьте его вручную, brigd не перезаписывает непонятный файл\.$/,
    (match, translate) => `File not read: ${translate(match[1]!)}. ${fileNotParsed}`],
  [/^(.+?): (.+)\. Исправьте файл вручную, brigd не перезаписывает непонятный файл\.$/,
    (match, translate) => `${match[1]}: ${translate(match[2]!)}. ${fileNotParsed}`],
  [/^(.+?): не удалось дописать параметры \((.+)\)\. Добавьте их вручную\.$/, '$1: could not add the settings ($2). Add them manually.'],
  [/^(.+?): параметры не применились, добавьте их вручную\.$/, '$1: the settings did not take effect; add them manually.'],
];
