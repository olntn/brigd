<script lang="ts">
  import Icon from './Icon.svelte';
  import { t, tc } from './i18n';

  // The same guidance as docs/cli-permissions.md; keep both in step when one changes.
  const settingsExample = JSON.stringify({
    permissions: {
      allow: ['Edit', 'Write', 'Bash(bun install:*)', 'Bash(bun test:*)', 'Bash(bun run check:*)', 'Bash(bun run verify:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)'],
      deny: ['Read(./.env)', 'Read(./.env.*)'],
    },
  }, null, 2);
  const checksExample = `[["python","-m","pytest"]]`;
  const containerEdit = "docker compose exec trackt sh -c 'mkdir -p ~/.claude && ${EDITOR:-vi} ~/.claude/settings.json'";
  let copied = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = id;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = null; }, 2000);
    } catch { copied = null; }
  }
</script>

{#snippet codeBlock(id: string, text: string, label: string)}
  <div class="help-code-block"><pre class="help-code" aria-label={label}><code>{text}</code></pre><button type="button" class="button secondary help-copy" onclick={() => copy(id, text)} aria-label={t('Скопировать: {label}', { label })}><Icon name={copied === id ? 'check' : 'code'} size={14} />{copied === id ? t('Скопировано') : t('Скопировать')}</button></div>
{/snippet}

<section class="help-section" aria-labelledby="guide-brigd-title">
  <h2 id="guide-brigd-title">{t('Общий режим доступа')}</h2>
  <p>{t('В «Настройки → Разрешения» переключатель')} <strong>{t('Полный доступ Codex и Claude Code')}</strong> {t('по умолчанию включён. Оба CLI выполняют команды и записывают файлы без своих подтверждений и песочниц, с правами пользователя сервиса.')} {t('Права ОС, границы контейнера, вход в аккаунты, лимиты и политики провайдеров сохраняются.')}</p>
  <p>{t('Режим сохраняется в базе и применяется без перезапуска сервиса к новым процессам: обычным задачам, этапам, автопилоту, Интегратору и продолжениям сессий. Уже запущенные процессы сохраняют прежний режим. После изменения повторите заблокированный этап или отправьте обычной заблокированной задаче дополнительный запрос')} <strong>{t('«Продолжи задачу»')}</strong>.</p>
  <p>{t('При каждом запуске brigd передаёт CLI свои аргументы, и они имеют приоритет над вашими конфигами.')}</p>
  <div class="help-table-wrap"><table class="help-table">
    <thead><tr><th>{t('Режим и CLI')}</th><th>{t('Аргументы brigd')}</th><th>{t('Что это значит')}</th></tr></thead>
    <tbody>
      <tr><td>{t('Полный доступ, Claude Code')}</td><td><code>--dangerously-skip-permissions</code>, <code>--settings</code> {t('отключает')} <code>sandbox.enabled</code></td><td>{t('Подтверждения инструментов и песочница Claude Code отключены')}</td></tr>
      <tr><td>{t('Полный доступ, Codex')}</td><td><code>--dangerously-bypass-approvals-and-sandbox</code></td><td>{t('Подтверждения инструментов и песочница Codex отключены')}</td></tr>
      <tr><td>{t('Ограниченный, Claude Code')}</td><td><code>--permission-mode default</code>; <code>--allowedTools</code> {t('только для собственных MCP-инструментов brigd')}</td><td>{t('Правка файла или команда без allow-правила отклоняется; интерактивного подтверждения в brigd нет')}</td></tr>
      <tr><td>{t('Ограниченный, Codex')}</td><td><code>--sandbox workspace-write</code>, {t('политика подтверждений')} <code>on-request</code>, {t('сеть в песочнице включена')}</td><td>{t('В рабочей папке разрешены правки и команды; запись вне папки или запрос эскалации блокируется')}</td></tr>
    </tbody>
  </table></div>
  <p>{t('В полном доступе настройка файлов CLI не нужна. Выключите переключатель, чтобы вернуть ограничения; появится раздел')} <strong>{t('Настройки ограниченного режима')}</strong> {t('с кнопками')} <strong>{t('Настроить разрешения…')}</strong>. {t('Эти кнопки дополняют пользовательские конфиги и сохраняют прежние файлы в резервные копии. Состояние')} <strong>{t('Разрешения включены')}</strong> {t('означает наличие нужных параметров в файле, а не полный доступ.')}</p>
  <p>{t('Далее описана настройка ограниченного режима. Ответ в карточке brigd принимает уточнения по задаче и не выдаёт системное разрешение CLI. Значение')} <code>permissions.defaultMode</code> {t('в настройках Claude Code не заменяет переключатель: аргументы запуска brigd сильнее.')}</p>
</section>

<section class="help-section" aria-labelledby="guide-claude-title">
  <h2 id="guide-claude-title">Claude Code</h2>
  <p>{t('Следующие правила относятся к ограниченному режиму.')}</p>
  <h3>{t('Где хранятся правила')}</h3>
  <p>{t('Claude Code читает правила из нескольких файлов. Для запусков brigd важно, какие из них видны внутри рабочей папки запуска: новые запуски идут в отдельном Git worktree, который создаётся из коммита.')}</p>
  <div class="help-table-wrap"><table class="help-table">
    <thead><tr><th>{t('Файл')}</th><th>{t('Область')}</th><th>{t('Виден в запусках brigd')}</th></tr></thead>
    <tbody>
      <tr><td><code>~/.claude/settings.json</code></td><td>{t('Пользователь, все проекты')}</td><td>{t('Да. Это домашняя папка того пользователя Linux, от которого запущен brigd и выполнен вход в CLI. В контейнере это том')} <code>trackt-cli-home</code></td></tr>
      <tr><td><code>.claude/settings.json</code> {t('в репозитории проекта')}</td><td>{t('Проект, файл коммитится')}</td><td>{t('Да, если файл закоммичен')}</td></tr>
      <tr><td><code>.claude/settings.local.json</code></td><td>{t('Проект, файл не коммитится')}</td><td>{t('Git не переносит файл в worktree; для запусков brigd используйте пользовательские настройки')}</td></tr>
    </tbody>
  </table></div>
  <p>{t('Если brigd правит собственный репозиторий, используйте пользовательский файл: папка')} <code>.claude/</code> {t('в нём добавлена в')} <code>.gitignore</code>.</p>

  <h3>{t('Какие правила нужны')}</h3>
  <p>{t('Базовый набор для проекта на Bun. Кнопка «Настройки → Разрешения → Настроить разрешения Claude Code» добавляет эти allow-правила. Они покрывают только перечисленные команды: например,')} <code>bun run build</code>, <code>npm test</code> {t('и инструмент')} <code>WebFetch</code> {t('потребуют отдельных правил. Составная Bash-команда может требовать правил для каждой операции: разрешённый')} <code>ls</code> {t('не разрешает следующий')} <code>head</code> {t('или')} <code>python3</code>. {t('Остальные ключи файла, например')} <code>model</code> {t('или')} <code>theme</code>, {t('остаются как есть.')}</p>
  {@render codeBlock('settings', settingsExample, t('Правила разрешений Claude Code'))}
  <ul>
    <li><strong>{t('Edit и Write')}</strong> {t('разрешают правки файлов. Чтобы ограничить область, укажите путь относительно корня проекта:')} <code>Edit(src/**)</code>, <code>Write(docs/**)</code>.</li>
    <li><strong>Bash(bun test:*)</strong> {t('разрешает команды, начинающиеся с')} <code>bun test</code>. {t('Перечисляйте только проверенные команды проекта.')} <code>bun install</code> {t('нужен потому, что worktree запуска создаётся без')} <code>node_modules</code>.</li>
    <li><strong>{t('Другие стеки.')}</strong> {t('Замените команды, например')} <code>Bash(python -m pytest:*)</code> {t('или')} <code>Bash(make test:*)</code>.</li>
    <li><strong>{t('deny и ask сильнее allow.')}</strong> {t('Запрет или запрос подтверждения остаётся в силе даже при наличии разрешающего правила. В')} <code>deny</code> {t('удобно добавить файлы с секретами и запрещённые команды;')} <code>ask</code> {t('потребует интерактивного подтверждения.')}</li>
  </ul>
  <p>{t('Правила читаются при каждом старте процесса CLI: текущие процессы продолжают работать по старым, новые запуски и продолжения сессий получают новые. В контейнере файл правится внутри него:')}</p>
  {@render codeBlock('container', containerEdit, t('Команда для правки файла в контейнере'))}

  <h3>{t('Через интерфейс Claude Code')}</h3>
  <p>{t('Вместо редактирования файла откройте')} <code>claude</code> {t('в папке проекта, введите')} <code>/permissions</code> {t('и добавьте те же правила. Для запусков brigd выбирайте пользовательскую область сохранения')} (<code>~/.claude/settings.json</code>).</p>

  <h3>{tc('guide', 'Проверка')}</h3>
  <ol>
    <li>{t('Создайте в brigd ручную задачу для работника с Claude Code: «Добавь комментарий в начало файла README.md и запусти bun test».')}</li>
    <li>{t('Дождитесь завершения. Статус')} <strong>{t('Завершено')}</strong> {t('означает, что правил достаточно для этой задачи. Строка «Применяются штатные правила разрешений CLI» описывает режим запуска, но не гарантирует разрешение всех действий.')}</li>
    <li>{t('При статусе')} <strong>{t('Заблокировано')}</strong> {t('с текстом про native permission approval сначала откройте')} <strong>{t('Настройки → Разрешения → Настроить разрешения Claude Code')}</strong>. {t('Кнопка добавляет базовые правила, но не снимает все возможные запреты.')}</li>
    <li>{t('Если базовые правила уже есть, откройте запись ошибки инструмента во вкладке')} <strong>{t('Логи')}</strong> {t('и скопируйте блок')} <strong>{tc('guide', 'Ошибка')}</strong>. {t('В нём видны причина отказа и операции, которым требуется разрешение. Контекст также можно проверить в сохранённой Claude-сессии: папки запусков лежат в')} <code>data/workspaces/</code> {t('рядом с базой, выполните в рабочей папке запуска')} <code>claude --resume &lt;{t('ID сессии')}&gt;</code>; {t('ID показан в истории запусков карточки.')}</li>
    <li>{t('Если действие допустимо, добавьте узкое правило через')} <code>/permissions</code> {t('или')} <code>~/.claude/settings.json</code>, {t('учитывая существующие')} <code>deny</code>{t('- и')} <code>ask</code>{t('-правила. Затем для обычной заблокированной задачи отправьте дополнительный запрос')} <strong>{t('«Продолжи задачу»')}</strong>, {t('а для отдельного этапа повторите этот этап. Дополнительный запрос возобновляет работу после настройки правил и сам по себе не выдаёт разрешение CLI.')}</li>
  </ol>
  <div class="help-note"><Icon name="alert" size={17} /><span>{t('Не вводите в карточку brigd пароли и не пытайтесь «разрешить» действие комментарием: это не работает по замыслу.')}</span></div>
</section>

<section class="help-section" aria-labelledby="guide-codex-title">
  <h2 id="guide-codex-title">Codex</h2>
  <p>{t('В ограниченном режиме brigd запускает')} <code>codex exec</code> {t('с песочницей')} <code>workspace-write</code>, {t('политикой подтверждений')} <code>on-request</code> {t('и включённой сетью. В рабочей папке доступны правки файлов, тесты, локальные серверы и установка пакетов; метаданные')} <code>.git</code> {t('защищены песочницей. Настройки')} <code>sandbox_mode</code> {t('и')} <code>approval_policy</code> {tc('guide', 'из')} <code>~/.codex/config.toml</code> {t('на запуски brigd не влияют: аргументы командной строки сильнее. Кнопка «Настроить разрешения Codex» дописывает в файл те же параметры:')} <code>sandbox_mode = "workspace-write"</code>, <code>approval_policy = "on-request"</code> {t('и')} <code>network_access = true</code> {t('в таблице')} <code>sandbox_workspace_write</code>. {t('Остальные ключи и комментарии сохраняются, прежний файл копируется в')} <code>config.toml.bak</code>.</p>
  <p>{t('В ограниченном режиме автоматически отклоняются запись вне рабочей папки и действия, для которых Codex запрашивает эскалацию. Для таких задач включите')} <strong>{t('Полный доступ Codex и Claude Code')}</strong> {t('либо выполните действие вручную.')}</p>
  <ol>
    <li><strong>{t('Вход.')}</strong> <code>codex login</code> {t('в терминале того же пользователя Linux. В контейнере:')} <code>docker compose exec trackt codex login --device-auth</code>.</li>
    <li><strong>Git.</strong> {t('Codex требует Git-репозиторий; worktree brigd ему удовлетворяет.')}</li>
    <li><strong>{t('Доверие к папке')}</strong> {t('запрашивает только интерактивный')} <code>codex</code>; <code>codex exec</code> {t('в brigd не спрашивает.')}</li>
    <li><strong>{t('Пробная задача')}</strong> {t('такая же, как для Claude Code: правка файла и запуск тестов.')}</li>
  </ol>
</section>

<section class="help-section" aria-labelledby="guide-night-title">
  <h2 id="guide-night-title">{t('Остальная подготовка к ночи')}</h2>
  <ul>
    <li><strong>{t('Целевая ветка.')}</strong> {t('В папке проекта выполните')} <code>git status --short</code>: {t('вывод должен быть пустым. Незавершённое закоммитьте или спрячьте в')} <code>git stash</code>, {t('переключитесь на ветку, в которую должны попадать результаты. Перенос делается fast-forward и требует чистого состояния.')}</li>
    <li><strong>{t('Команды проверки.')}</strong> {t('В «Настройки → Автопилот» сохраните значение')} <code>BRIGD_INTEGRATION_CHECKS</code>: {t('JSON-массив команд с аргументами. Настройка одна на весь сервис и применяется без перезапуска. Без неё реальные запуски, продолжения и проверка слияния заблокированы. Сохранённое значение имеет приоритет над одноимённой переменной окружения, которую можно задать в')} <code>.env</code> {t('рядом с brigd.')}</li>
  </ul>
  {@render codeBlock('checks', checksExample, t('Пример значения BRIGD_INTEGRATION_CHECKS'))}
  <ul>
    <li><strong>{t('Компьютер и сервер.')}</strong> {t('Планировщик работает, пока запущен')} <code>bun run start</code>. {t('Отключите сон компьютера; в WSL2 сон Windows останавливает и brigd. Терминал удобно держать в')} <code>tmux</code>.</li>
    <li><strong>{t('Автопилот.')}</strong> {t('Включите его на вкладке «Автопилот» с временем остановки. Там же памятка «Перед тем как уйти» и итоги сессии.')}</li>
  </ul>
</section>
