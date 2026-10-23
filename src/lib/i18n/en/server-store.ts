import type { Dictionary, Pattern } from './types';

/** Fixed server messages. */
export const messages: Dictionary = {
  // Settings and validation.
  'Некорректная модель': 'Invalid model',
  'Некорректное описание': 'Invalid description',
  'ultracode должен быть boolean': 'ultracode must be a boolean',
  'ultracode должен быть true, false или null': 'ultracode must be true, false or null',
  'Рабочая папка по умолчанию: введите от 1 до 4096 символов': 'Default working folder: enter 1 to 4096 characters',
  'Нужен абсолютный путь к рабочей папке': 'The working folder needs an absolute path',
  'Рабочая папка не существует или недоступна сервису': 'The working folder does not exist or the service cannot access it',
  'Рабочая папка по умолчанию: не больше 4096 символов': 'Default working folder: at most 4096 characters',
  'Тип запуска по умолчанию: выберите Автопилот, Вручную или По расписанию': 'Default run type: choose Autopilot, Manual or Scheduled',
  'Режим доступа должен быть standard или full': 'Access mode must be standard or full',
  'Замена при лимитах: выберите работника или оставьте поле пустым': 'Fallback on limits: choose a worker or leave the field empty',
  'Работник не может заменять сам себя': 'A worker cannot be its own fallback',
  'Работник замены не найден': 'Fallback worker not found',
  'Работник замены в архиве. Восстановите его или выберите другого.': 'The fallback worker is archived. Restore it or choose another one.',
  'Работник по умолчанию: выберите работника или оставьте поле пустым': 'Default worker: choose a worker or leave the field empty',
  'Работник по умолчанию не найден': 'Default worker not found',
  'Работник по умолчанию в архиве. Восстановите его или выберите другого.': 'The default worker is archived. Restore it or choose another one.',
  'fallbackWorkers: ожидается объект с полями codex и claude': 'fallbackWorkers: expected an object with codex and claude fields',
  'fallbackWorkers: допустимы только поля codex и claude': 'fallbackWorkers: only the codex and claude fields are allowed',
  'Укажите defaultCwd, defaultSchedule, defaultWorkerId и/или fallbackWorkers': 'Specify defaultCwd, defaultSchedule, defaultWorkerId and/or fallbackWorkers',
  'Повреждена настройка BRIGD_INTEGRATION_CHECKS. Сохраните команды в настройках → Автопилот.':
    'The BRIGD_INTEGRATION_CHECKS setting is corrupted. Save the commands in Settings → Autopilot.',
  'Некорректный BRIGD_INTEGRATION_CHECKS': 'Invalid BRIGD_INTEGRATION_CHECKS',
  'Укажите maxParallel и/или maxPerRepository': 'Specify maxParallel and/or maxPerRepository',
  'Некорректный лимит': 'Invalid limit',

  // Models, instructions, tags, workers and avatars.
  'Модель не найдена': 'Model not found',
  'Модель с таким ID уже есть у этого провайдера': 'This provider already has a model with this ID',
  'Инструкция не найдена': 'Instruction not found',
  'Тег не найден': 'Tag not found',
  'Тег с таким названием уже существует': 'A tag with this name already exists',
  'Выбранный тег не найден. Обновите список тегов.': 'The selected tag was not found. Refresh the tag list.',
  'Работник не найден': 'Worker not found',
  'Работник в архиве. Восстановите его или выберите другого.': 'The worker is archived. Restore it or choose another one.',
  'Выберите загруженный аватар': 'Choose an uploaded avatar',
  'Аватар не найден': 'Avatar not found',

  // Documentation pages and images.
  'Страница не найдена': 'Page not found',
  'Родительская страница не найдена': 'Parent page not found',
  'Некорректный поисковый запрос': 'Invalid search query',
  'Страница в корзине. Восстановите её, чтобы редактировать.': 'The page is in the trash. Restore it to edit.',
  'Страница изменена в другом окне. Загрузите новую версию, чтобы продолжить.': 'The page was changed in another window. Load the new version to continue.',
  'Изображение не найдено на этой странице. Загрузите файл заново.': 'The image was not found on this page. Upload the file again.',
  'Задача из блока не найдена': 'The task in the block was not found',
  'Поддерживаются изображения PNG, JPEG, WebP и GIF': 'Supported images: PNG, JPEG, WebP and GIF',
  'Страница в корзине. Восстановите её, чтобы добавлять изображения.': 'The page is in the trash. Restore it to add images.',
  'Хранилище изображений документации заполнено (1 ГиБ). Удалите ненужные картинки.': 'Documentation image storage is full (1 GiB). Delete images you no longer need.',
  'Изображение не найдено': 'Image not found',
  'Страница в корзине. Сначала восстановите её.': 'The page is in the trash. Restore it first.',
  'Нельзя вложить страницу в саму себя или в её подстраницу': 'A page cannot be nested inside itself or one of its subpages',
  'Сначала переместите страницу в корзину': 'Move the page to the trash first',

  // Attachments and uploads.
  'Вложение не найдено в этой задаче': 'Attachment not found in this task',
  'У этого файла нет безопасного предпросмотра': 'This file has no safe preview',
  'Предпросмотр недоступен': 'Preview unavailable',
  'Достигнут общий лимит вложений (1 ГиБ)': 'The total attachment limit (1 GiB) has been reached',
  'Слишком много незавершённых загрузок. Удалите лишние файлы или сохраните их в задачу.': 'Too many unfinished uploads. Remove extra files or save them to the task.',
  'Лимит вложений задачи: 200 файлов и 200 МиБ, включая историю запусков': 'Task attachment limit: 200 files and 200 MiB, including run history',
  'Загрузка не найдена': 'Upload not found',
  'Сохранённое вложение нельзя удалить как временную загрузку': 'A saved attachment cannot be deleted as a temporary upload',
  'Загрузка не найдена или срок её хранения истёк. Загрузите файл снова.': 'The upload was not found or has expired. Upload the file again.',
  'Вложение уже сохранено в другой записи': 'The attachment is already saved in another entry',
  'Для задачи выберите отдельную загрузку, а не файл комментария': 'Choose a separate upload for the task, not a comment file',
  'Подпись: не больше 16000 символов': 'Caption: at most 16000 characters',
  'У задачи уже 20 прямых вложений. Добавьте файл с подписью в комментарий.': 'The task already has 20 direct attachments. Add the file with a caption in a comment.',
  'Комментарий: введите текст или приложите файл': 'Comment: enter text or attach a file',
  'Вложение недоступно этому вызову агента': 'The attachment is not available to this agent call',

  // Agent calls and idempotency.
  'Этот вызов агента уже завершён или заменён': 'This agent call has already finished or been replaced',
  'Некорректный requestId': 'Invalid requestId',
  'requestId уже использован для другого содержимого': 'requestId has already been used for different content',
  'idempotency_key уже использован для другой операции': 'idempotency_key has already been used for a different operation',
  'Слишком большой результат операции MCP': 'The MCP operation result is too large',
  'Этот ход уже завершён или заменён': 'This turn has already finished or been replaced',

  // Tasks, the autopilot queue and the archive.
  'Задача не стоит в очереди автопилота. Выберите для неё режим «Автопилот».': 'The task is not in the Autopilot queue. Choose the “Autopilot” mode for it.',
  'Задача, перед которой нужно поставить эту, больше не в очереди автопилота. Обновите страницу и повторите.':
    'The task this one should go before is no longer in the Autopilot queue. Refresh the page and try again.',
  'Задача не найдена': 'Task not found',
  'Укажите ID задачи или его префикс длиной от 6 символов': 'Specify a task ID or an ID prefix of at least 6 characters',
  'Префикс задачи неоднозначен. Укажите полный ID задачи.': 'The task prefix is ambiguous. Specify the full task ID.',
  'Задача в архиве. Восстановите её, чтобы продолжить работу.': 'The task is archived. Restore it to continue working.',
  'Сначала завершите или отмените текущий запуск, затем перенесите задачу в архив.': 'Finish or cancel the current run first, then archive the task.',
  'Сначала завершите или отмените текущий запуск, затем удалите задачу.': 'Finish or cancel the current run first, then delete the task.',

  // Runs, follow-ups and stages.
  'Повреждён снимок запуска. Запуск остановлен; восстановите базу из резервной копии.': 'The run snapshot is corrupted. The run was stopped; restore the database from a backup.',
  'Повреждён снимок этапов. Запуск остановлен; восстановите базу из резервной копии.': 'The stage snapshot is corrupted. The run was stopped; restore the database from a backup.',
  'Запуск не найден': 'Run not found',
  'Некорректные параметры истории комментариев': 'Invalid comment history parameters',
  'Запуск относится к другой задаче': 'The run belongs to another task',
  'У задачи уже есть активный запуск. Ответьте агенту, повторите текущий этап или отмените запуск.':
    'The task already has an active run. Answer the agent, retry the current stage or cancel the run.',
  'Задача уже выполнялась успешно. Отправьте продолжение в сохранённую сессию завершённого запуска.':
    'The task has already completed successfully. Send a follow-up to the saved session of the completed run.',
  'Этот ID запроса уже использован с другим содержимым': 'This request ID has already been used with different content',
  'Исходный запуск относится к другой задаче': 'The source run belongs to another task',
  'Продолжить можно только завершённый или заблокированный агентом запуск': 'Only a completed run or one blocked by the agent can be continued',
  'У задачи уже есть активный запуск. Сначала завершите или отмените его.': 'The task already has an active run. Finish or cancel it first.',
  'Выберите завершённый этап исходного запуска': 'Choose a completed stage of the source run',
  'Исходный этап не завершён': 'The source stage has not completed',
  'У этого запуска нет отдельных этапов; укажите null': 'This run has no separate stages; specify null',
  'В исходном запуске нет сохранённого ID сессии. Продолжение в прежнем контексте невозможно.':
    'The source run has no saved session ID. It cannot be continued in the previous context.',
  'Следующий этап уже был запущен': 'The next stage has already been started',
  'CLI вернул другую сессию; запуск остановлен.': 'The CLI returned a different session; the run was stopped.',
  'Этот запуск нельзя продолжить': 'This run cannot be continued',
  'CLI не сохранил ID сессии. Для сложной задачи повторите текущий этап с подтверждением; иначе отмените запуск и создайте новый.':
    'The CLI did not save a session ID. For a complex task, retry the current stage with confirmation; otherwise cancel the run and start a new one.',
  'Сначала подтвердите, что предыдущий CLI-процесс остановлен. Повторный запуск может продублировать действия.':
    'First confirm that the previous CLI process has stopped. Running again may repeat its actions.',
  'Повтор отдельного этапа доступен только для сложной задачи': 'Retrying a single stage is only available for a complex task',
  'Подтвердите, что предыдущий CLI-процесс остановлен: повтор этапа может продублировать его действия.':
    'Confirm that the previous CLI process has stopped: retrying the stage may repeat its actions.',
  'Этот этап нельзя повторить. Сохранённую прерванную сессию нужно продолжить.': 'This stage cannot be retried. The saved interrupted session must be continued.',
  'Сначала подтвердите, что предыдущий CLI-процесс остановлен. Отмена освобождает задачу для новых запусков.':
    'First confirm that the previous CLI process has stopped. Cancelling frees the task for new runs.',
  'Запуск уже завершён': 'The run has already finished',

  // Integrator and merging.
  'Интегратор работает только с завершённым запуском в отдельном worktree': 'The Integrator works only with a completed run in a separate worktree',
  'Интегратору нужен конфликт слияния. Сейчас слияние в другом состоянии.': 'The Integrator needs a merge conflict. The merge is currently in a different state.',
  'Запуск создан из detached HEAD. Для объединения нужна именованная целевая ветка.': 'The run was created from a detached HEAD. Merging needs a named target branch.',
  'Результат уже заменён более новым запуском этой рабочей папки. Интегратору можно поручить только последний результат.':
    'The result has already been replaced by a newer run in this working folder. Only the latest result can be given to the Integrator.',
  'Сначала подтвердите, что прежние процессы проверки и слияния остановлены.': 'First confirm that the previous check and merge processes have stopped.',
  'Сначала завершите активное продолжение этой рабочей папки.': 'Finish the active follow-up in this working folder first.',
  'У запуска нет слияния': 'The run has no merge',
  'Слияние уже завершено': 'The merge has already finished',
};

