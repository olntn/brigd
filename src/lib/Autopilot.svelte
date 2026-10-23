<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { AUTOPILOT_FAILURE_LIMIT, AUTOPILOT_STOP_REASONS, defaultAutopilotUntil } from './autopilot';
  import { TASK_STATUS_LABELS } from './status';
  import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, TASK_PRIORITY_LABELS } from './priority';
  import type { AutopilotInput, AutopilotOverview, AutopilotSettings, Run, Task, TaskStatus } from './types';

  let { tasks, settings, checksRequired, notify, onopen, onchanged, onsettings }: {
    tasks: Task[];
    settings: AutopilotSettings | null;
    checksRequired: boolean;
    notify: (message: string, type?: 'success' | 'error') => void;
    onopen: (task: Task) => void;
    onchanged: (task: Task) => void;
    onsettings: (section: 'autopilot' | 'permissions') => void;
  } = $props();
  let overview = $state<AutopilotOverview | null>(null);
  let loading = $state(true);
  let error = $state('');
  let formError = $state('');
  let pending = $state<string | null>(null);
  let limited = $state(true);
  let untilInput = $state(toInput(defaultAutopilotUntil()));
  let sequence = 0;
  let reading = false;
  let alive = true;
  let formInitialized = false;
  let queueList = $state<HTMLOListElement>();
  let dragId = $state<string | null>(null);
  let dropTarget = $state<{ id: string; zone: 'before' | 'after' } | null>(null);
  let checksConfigured = $derived(!checksRequired || !!settings?.integrationChecks?.length);
  let deferred = $derived(tasks.filter(task => task.schedule === 'auto' && task.paused && task.archivedAt === null && !task.hasCompletedRun));
  // Archived cards leave the report the same way they leave the board.
  let attempts = $derived((overview?.attempts ?? []).filter(run => taskOf(run)?.archivedAt == null));
  let archivedAttempts = $derived((overview?.attempts.length ?? 0) - attempts.length);
  let summary = $derived.by(() => {
    const counts = { done: 0, waiting: 0, failed: 0, merge: 0, active: 0 };
    for (const run of attempts) {
      const status = outcome(run);
      if (status === 'completed') counts.done++;
      else if (status === 'waiting_input') counts.waiting++;
      else if (['failed', 'blocked', 'cancelled', 'interrupted'].includes(status)) counts.failed++;
      else if (status.startsWith('merge_')) counts.merge++;
      else counts.active++;
    }
    return counts;
  });

  // Hoisted declarations: the state initializer above runs before any const below is defined.
  function pad(value: number) { return String(value).padStart(2, '0'); }
  function toInput(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
  const dateTime = (timestamp: number | null) => timestamp === null ? '—' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(timestamp);
  const shortPath = (path: string) => { const parts = path.replace(/\\/g, '/').split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; };
  const taskOf = (run: Run) => tasks.find(task => task.id === run.taskId) ?? null;
  const priorityRank = (task: Task) => TASK_PRIORITIES.indexOf(task.priority);
  /** Pool tasks of the same priority: a task moves only among them. */
  const samePriority = (task: Task) => (overview?.pool ?? []).filter(item => item.priority === task.priority);
  const openLabel = (task: Task) => `Открыть: ${task.title}${task.priority === DEFAULT_TASK_PRIORITY ? '' : `, приоритет ${TASK_PRIORITY_LABELS[task.priority].toLowerCase()}`}`;
  /** The task's current status covers the merge and the integrator; the run alone is the fallback for a deleted task. */
  const outcome = (run: Run): TaskStatus => taskOf(run)?.status ?? run.status;
  const message = (failure: unknown) => failure instanceof TypeError
    ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
    : failure instanceof Error ? failure.message : 'Не удалось сохранить изменения. Попробуйте ещё раз.';

  function statusLine(state: AutopilotOverview): string {
    if (state.enabled) {
      const window = state.until !== null ? `до ${dateTime(state.until)}` : 'без ограничения по времени';
      return `Работает ${window}, с ${dateTime(state.startedAt)}.${state.failures ? ` Ошибок подряд: ${state.failures} из ${AUTOPILOT_FAILURE_LIMIT}.` : ''}`;
    }
    if (state.stoppedAt !== null && state.stopReason) return `Остановлен ${dateTime(state.stoppedAt)}: ${AUTOPILOT_STOP_REASONS[state.stopReason]}.`;
    return 'Включите перед уходом: задачи из очереди будут запускаться в пределах лимитов из настроек «Параллельность», а результаты по одному проходить проверку и слияние.';
  }

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: options?.method ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
    let result;
    try { result = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
    if (!response.ok) throw new Error(result.error || `Ошибка запроса (${response.status})`);
    return result as T;
  }

  function apply(result: AutopilotOverview) {
    overview = result;
    error = '';
    loading = false;
    if (formInitialized) return;
    // Mirror the saved stop time once; later edits belong to the person.
    formInitialized = true;
    if (result.enabled) { limited = result.until !== null; if (result.until !== null) untilInput = toInput(new Date(result.until)); }
  }

  async function load(force = false) {
    if (reading || dragId || (pending && !force)) return;
    reading = true;
    const readSequence = ++sequence;
    try {
      const result = await request<AutopilotOverview>('/api/autopilot');
      if (!alive || readSequence !== sequence) return;
      apply(result);
    } catch (failure) {
      if (alive && readSequence === sequence) { error = message(failure); loading = false; }
    } finally { reading = false; }
  }

  onMount(() => {
    void load();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; sequence++; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  });

  async function save(input: AutopilotInput, success: string) {
    if (pending) return;
    pending = 'switch';
    sequence++;
    formError = '';
    try {
      const result = await request<AutopilotOverview>('/api/autopilot', { method: 'PATCH', body: JSON.stringify(input) });
      if (!alive) return;
      apply(result);
      notify(success);
    } catch (failure) { if (alive) formError = message(failure); }
    finally { if (alive) pending = null; }
  }

  function enable(event: SubmitEvent) {
    event.preventDefault();
    if (!checksConfigured) { formError = 'Сначала задайте BRIGD_INTEGRATION_CHECKS в настройках автопилота.'; return; }
    let until: number | null = null;
    if (limited) {
      until = untilInput ? new Date(untilInput).getTime() : Number.NaN;
      if (!Number.isFinite(until)) { formError = 'Укажите время остановки или снимите ограничение.'; return; }
      if (until <= Date.now()) { formError = 'Время остановки уже прошло.'; return; }
    }
    void save({ enabled: true, until }, overview?.enabled ? 'Время остановки обновлено' : 'Автопилот включён');
  }

  async function setPaused(task: Task, paused: boolean) {
    if (pending) return;
    pending = task.id;
    sequence++;
    try {
      const saved = await request<Task>(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ paused }) });
      if (!alive) return;
      onchanged(saved);
      notify(paused ? 'Задача отложена: автопилот её не возьмёт' : 'Задача возвращена в очередь');
      await load(true);
    } catch (failure) { if (alive) notify(message(failure), 'error'); }
    finally { if (alive) pending = null; }
  }

  /** Places a pool task right before another one of its priority, or last among them with null; the autopilot claims the queue from the top. */
  async function move(task: Task, beforeId: string | null, focus = false) {
    if (pending || !overview) return;
    const previous = overview;
    const pool = previous.pool.filter(item => item.id !== task.id);
    const index = beforeId === null ? pool.length : pool.findIndex(item => item.id === beforeId);
    if (index < 0) return;
    pool.splice(index, 0, task);
    // The stable sort keeps each priority's own order, so a task placed last ends up last among its priority.
    pool.sort((left, right) => priorityRank(left) - priorityRank(right));
    if (pool.every((item, position) => item.id === previous.pool[position]?.id)) return;
    pending = task.id;
    sequence++;
    overview = { ...previous, pool };
    if (focus) { await tick(); queueList?.querySelector<HTMLElement>(`[data-queue-handle="${CSS.escape(task.id)}"]`)?.focus(); }
    try {
      const result = await request<AutopilotOverview>(`/api/tasks/${encodeURIComponent(task.id)}/queue`, { method: 'POST', body: JSON.stringify({ beforeTaskId: beforeId }) });
      if (!alive) return;
      apply(result);
    } catch (failure) {
      if (!alive) return;
      overview = previous;
      notify(message(failure), 'error');
    } finally { if (alive) pending = null; }
  }
  function handleKey(event: KeyboardEvent, task: Task) {
    if (!overview || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const group = samePriority(task), index = group.findIndex(item => item.id === task.id);
    if (event.key === 'ArrowUp' && index > 0) void move(task, group[index - 1]!.id, true);
    if (event.key === 'ArrowDown' && index >= 0 && index < group.length - 1) void move(task, group[index + 2]?.id ?? null, true);
  }
  function dragStart(event: DragEvent, id: string) {
    if (pending) { event.preventDefault(); return; }
    dragId = id;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(event: DragEvent, id: string) {
    if (!dragId) return;
    const pool = overview?.pool ?? [];
    // A task cannot be dropped among tasks of another priority; the browser shows that the drop is not allowed.
    if (pool.find(item => item.id === id)?.priority !== pool.find(item => item.id === dragId)?.priority) { dropTarget = null; return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropTarget = dragId === id ? null : { id, zone: event.clientY - rect.top < rect.height / 2 ? 'before' : 'after' };
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    const task = overview?.pool.find(item => item.id === dragId), target = dropTarget;
    dragId = null;
    dropTarget = null;
    if (!overview || !task || !target) return;
    const rest = samePriority(task).filter(item => item.id !== task.id);
    const index = rest.findIndex(item => item.id === target.id);
    if (index < 0) return;
    void move(task, rest[index + (target.zone === 'after' ? 1 : 0)]?.id ?? null);
  }
  function dragEnd() { dragId = null; dropTarget = null; }
</script>

<section class="page-heading">
  <div><h1 tabindex="-1">Автопилот</h1><p>Разбирает очередь задач, пока вас нет за компьютером: берёт следующую задачу, когда освобождается место, и отправляет результат на проверку и слияние.</p></div>
</section>
{#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={() => { void load(true); }}>Повторить</button></div>{/if}
{#if loading && !overview}
  <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />Загружаем автопилот…</div>
{:else if overview}
  <section class="autopilot-status" class:is-enabled={overview.enabled} aria-label="Состояние автопилота" aria-busy={pending === 'switch'}>
    <div class="autopilot-status-main">
      <span class="autopilot-status-icon"><Icon name={overview.enabled ? 'moon' : 'pause'} size={22} /></span>
      <div><strong>{overview.enabled ? 'Включён' : 'Выключен'}</strong><span>{statusLine(overview)}</span></div>
    </div>
    <form class="autopilot-form" onsubmit={enable}>
      <label class="autopilot-limit"><input type="checkbox" bind:checked={limited} disabled={!!pending} /><span>Остановить в</span></label>
      <input type="datetime-local" aria-label="Время остановки" bind:value={untilInput} disabled={!!pending || !limited} />
      {#if overview.enabled}
        <button type="submit" class="button secondary" disabled={!!pending || !checksConfigured}><Icon name="check" size={15} />Обновить время</button>
        <button type="button" class="button secondary danger-hover" disabled={!!pending} onclick={() => { void save({ enabled: false, until: null }, 'Автопилот выключен. Начатые запуски доработают.'); }}><Icon name="stop" size={14} />Выключить автопилот</button>
      {:else}
        <button type="submit" class="button primary" disabled={!!pending || !checksConfigured}><Icon name={pending === 'switch' ? 'refresh' : 'moon'} size={15} class={pending === 'switch' ? 'spin' : ''} />Включить автопилот</button>
      {/if}
    </form>
    {#if !checksConfigured}<p class="autopilot-help autopilot-form-error" role="status">Сначала задайте BRIGD_INTEGRATION_CHECKS: <button type="button" class="inline-link" onclick={() => onsettings('autopilot')}>открыть настройки автопилота</button>. Без команд проверки запуск недоступен.</p>{/if}
    {#if formError}<div class="form-error autopilot-form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
  </section>

  <section class="autopilot-section" aria-label="Очередь автопилота">
    <h2>Очередь <span class="autopilot-count">{overview.pool.length}</span></h2>
    <p class="autopilot-help">Задачи с режимом «Автопилот»: первой запускается верхняя. Сначала идут задачи с приоритетом «Критический», затем «Высокий», «Обычный» и «Низкий». Перетащите задачу, чтобы изменить порядок среди задач того же приоритета, или нажимайте ↑ и ↓ на значке перемещения; чтобы поднять задачу выше, повысьте её приоритет в форме задачи. Новые задачи встают в конец своего приоритета. Задача занятого репозитория пропускается, пока он занят. Задача, которую автопилот уже брал в этой сессии, второй раз не запускается.</p>
    {#if overview.pool.length}
      <ol class="autopilot-list" bind:this={queueList}>
        {#each overview.pool as task, index (task.id)}
          <li class="autopilot-row autopilot-queue-row" class:dragging={dragId === task.id} class:drop-before={dropTarget?.id === task.id && dropTarget.zone === 'before'} class:drop-after={dropTarget?.id === task.id && dropTarget.zone === 'after'} aria-busy={pending === task.id} draggable={!pending} ondragstart={(event) => dragStart(event, task.id)} ondragend={dragEnd} ondragover={(event) => dragOver(event, task.id)} ondrop={drop}>
            <button type="button" class="autopilot-handle" data-queue-handle={task.id} aria-label={`Переместить: ${task.title}, место ${index + 1} из ${overview.pool.length}`} aria-keyshortcuts="ArrowUp ArrowDown" title="Перетащите или нажмите ↑ и ↓, чтобы изменить порядок среди задач того же приоритета" onkeydown={(event) => handleKey(event, task)}><Icon name="grip" size={15} /><span class="autopilot-position">{index + 1}</span></button>
            <button class="autopilot-task" onclick={() => onopen(task)} aria-label={openLabel(task)}><strong>{task.title}</strong><small>{#if task.priority !== DEFAULT_TASK_PRIORITY}<span class="priority-badge priority-{task.priority}">{TASK_PRIORITY_LABELS[task.priority]}</span>{/if}{shortPath(task.cwd)}{#if task.worker}{' · '}{task.worker.name}{/if}</small></button>
            <span class="status-badge status-{task.status}"><span class="status-dot"></span>{TASK_STATUS_LABELS[task.status]}</span>
            <button class="button secondary" disabled={!!pending} onclick={() => setPaused(task, true)} aria-label={'Отложить: ' + task.title}><Icon name="pause" size={14} />Отложить</button>
          </li>
        {/each}
      </ol>
    {:else}
      <div class="no-results autopilot-empty"><span class="empty-icon"><Icon name="inbox" size={27} /></span><h3>Очередь пуста</h3><p>В форме задачи выберите «Автопилот» в разделе «Когда запускать», и задача появится здесь.</p></div>
    {/if}
    {#if deferred.length}
      <h3 class="autopilot-subheading">Отложены</h3>
      <ul class="autopilot-list">
        {#each deferred as task (task.id)}
          <li class="autopilot-row" aria-busy={pending === task.id}>
            <span class="autopilot-position"><Icon name="pause" size={13} /></span>
            <button class="autopilot-task" onclick={() => onopen(task)} aria-label={openLabel(task)}><strong>{task.title}</strong><small>{#if task.priority !== DEFAULT_TASK_PRIORITY}<span class="priority-badge priority-{task.priority}">{TASK_PRIORITY_LABELS[task.priority]}</span>{/if}{shortPath(task.cwd)}{#if task.worker}{' · '}{task.worker.name}{/if}</small></button>
            <span class="status-badge status-{task.status}"><span class="status-dot"></span>{TASK_STATUS_LABELS[task.status]}</span>
            <button class="button secondary" disabled={!!pending} onclick={() => setPaused(task, false)} aria-label={'Вернуть в очередь: ' + task.title}><Icon name="play" size={14} />Вернуть в очередь</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="autopilot-section" aria-label="Итоги сессии автопилота">
    <h2>Итоги сессии</h2>
    {#if overview.startedAt === null}
      <p class="autopilot-help">Автопилот ещё не включали. После первой сессии здесь будет список взятых задач и их результаты.</p>
    {:else}
      <p class="autopilot-help">С {dateTime(overview.startedAt)}{#if overview.stoppedAt !== null} по {dateTime(overview.stoppedAt)}{/if}. Готово: {summary.done} · Ждут ответа: {summary.waiting} · Ошибки и блокировки: {summary.failed} · Проблемы слияния: {summary.merge} · В работе: {summary.active}.{#if archivedAttempts} Задачи из архива не показаны: {archivedAttempts}.{/if}</p>
      {#if attempts.length}
        <ul class="autopilot-list">
          {#each attempts as run (run.id)}
            {@const task = taskOf(run)}
            {@const status = outcome(run)}
            <li class="autopilot-row">
              <span class="autopilot-position"><Icon name="play" size={13} /></span>
              {#if task}
                <button class="autopilot-task" onclick={() => onopen(task)} aria-label={'Открыть: ' + task.title}><strong>{task.title}</strong><small>Запуск {dateTime(run.startedAt)}{#if run.summary}{' · '}{run.summary}{:else if run.error}{' · '}{run.error}{/if}</small></button>
              {:else}
                <span class="autopilot-task"><strong>Задача недоступна</strong><small>Запуск {dateTime(run.startedAt)}</small></span>
              {/if}
              <span class="status-badge status-{status}"><span class="status-dot"></span>{TASK_STATUS_LABELS[status]}</span>
              <span></span>
            </li>
          {/each}
        </ul>
      {:else if !archivedAttempts}
        <p class="autopilot-help">Автопилот пока не взял ни одной задачи в этой сессии.</p>
      {/if}
    {/if}
  </section>

  <section class="autopilot-section" aria-label="Перед ночной сессией">
    <h2>Перед тем как уйти</h2>
    <ul class="autopilot-checklist">
      <li><strong>Разрешения CLI.</strong> Полный доступ Codex и Claude Code включён по умолчанию: подтверждения и песочницы CLI отключены. Если выбрали ограниченный режим, заранее настройте правила Claude Code и учтите песочницу Codex. Общий переключатель и инструкция — в <button type="button" class="inline-link" aria-label="Открыть раздел Разрешения" onclick={() => onsettings('permissions')}>настройках, раздел «Разрешения»</button>.</li>
      <li><strong>Чистая целевая ветка.</strong> Если ветка открыта в рабочей папке, перенос результата требует чистого состояния Git. Закоммитьте или уберите незакоммиченные правки.</li>
      <li><strong>Команды проверки.</strong> Задайте BRIGD_INTEGRATION_CHECKS в <button type="button" class="inline-link" onclick={() => onsettings('autopilot')}>настройках автопилота</button>. В рабочем режиме без этой настройки автопилот и зависимые процессы недоступны.</li>
      <li><strong>Компьютер не должен уснуть.</strong> Очередь разбирается, только пока запущен сервер brigd.</li>
      <li><strong>Вопросы ждут до утра.</strong> Задача со статусом «Нужен ответ» остаётся занятой, автопилот переходит к следующей. Общая инструкция «принимай разумные решения вместо вопросов» уменьшит число таких остановок.</li>
      <li><strong>Предохранитель.</strong> После {AUTOPILOT_FAILURE_LIMIT} ошибок или блокировок подряд автопилот выключается сам, чтобы не прогнать всю очередь впустую. Перезапуск сервиса тоже выключает его.</li>
    </ul>
  </section>
{/if}
