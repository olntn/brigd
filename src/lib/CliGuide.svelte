<script lang="ts">
  import Icon from './Icon.svelte';

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
  <div class="help-code-block"><pre class="help-code" aria-label={label}><code>{text}</code></pre><button type="button" class="button secondary help-copy" onclick={() => copy(id, text)} aria-label={'Скопировать: ' + label}><Icon name={copied === id ? 'check' : 'code'} size={14} />{copied === id ? 'Скопировано' : 'Скопировать'}</button></div>
{/snippet}

<section class="help-section" aria-labelledby="guide-brigd-title">
  <h2 id="guide-brigd-title">Общий режим доступа</h2>
  <p>В «Настройки → Разрешения» переключатель <strong>Полный доступ Codex и Claude Code</strong> по умолчанию включён. Оба CLI выполняют команды и записывают файлы без своих подтверждений и песочниц, с правами пользователя сервиса. Права ОС, границы контейнера, вход в аккаунты, лимиты и политики провайдеров сохраняются.</p>
  <p>Режим сохраняется в базе и применяется без перезапуска сервиса к новым процессам: обычным задачам, этапам, автопилоту, Интегратору и продолжениям сессий. Уже запущенные процессы сохраняют прежний режим. После изменения повторите заблокированный этап или отправьте обычной заблокированной задаче дополнительный запрос <strong>«Продолжи задачу»</strong>.</p>
  <p>При каждом запуске brigd передаёт CLI свои аргументы, и они имеют приоритет над вашими конфигами.</p>
  <div class="help-table-wrap"><table class="help-table">
    <thead><tr><th>Режим и CLI</th><th>Аргументы brigd</th><th>Что это значит</th></tr></thead>
    <tbody>
      <tr><td>Полный доступ, Claude Code</td><td><code>--dangerously-skip-permissions</code>, <code>--settings</code> отключает <code>sandbox.enabled</code></td><td>Подтверждения инструментов и песочница Claude Code отключены</td></tr>
      <tr><td>Полный доступ, Codex</td><td><code>--dangerously-bypass-approvals-and-sandbox</code></td><td>Подтверждения инструментов и песочница Codex отключены</td></tr>
      <tr><td>Ограниченный, Claude Code</td><td><code>--permission-mode default</code>; <code>--allowedTools</code> только для собственных MCP-инструментов brigd</td><td>Правка файла или команда без allow-правила отклоняется; интерактивного подтверждения в brigd нет</td></tr>
      <tr><td>Ограниченный, Codex</td><td><code>--sandbox workspace-write</code>, политика подтверждений <code>on-request</code>, сеть в песочнице включена</td><td>В рабочей папке разрешены правки и команды; запись вне папки или запрос эскалации блокируется</td></tr>
    </tbody>
  </table></div>
  <p>В полном доступе настройка файлов CLI не нужна. Выключите переключатель, чтобы вернуть ограничения; появится раздел <strong>Настройки ограниченного режима</strong> с кнопками <strong>Настроить разрешения…</strong>. Эти кнопки дополняют пользовательские конфиги и сохраняют прежние файлы в резервные копии. Состояние <strong>Разрешения включены</strong> означает наличие нужных параметров в файле, а не полный доступ.</p>
  <p>Далее описана настройка ограниченного режима. Ответ в карточке brigd принимает уточнения по задаче и не выдаёт системное разрешение CLI. Значение <code>permissions.defaultMode</code> в настройках Claude Code не заменяет переключатель: аргументы запуска brigd сильнее.</p>
</section>