const priorities: Record<string, string> = { 'Критический': 'Critical', 'Высокий': 'High', 'Обычный': 'Normal', 'Низкий': 'Low' };
const concurrencyFields: Record<string, string> = {
  'Всего процессов': 'Total processes',
  'Задач одновременно в одном репозитории': 'Tasks at once in one repository',
};

/** Server messages with embedded values. The first matching pattern wins. */
export const patterns: Pattern[] = [
  [/^Приоритет: укажите (.+)$/, 'Priority: use one of $1'],
  [/^База уже занята процессом PID (\d+)\. Остановите второй brigd перед запуском\.$/, 'The database is already in use by process PID $1. Stop the other brigd before starting.'],
  [/^Можно сохранить не больше (\d+) моделей для каждого провайдера$/, 'You can save at most $1 models per provider'],
  [/^Можно сохранить не больше (\d+) инструкций\. Удалите ненужную инструкцию\.$/, 'You can save at most $1 instructions. Delete an instruction you no longer need.'],
  [/^Можно сохранить не больше (\d+) страниц\. Удалите ненужные страницы из корзины\.$/, 'You can save at most $1 pages. Delete pages you no longer need from the trash.'],
  [/^Вложенность страниц ограничена (\d+) уровнями$/, 'Page nesting is limited to $1 levels'],
  [/^На одной странице допустимо не больше (\d+) изображений$/, 'A page can have at most $1 images'],
  [/^Можно сохранить не больше (\d+) тегов\. Удалите ненужный тег\.$/, 'You can save at most $1 tags. Delete a tag you no longer need.'],
  [/^Работник назначен в задачах: (\d+)(?:, из них в архиве: (\d+))?\. Назначьте им другого работника или удалите эти задачи, затем повторите\.$/,
    match => `The worker is assigned to ${match[1]} ${match[1] === '1' ? 'task' : 'tasks'}${match[2] ? ` (${match[2]} archived)` : ''}. Assign another worker to them or delete those tasks, then try again.`],
  [/^Задачу можно переставить только среди задач с тем же приоритетом \(«(.+)»\)\. Чтобы она шла раньше или позже, измените её приоритет\.$/,
    (match, translate) => `A task can only be moved among tasks with the same priority (“${priorities[match[1]!] ?? translate(match[1]!)}”). To run it earlier or later, change its priority.`],
  [/^Интегратор уже (\d+) раза объединял этот результат, а целевая ветка снова конфликтует\. Разрешите конфликт вручную в исходном worktree и повторите проверку\.$/,
    'The Integrator has already merged this result $1 times, and the target branch conflicts again. Resolve the conflict manually in the source worktree and run the check again.'],
  // Validation errors from shared modules that the store passes through.
  [/^Описание: не больше (\d+) символов, без нулевого символа$/, 'Description: at most $1 characters, no null character'],
  [/^ID модели должен быть текстом без управляющих символов\.$/, 'The model ID must be text without control characters.'],
  [/^ID модели: до (\d+) символов, без пробелов; начните с буквы или цифры\. Допустимы буквы, цифры и \. _ : \/ \+ @ \[ \] -$/,
    'Model ID: up to $1 characters, no spaces; start with a letter or digit. Letters, digits and . _ : / + @ [ ] - are allowed'],
  [/^BRIGD_INTEGRATION_CHECKS: укажите 1–10 непустых команд массивами аргументов$/, 'BRIGD_INTEGRATION_CHECKS: specify 1–10 non-empty commands as argument arrays'],
  [/^BRIGD_INTEGRATION_CHECKS должен быть JSON-массивом массивов аргументов$/, 'BRIGD_INTEGRATION_CHECKS must be a JSON array of argument arrays'],
  [/^(Всего процессов|Задач одновременно в одном репозитории): целое число от 1 до (\d+)$/,
    match => `${concurrencyFields[match[1]!]}: a whole number from 1 to ${match[2]}`],
];
