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
  <h2 id="guide-brigd-title">Что фиксирует brigd</h2>
  <p>При каждом запуске brigd передаёт CLI свои аргументы, и они имеют приоритет над вашими конфигами.</p>
  <div class="help-table-wrap"><table class="help-table">
    <thead><tr><th>CLI</th><th>Аргументы brigd</th><th>Что это значит</th></tr></thead>
    <tbody>
      <tr><td>Claude Code</td><td><code>claude -p --permission-mode default</code>; список <code>--allowedTools</code> только для собственных MCP-инструментов brigd</td><td>В режиме печати CLI не может задать вопрос: правка файла или команда без allow-правила отклоняется, brigd видит отказ и завершает запуск блокировкой</td></tr>
      <tr><td>Codex</td><td><code>codex exec --sandbox workspace-write</code>, политика подтверждений <code>on-request</code>, сеть внутри песочницы включена</td><td>Внутри рабочей папки Codex правит файлы и запускает команды без вопросов; действия вне папки отклоняются, одобрить их некому</td></tr>
    </tbody>
  </table></div>
  <p>Поэтому для Codex настраивать нечего, а для Claude Code нужны allow-правила. Значение <code>permissions.defaultMode</code> в настройках Claude Code не поможет: флаг <code>--permission-mode</code> на командной строке сильнее. Ответ в карточке brigd тоже не является разрешением: карточка принимает уточнения по задаче, а не системные подтверждения CLI.</p>
</section>

<section class="help-section" aria-labelledby="guide-claude-title">
  <h2 id="guide-claude-title">Claude Code</h2>
  <h3>Где хранятся правила</h3>
  <p>Claude Code читает правила из нескольких файлов. Для запусков brigd важно, какие из них видны внутри рабочей папки запуска: новые запуски идут в отдельном Git worktree, который создаётся из коммита.</p>
  <div class="help-table-wrap"><table class="help-table">
    <thead><tr><th>Файл</th><th>Область</th><th>Виден в запусках brigd</th></tr></thead>
    <tbody>
      <tr><td><code>~/.claude/settings.json</code></td><td>Пользователь, все проекты</td><td>Да. Это домашняя папка того пользователя Linux, от которого запущен brigd и выполнен вход в CLI. В контейнере это том <code>trackt-cli-home</code></td></tr>
      <tr><td><code>.claude/settings.json</code> в репозитории проекта</td><td>Проект, файл коммитится</td><td>Да, если файл закоммичен</td></tr>
      <tr><td><code>.claude/settings.local.json</code></td><td>Проект, файл не коммитится</td><td>Нет: в worktree попадают только закоммиченные файлы</td></tr>
    </tbody>
  </table></div>
  <p>Если brigd правит собственный репозиторий, подойдёт только пользовательский файл: папка <code>.claude/</code> в нём добавлена в <code>.gitignore</code>.</p>

  <h3>Какие правила нужны</h3>
  <p>Минимальный набор для проекта на Bun. Кнопка «Настроить разрешения Claude Code» дописывает именно блок <code>allow</code>; остальные ключи файла, например <code>model</code> или <code>theme</code>, остаются как есть.</p>
  {@render codeBlock('settings', settingsExample, 'Правила разрешений Claude Code')}
  <ul>
    <li><strong>Edit и Write</strong> разрешают правки файлов. Чтобы ограничить область, укажите путь относительно корня проекта: <code>Edit(src/**)</code>, <code>Write(docs/**)</code>.</li>
    <li><strong>Bash(bun test:*)</strong> разрешает команды, начинающиеся с <code>bun test</code>. Перечисляйте только проверенные команды проекта. <code>bun install</code> нужен потому, что worktree запуска создаётся без <code>node_modules</code>.</li>
    <li><strong>Другие стеки.</strong> Замените команды, например <code>Bash(python -m pytest:*)</code> или <code>Bash(make test:*)</code>.</li>
    <li><strong>deny сильнее allow.</strong> Сюда удобно добавить файлы с секретами и команды, которые агент не должен выполнять ни при каких условиях.</li>
    <li><strong>Bash без скобок</strong> разрешит любые команды. Для ночи это удобно, но тогда агента ограничивают только песочница Claude Code, если она у вас включена, и текст задачи.</li>
  </ul>
  <p>Правила читаются при каждом старте процесса CLI: текущие процессы продолжают работать по старым, новые запуски и продолжения сессий получают новые. В контейнере файл правится внутри него:</p>
  {@render codeBlock('container', containerEdit, 'Команда для правки файла в контейнере')}

  <h3>Через интерфейс Claude Code</h3>
  <p>Вместо редактирования файла откройте <code>claude</code> в папке проекта, введите <code>/permissions</code> и добавьте те же правила. При выборе области сохранения берите пользовательские настройки: правила локальной области проекта попадают в <code>settings.local.json</code> и в запусках brigd не действуют.</p>

  <h3>Проверка</h3>
  <ol>
    <li>Создайте в brigd ручную задачу для работника с Claude Code: «Добавь комментарий в начало файла README.md и запусти bun test».</li>
    <li>Дождитесь завершения. Статус <strong>Завершено</strong> и строка «Применяются штатные правила разрешений CLI» в логах запуска означают, что правил достаточно.</li>
    <li>Статус <strong>Заблокировано</strong> с текстом про native permission approval означает, что какого-то правила не хватает. Какое именно действие отклонено, видно в самой сессии: папки запусков лежат в <code>data/workspaces/</code> рядом с базой, выполните в папке запуска <code>claude --resume &lt;ID сессии&gt;</code>; ID показан в истории запусков карточки.</li>
  </ol>
  <div class="help-note"><Icon name="alert" size={17} /><span>Не вводите в карточку brigd пароли и не пытайтесь «разрешить» действие комментарием: это не работает по замыслу.</span></div>
</section>

<section class="help-section" aria-labelledby="guide-codex-title">
  <h2 id="guide-codex-title">Codex</h2>
  <p>brigd запускает <code>codex exec</code> с песочницей <code>workspace-write</code>, политикой подтверждений <code>on-request</code> и включённой сетью. Внутри рабочей папки это даёт правки файлов, тесты, локальные серверы и установку пакетов без единого вопроса. Настройки <code>sandbox_mode</code> и <code>approval_policy</code> из <code>~/.codex/config.toml</code> на запуски brigd не влияют: аргументы командной строки сильнее. Кнопка «Настроить разрешения Codex» дописывает в этот файл те же параметры: <code>sandbox_mode = "workspace-write"</code>, <code>approval_policy = "on-request"</code> и <code>network_access = true</code> в таблице <code>sandbox_workspace_write</code>. Остальные ключи и комментарии сохраняются, прежний файл копируется в <code>config.toml.bak</code>. Так интерактивный <code>codex</code> в тех же папках ведёт себя одинаково с запусками brigd.</p>
  <p>Автоматически отклоняются и настройками не чинятся: запись вне рабочей папки и действия, для которых Codex запрашивает эскалацию. Если задача требует такого, вынесите действие в команды проверки brigd или выполните его вручную.</p>
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
