<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { formatBytes, plural } from './format';
  import type { StorageCleanupResult, StorageEntry, StorageOverview, StorageReason } from './types';

  let { active, busy = $bindable(false) }: { active: boolean; busy?: boolean } = $props();
  const reasonLabels: Record<StorageReason, string> = {
    active: 'Запуск выполняется, ожидает очереди или ответа', interrupted: 'Запуск или слияние прерваны', conflict: 'Конфликт слияния',
    failed: 'Ошибка запуска или проверки', unmerged: 'Результат ещё не перенесён в целевую ветку', submodules: 'Содержит репозитории подмодулей Git',
    moved: 'Путь в базе отличается от каталога', foreign: 'Создано не brigd',
    merged: 'Результат перенесён в целевую ветку', cancelled: 'Запуск отменён', stale: 'Кандидат слияния устарел', unknown: 'Нет записи в базе brigd',
  };
  const hints: Partial<Record<StorageReason, string>> = {
    active: 'Дождитесь завершения или ответьте агенту в карточке задачи.',
    interrupted: 'Подтвердите в карточке, что прежние процессы остановлены, затем продолжите, повторите или отмените запуск.',
    conflict: 'Поручите конфликт Интегратору или повторите слияние в карточке задачи.',
    failed: 'Повторите запуск или проверку в карточке задачи либо отмените запуск. Кандидаты неудачных проверок можно удалить по галочке в подтверждении очистки.',
    unmerged: 'Нажмите «Повторить проверку и слияние» в карточке задачи или отмените слияние.',
    submodules: 'Коммиты подмодулей хранятся только здесь. Перенесите их в репозитории подмодулей и удалите папку вручную.',
    moved: 'Папка записана по другому пути: база перенесена или изменён BRIGD_WORKSPACES_DIR. Проверьте настройку; brigd не трогает такие папки.',
    foreign: 'Файлы, ссылки и папки, которые создал не brigd, не удаляются и не учитываются в объёме.',
  };
  const kindLabels = { worktree: 'worktree', candidate: 'кандидат слияния', unknown: 'папка' } as const;
  let overview = $state<StorageOverview | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let actionError = $state('');
  let status = $state('');
  let confirming = $state(false);
  let includeCandidates = $state(false);
  let cleanupButton = $state<HTMLButtonElement>();
  let confirmButton = $state<HTMLButtonElement>();
  let requested = false;
  let readController: AbortController | null = null;

  $effect(() => {
    if (active && !requested) {
      requested = true;
      untrack(() => { void load(); });
    }
  });
  onDestroy(() => { readController?.abort(); });

  function message(error: unknown, fallback: string) {
    return error instanceof TypeError ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
      : error instanceof Error ? error.message : fallback;
  }
  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, options);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
    if (!response.ok) throw new Error(body.error || `Ошибка запроса (${response.status})`);
    return body as T;
  }
  async function load() {
    if (busy) return;
    readController?.abort();
    const controller = new AbortController();
    readController = controller;
    loading = true;
    loadError = '';
    status = '';
    actionError = '';
    try {
      const next = await request<StorageOverview>('/api/settings/storage', { signal: controller.signal });
      if (controller.signal.aborted) return;
      overview = next;
    } catch (error) {
      if (!controller.signal.aborted) loadError = message(error, 'Не удалось подсчитать занятое место. Попробуйте ещё раз.');
    } finally {
      if (readController === controller) { loading = false; readController = null; }
    }
  }
  async function confirmCleanup() {
    if (busy || loading || !selectable.length && !reclaimableBranches.length) return;
    confirming = true;
    includeCandidates = false;
    actionError = '';
    status = '';
    await tick();
    confirmButton?.focus();
  }
  async function cancelCleanup() {
    if (busy) return;
    confirming = false;
    await tick();
    cleanupButton?.focus();
  }
  async function cleanup() {
    if (busy || loading) return;
    busy = true;
    actionError = '';
    status = '';
    try {
      const outcome = await request<StorageCleanupResult>('/api/settings/storage/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(includeCandidates ? { includeCandidates: true } : {}),
      });
      overview = outcome.overview;
      confirming = false;
      const removed = [
        outcome.removed ? `${plural(outcome.removed, 'Удалена', 'Удалены', 'Удалено')} ${count(outcome.removed)}.` : '',
        outcome.removedBranches ? `${plural(outcome.removedBranches, 'Удалена', 'Удалены', 'Удалено')} ${branchCount(outcome.removedBranches)}.` : '',
      ].filter(Boolean);
      status = removed.length ? `${removed.join(' ')} Освобождено ${formatBytes(outcome.freedBytes)}.`
        : outcome.failures.length ? '' : 'Нечего удалять: все папки и ветки ещё нужны.';
      if (outcome.failures.length) actionError = `Не удалось удалить: ${outcome.failures.map(failure => `${failure.path} — ${failure.error}`).join('; ')}`;
    } catch (error) { actionError = message(error, 'Не удалось очистить хранилище. Попробуйте ещё раз.'); }
    finally { busy = false; }
    await tick();
    cleanupButton?.focus();
  }
  const count = (value: number) => `${value.toLocaleString('ru-RU')} ${plural(value, 'папка', 'папки', 'папок')}`;
  const accusative = (value: number) => `${value.toLocaleString('ru-RU')} ${plural(value, 'папку', 'папки', 'папок')}`;
  const branchCount = (value: number) => `${value.toLocaleString('ru-RU')} ${plural(value, 'ветка', 'ветки', 'веток')}`;
  const accusativeBranches = (value: number) => `${value.toLocaleString('ru-RU')} ${plural(value, 'ветку', 'ветки', 'веток')}`;
  function dateLabel(timestamp: number, includeSeconds = false) {
    return new Date(timestamp).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: includeSeconds ? '2-digit' : undefined });
  }
  interface Group { reason: StorageReason; retained: boolean; entries: StorageEntry[]; bytes: number; }
  function grouped(entries: StorageEntry[]): Group[] {
    const groups = new Map<StorageReason, Group>();
    for (const entry of entries) {
      const group = groups.get(entry.reason) ?? { reason: entry.reason, retained: entry.retained, entries: [], bytes: 0 };
      group.entries.push(entry); group.bytes += entry.bytes;
      groups.set(entry.reason, group);
    }
    return [...groups.values()].sort((left, right) => Number(left.retained) - Number(right.retained) || right.bytes - left.bytes);
  }
  function entryTitle(entry: StorageEntry) {
    const run = entry.runId ? `Запуск ${entry.runId.slice(0, 8)}${entry.startedAt ? ` · ${dateLabel(entry.startedAt)}` : ''}` : '';
    return entry.taskTitle ? `${entry.taskTitle}${run ? ` · ${run}` : ''}` : run || (entry.path.split(/[\\/]/).pop() ?? entry.path);
  }
  const sum = (entries: StorageEntry[]) => entries.reduce((total, entry) => total + entry.bytes, 0);
  let reclaimable = $derived(overview?.entries.filter(entry => !entry.retained) ?? []);
  let optional = $derived(overview?.entries.filter(entry => entry.retained && entry.optional) ?? []);
  let selectable = $derived([...reclaimable, ...optional]);
  let reclaimableBranches = $derived(overview?.reclaimableBranches ?? []);
  let selectedBytes = $derived(sum(reclaimable) + (includeCandidates ? sum(optional) : 0));
  let selectedCount = $derived(reclaimable.length + (includeCandidates ? optional.length : 0));
  let selectedDescription = $derived(reclaimableBranches.length
    ? `${selectedCount ? `${accusative(selectedCount)} и ` : ''}${accusativeBranches(reclaimableBranches.length)}`
    : accusative(selectedCount));
  let cleanupLabel = $derived(reclaimableBranches.length ? selectedCount ? 'Удалить папки и ветки' : 'Удалить ветки' : 'Удалить папки');
  let groups = $derived(overview ? grouped(overview.entries) : []);