<section class="help-section" aria-labelledby="guide-claude-title">
  <h2 id="guide-claude-title">Claude Code</h2>
  <p>Следующие правила относятся к ограниченному режиму.</p>
  <h3>Где хранятся правила</h3>
  <p>Claude Code читает правила из нескольких файлов. Для запусков brigd важно, какие из них видны внутри рабочей папки запуска: новые запуски идут в отдельном Git worktree, который создаётся из коммита.</p>
  <div class="help-table-wrap"><table class="help-table">
    <thead><tr><th>Файл</th><th>Область</th><th>Виден в запусках brigd</th></tr></thead>
    <tbody>
      <tr><td><code>~/.claude/settings.json</code></td><td>Пользователь, все проекты</td><td>Да. Это домашняя папка того пользователя Linux, от которого запущен brigd и выполнен вход в CLI. В контейнере это том <code>trackt-cli-home</code></td></tr>
      <tr><td><code>.claude/settings.json</code> в репозитории проекта</td><td>Проект, файл коммитится</td><td>Да, если файл закоммичен</td></tr>
      <tr><td><code>.claude/settings.local.json</code></td><td>Проект, файл не коммитится</td><td>Git не переносит файл в worktree; для запусков brigd используйте пользовательские настройки</td></tr>
    </tbody>
  </table></div>
  <p>Если brigd правит собственный репозиторий, используйте пользовательский файл: папка <code>.claude/</code> в нём добавлена в <code>.gitignore</code>.</p>

  <h3>Какие правила нужны</h3>
  <p>Базовый набор для проекта на Bun. Кнопка «Настройки → Разрешения → Настроить разрешения Claude Code» добавляет эти allow-правила. Они покрывают только перечисленные команды: например, <code>bun run build</code>, <code>npm test</code> и инструмент <code>WebFetch</code> потребуют отдельных правил. Составная Bash-команда может требовать правил для каждой операции: разрешённый <code>ls</code> не разрешает следующий <code>head</code> или <code>python3</code>. Остальные ключи файла, например <code>model</code> или <code>theme</code>, остаются как есть.</p>
  {@render codeBlock('settings', settingsExample, 'Правила разрешений Claude Code')}
  <ul>
    <li><strong>Edit и Write</strong> разрешают правки файлов. Чтобы ограничить область, укажите путь относительно корня проекта: <code>Edit(src/**)</code>, <code>Write(docs/**)</code>.</li>
    <li><strong>Bash(bun test:*)</strong> разрешает команды, начинающиеся с <code>bun test</code>. Перечисляйте только проверенные команды проекта. <code>bun install</code> нужен потому, что worktree запуска создаётся без <code>node_modules</code>.</li>
    <li><strong>Другие стеки.</strong> Замените команды, например <code>Bash(python -m pytest:*)</code> или <code>Bash(make test:*)</code>.</li>
    <li><strong>deny и ask сильнее allow.</strong> Запрет или запрос подтверждения остаётся в силе даже при наличии разрешающего правила. В <code>deny</code> удобно добавить файлы с секретами и запрещённые команды; <code>ask</code> потребует интерактивного подтверждения.</li>
  </ul>
  <p>Правила читаются при каждом старте процесса CLI: текущие процессы продолжают работать по старым, новые запуски и продолжения сессий получают новые. В контейнере файл правится внутри него:</p>
  {@render codeBlock('container', containerEdit, 'Команда для правки файла в контейнере')}

  <h3>Через интерфейс Claude Code</h3>
  <p>Вместо редактирования файла откройте <code>claude</code> в папке проекта, введите <code>/permissions</code> и добавьте те же правила. Для запусков brigd выбирайте пользовательскую область сохранения (<code>~/.claude/settings.json</code>).</p>

  <h3>Проверка</h3>
  <ol>
    <li>Создайте в brigd ручную задачу для работника с Claude Code: «Добавь комментарий в начало файла README.md и запусти bun test».</li>
    <li>Дождитесь завершения. Статус <strong>Завершено</strong> означает, что правил достаточно для этой задачи. Строка «Применяются штатные правила разрешений CLI» описывает режим запуска, но не гарантирует разрешение всех действий.</li>
    <li>При статусе <strong>Заблокировано</strong> с текстом про native permission approval сначала откройте <strong>Настройки → Разрешения → Настроить разрешения Claude Code</strong>. Кнопка добавляет базовые правила, но не снимает все возможные запреты.</li>
    <li>Если базовые правила уже есть, откройте запись ошибки инструмента во вкладке <strong>Логи</strong> и скопируйте блок <strong>Ошибка</strong>. В нём видны причина отказа и операции, которым требуется разрешение. Контекст также можно проверить в сохранённой Claude-сессии: папки запусков лежат в <code>data/workspaces/</code> рядом с базой, выполните в рабочей папке запуска <code>claude --resume &lt;ID сессии&gt;</code>; ID показан в истории запусков карточки.</li>
    <li>Если действие допустимо, добавьте узкое правило через <code>/permissions</code> или <code>~/.claude/settings.json</code>, учитывая существующие <code>deny</code>- и <code>ask</code>-правила. Затем для обычной заблокированной задачи отправьте дополнительный запрос <strong>«Продолжи задачу»</strong>, а для отдельного этапа повторите этот этап. Дополнительный запрос возобновляет работу после настройки правил и сам по себе не выдаёт разрешение CLI.</li>
  </ol>
  <div class="help-note"><Icon name="alert" size={17} /><span>Не вводите в карточку brigd пароли и не пытайтесь «разрешить» действие комментарием: это не работает по замыслу.</span></div>
</section>

<section class="help-section" aria-labelledby="guide-codex-title">
  <h2 id="guide-codex-title">Codex</h2>
  <p>В ограниченном режиме brigd запускает <code>codex exec</code> с песочницей <code>workspace-write</code>, политикой подтверждений <code>on-request</code> и включённой сетью. В рабочей папке доступны правки файлов, тесты, локальные серверы и установка пакетов; метаданные <code>.git</code> защищены песочницей. Настройки <code>sandbox_mode</code> и <code>approval_policy</code> из <code>~/.codex/config.toml</code> на запуски brigd не влияют: аргументы командной строки сильнее. Кнопка «Настроить разрешения Codex» дописывает в файл те же параметры: <code>sandbox_mode = "workspace-write"</code>, <code>approval_policy = "on-request"</code> и <code>network_access = true</code> в таблице <code>sandbox_workspace_write</code>. Остальные ключи и комментарии сохраняются, прежний файл копируется в <code>config.toml.bak</code>.</p>
  <p>В ограниченном режиме автоматически отклоняются запись вне рабочей папки и действия, для которых Codex запрашивает эскалацию. Для таких задач включите <strong>Полный доступ Codex и Claude Code</strong> либо выполните действие вручную.</p>
  <ol>
    <li><strong>Вход.</strong> <code>codex login</code> в терминале того же пользователя Linux. В контейнере: <code>docker compose exec trackt codex login --device-auth</code>.</li>
    <li><strong>Git.</strong> Codex требует Git-репозиторий; worktree brigd ему удовлетворяет.</li>
    <li><strong>Доверие к папке</strong> запрашивает только интерактивный <code>codex</code>; <code>codex exec</code> в brigd не спрашивает.</li>
    <li><strong>Пробная задача</strong> такая же, как для Claude Code: правка файла и запуск тестов.</li>
  </ol>
</section>

<section class="help-section" aria-labelledby="guide-night-title">
  <h2 id="guide-night-title">Остальная подготовка к ночи</h2>
  <ul>
    <li><strong>Целевая ветка.</strong> В папке проекта выполните <code>git status --short</code>: вывод должен быть пустым. Незавершённое закоммитьте или спрячьте в <code>git stash</code>, переключитесь на ветку, в которую должны попадать результаты. Перенос делается fast-forward и требует чистого состояния.</li>
    <li><strong>Команды проверки.</strong> В «Настройки → Автопилот» сохраните значение <code>BRIGD_INTEGRATION_CHECKS</code>: JSON-массив команд с аргументами. Настройка одна на весь сервис и применяется без перезапуска. Без неё реальные запуски, продолжения и проверка слияния заблокированы. Сохранённое значение имеет приоритет над одноимённой переменной окружения, которую можно задать в <code>.env</code> рядом с brigd.</li>
  </ul>
  {@render codeBlock('checks', checksExample, 'Пример значения BRIGD_INTEGRATION_CHECKS')}
  <ul>
    <li><strong>Компьютер и сервер.</strong> Планировщик работает, пока запущен <code>bun run start</code>. Отключите сон компьютера; в WSL2 сон Windows останавливает и brigd. Терминал удобно держать в <code>tmux</code>.</li>
    <li><strong>Автопилот.</strong> Включите его на вкладке «Автопилот» с временем остановки. Там же памятка «Перед тем как уйти» и итоги сессии.</li>
  </ul>
</section>