</script>

<section class="storage-settings model-settings" aria-labelledby="storage-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="folder" size={22} /><div><h3 id="storage-settings-title">Хранилище</h3><p>Рабочие папки запусков (Git worktree) и кандидаты слияния. После переноса результата в целевую ветку ненужная папка запуска и его ветка удаляются автоматически. Используемые worktree, папки с подмодулями и ветки с неперенесёнными изменениями сохраняются, как и папки активных, прерванных, конфликтных, завершившихся ошибкой или блокировкой и ещё не перенесённых запусков.</p></div></div>
  {#if loadError}<div class="model-load-error" role="alert"><span>{loadError}</span><button type="button" class="button secondary" disabled={busy || loading} onclick={() => { void load(); }}>Повторить подсчёт</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>Подсчитываем занятое место…</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>Очищаем хранилище… Дождитесь ответа сервера, прежде чем закрывать настройки.</span></p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if actionError}<div class="form-error storage-action-error" role="alert"><Icon name="alert" size={17} /><span>{actionError}</span></div>{/if}
  {#if overview && !overview.available}
    <p class="model-catalog-note">{overview.note ?? 'В этом режиме отдельные worktree не создаются, поэтому очищать нечего. В рабочем режиме здесь показано место, занятое папками запусков.'}{#if overview.root} Каталог: <code>{overview.root}</code>.{/if}</p>
  {:else if overview}
    <dl class="storage-summary" aria-label="Занятое место">
      <div><dt>Занято</dt><dd>{formatBytes(overview.totalBytes)}</dd></div>
      <div><dt>Можно освободить</dt><dd>{formatBytes(overview.reclaimableBytes)}</dd></div>
      <div><dt>Ещё нужно</dt><dd>{formatBytes(overview.retainedBytes)}</dd></div>
    </dl>
    <p class="model-catalog-note storage-root">Каталог: <code>{overview.root}</code>{#if overview.scannedAt} · подсчитано {dateLabel(overview.scannedAt, true)}{/if}</p>
    <div class="backup-toolbar storage-toolbar">
      <button bind:this={cleanupButton} type="button" class="button secondary danger-hover" disabled={busy || loading || !selectable.length && !reclaimableBranches.length || confirming} onclick={confirmCleanup}><Icon name="trash" size={16} />Очистить</button>
      <button type="button" class="button secondary" disabled={busy || loading} onclick={() => { void load(); }}><Icon name="refresh" size={16} />Пересчитать</button>
    </div>
    {#if confirming}
      <div class="model-delete-confirm storage-confirm">
        <p>Удалить {selectedDescription} и освободить {formatBytes(selectedBytes)}? Папки отменённых запусков и уже перенесённых результатов, устаревшие кандидаты слияния и папки запусков без записи в базе будут удалены без возможности восстановления. Незакоммиченная работа отменённых запусков будет потеряна. Ветки <code>brigd/run-…</code> удаляются только для уже перенесённых результатов, если они не изменились после переноса и больше нигде не используются. Остальные ветки и история задач останутся. Папки активных, прерванных, конфликтных, завершившихся ошибкой или блокировкой и ещё не перенесённых запусков не трогаются.</p>
        {#if optional.length}<label class="storage-option"><input type="checkbox" bind:checked={includeCandidates} disabled={busy} /><span>Также удалить кандидаты неудачных проверок и заблокированных переносов ({count(optional.length)}, {formatBytes(sum(optional))}). Папки самих запусков останутся для повтора.</span></label>{/if}
        <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelCleanup}>Отмена очистки</button><button bind:this={confirmButton} type="button" class="button danger" disabled={busy || loading || !selectedCount && !reclaimableBranches.length} onclick={cleanup}>{busy ? 'Удаляем…' : cleanupLabel}</button></div>
      </div>
    {/if}
    {#if !overview.entries.length}<p class="model-catalog-empty storage-empty">Рабочих папок в этом каталоге нет.</p>{/if}
    {#if reclaimableBranches.length}
      <section class="storage-branches" aria-labelledby="storage-branches-title">
        <h4 id="storage-branches-title">Ветки после слияния</h4>
        <p>Можно удалить {accusativeBranches(reclaimableBranches.length)}. Их коммиты сохранены в целевых ветках; при продолжении задачи ветка запуска создастся заново. Объём выше относится к рабочим папкам.</p>
        <ul>{#each reclaimableBranches as branch}<li><code>{branch}</code></li>{/each}</ul>
      </section>
    {/if}
    {#if groups.length}
      <ul class="storage-groups" aria-label="Папки по состоянию">
        {#each groups as group (group.reason)}
          <li class="storage-group" class:reclaimable={!group.retained}>
            <div class="storage-group-heading"><Icon name={group.retained ? 'lock' : 'trash'} size={15} /><h4>{reasonLabels[group.reason]}</h4><span class="storage-group-meta">{count(group.entries.length)} · {group.reason === 'foreign' ? 'объём не учитывается' : formatBytes(group.bytes)} · {group.retained ? group.entries.some(entry => entry.optional) ? 'сохраняется, кандидаты — по галочке' : 'сохраняется' : 'будет удалена'}</span></div>
            {#if hints[group.reason]}<p class="storage-group-hint">{hints[group.reason]}</p>{/if}
            <ul class="storage-entries">
              {#each group.entries as entry (entry.path)}
                <li class="storage-entry"><span class="storage-entry-title">{entryTitle(entry)}</span><span class="storage-entry-meta">{kindLabels[entry.kind]}{#if group.reason !== 'foreign'} · {formatBytes(entry.bytes)}{/if}{#if entry.optional} · удаляется по галочке{/if}</span><code class="storage-entry-path" title={entry.path}>{entry.path}</code></li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .storage-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 18px 0 0; padding: 0; min-width: 0; }
  .storage-summary > div { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--subtle); min-width: 0; }
  .storage-summary dt { font-size: .77rem; color: var(--muted); }
  .storage-summary dd { margin: 0; font-size: 1.05rem; font-weight: 500; color: var(--secondary); overflow-wrap: anywhere; }
  .storage-root code { font-size: .8rem; overflow-wrap: anywhere; }
  .storage-toolbar { margin-top: 16px; }
  .storage-confirm { margin-top: 14px; }
  .storage-option { display: flex; align-items: flex-start; gap: 8px; font-size: .85rem; line-height: 1.6; color: var(--secondary); }
  .storage-option input { margin-top: 4px; flex: none; }
  .storage-groups { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 12px; min-width: 0; }
  .storage-group { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); min-width: 0; }
  .storage-group.reclaimable { border-style: dashed; }
  .storage-group-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: .88rem; color: var(--secondary); min-width: 0; }
  .storage-group-heading h4 { margin: 0; font-size: .88rem; font-weight: 600; }
  .storage-group-heading :global(svg) { color: var(--accent-text); flex: none; }
  .storage-group-meta { font-size: .77rem; color: var(--muted); }
  .storage-group-hint { margin: 0; font-size: .8rem; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }
  .storage-entries { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; min-width: 0; }
  .storage-entry { display: grid; gap: 2px; font-size: .8rem; line-height: 1.6; min-width: 0; }
  .storage-entry-title { color: var(--secondary); overflow-wrap: anywhere; }
  .storage-entry-meta { font-size: .75rem; color: var(--muted); }
  .storage-entry-path { font-size: .72rem; color: var(--muted); overflow-wrap: anywhere; }
  .storage-empty { margin-top: 16px; }
  .storage-branches { margin-top: 16px; padding: 12px 14px; border: 1px dashed var(--line); border-radius: var(--radius-md); }
  .storage-branches h4 { margin: 0 0 6px; font-size: .88rem; font-weight: 600; color: var(--secondary); }
  .storage-branches p { margin: 0; font-size: .8rem; line-height: 1.6; color: var(--muted); }
  .storage-branches ul { margin: 8px 0 0; padding-left: 20px; font-size: .8rem; line-height: 1.6; }
  .storage-branches code { overflow-wrap: anywhere; }
</style>
