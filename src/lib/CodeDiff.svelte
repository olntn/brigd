<script lang="ts">
  import Icon from './Icon.svelte';
  import { diffLines } from './diff-lines';
  import { TASK_STATUS_LABELS } from './status';
  import type { Run } from './types';
  import type { CodeDiffFile, RunCodeDiff } from './code-diff';

  let { runs }: { runs: Run[] } = $props();
  let selectedId = $state('');
  let diff = $state<RunCodeDiff | null>(null);
  let loading = $state(false);
  let error = $state('');
  let refreshNonce = $state(0);
  let loadedRunId = '';
  const selectedRun = $derived(runs.find(run => run.id === selectedId) ?? runs[0] ?? null);
  const runId = $derived(selectedRun?.id ?? '');
  const revision = $derived(selectedRun ? `${selectedRun.updatedAt}:${selectedRun.status}:${selectedRun.turn}:${selectedRun.integration?.updatedAt ?? ''}` : '');
  const live = $derived(!!selectedRun && ['preparing', 'running', 'cancelling', 'waiting_input', 'interrupted'].includes(selectedRun.status));
  const files = $derived(diff?.files.map(file => ({ ...file, lines: diffLines(file.patch) })) ?? []);
  const statusLabels: Record<CodeDiffFile['status'], string> = {
    added: 'Добавлен', modified: 'Изменён', deleted: 'Удалён', renamed: 'Переименован', typechanged: 'Изменён тип',
  };
  const dateTime = (time: number) => new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(time);

  $effect(() => {
    // Fetch only while this tab is mounted. Abort and ignore replies from a previous selection.
    const id = runId;
    void revision; void refreshNonce;
    if (!id) { diff = null; error = ''; loading = false; loadedRunId = ''; return; }
    const controller = new AbortController();
    if (loadedRunId !== id) { diff = null; loadedRunId = id; }
    loading = true; error = '';
    void (async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}/diff`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Ошибка загрузки (${response.status})`);
        if (!controller.signal.aborted) diff = result as RunCodeDiff;
      } catch (cause) {
        if (!controller.signal.aborted) error = cause instanceof Error ? cause.message : 'Не удалось загрузить изменения.';
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshNonce++;
    }, 5000);
    return () => clearInterval(timer);
  });
</script>

{#if runs.length}
  <div class="diff-toolbar">
    <label class="diff-run-picker"><span>Запуск для просмотра изменений</span>
      <select aria-label="Запуск для просмотра изменений" value={runId} onchange={(event) => selectedId = event.currentTarget.value}>
        {#each runs as run (run.id)}
          <option value={run.id}>{run.followup ? 'Дополнительный запрос' : run.reconcile ? 'Разрешение конфликта' : 'Запуск'} {run.id.slice(0, 6)} · {dateTime(run.startedAt)} · {TASK_STATUS_LABELS[run.status]}</option>
        {/each}
      </select>
    </label>
    <button class="button secondary" disabled={loading} onclick={() => refreshNonce++} aria-label="Обновить diff" title="Обновить diff"><Icon name="refresh" size={15} class={loading ? 'spin' : ''} /></button>
  </div>
{/if}

{#if !runs.length}
  <div class="conversation-empty"><Icon name="code" size={25} /><strong>Запусков пока нет</strong><p>Изменения кода появятся здесь после работы агента.</p></div>
{:else if loading && !diff}
  <p class="diff-message" role="status"><Icon name="refresh" size={17} class="spin" />Загружаем изменения…</p>
{:else if error}
  <div class="diff-error" role="alert"><p>{error}</p><button class="button secondary" onclick={() => refreshNonce++}>Повторить загрузку</button></div>
{:else if diff?.state === 'unavailable'}
  <div class="conversation-empty"><Icon name="code" size={25} /><strong>Diff недоступен</strong><p>{diff.reason || 'Не удалось получить изменения этого запуска.'}</p></div>
{:else if diff}
  {#if diff.live}<p class="diff-note">Текущие изменения запуска. Обновляются во время работы агента.</p>{/if}
  {#if diff.truncated}<p class="diff-warning" role="status">Показана только часть изменений: diff превышает лимит отображения.</p>{/if}
  {#if diff.files.length}
    <div class="diff-overview"><strong>Файлов: {diff.files.length}</strong><span class="diff-added" aria-label={`Добавлено строк: ${diff.additions}`}>+{diff.additions}</span><span class="diff-deleted" aria-label={`Удалено строк: ${diff.deletions}`}>−{diff.deletions}</span></div>
    <div class="diff-files">
      {#each files as file, index (file.path)}
        <details class="diff-file" open={index < 3}>
          <summary><Icon name="chevron" size={14} class="diff-chevron" /><span class="diff-file-name"><code>{file.path}</code>{#if file.oldPath && file.oldPath !== file.path}<small>Ранее: {file.oldPath}</small>{/if}</span><span class="diff-file-status">{statusLabels[file.status]}</span><span class="diff-added">+{file.additions}</span><span class="diff-deleted">−{file.deletions}</span></summary>
          {#if file.binary}<p class="diff-file-note">Двоичный файл изменён. Текстовый diff недоступен.</p>
          {:else if file.lines.length}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll long code lines.) -->
            <div class="diff-scroll" role="region" aria-label={`Diff файла ${file.path}`} tabindex="0">
              <div class="diff-lines">
                {#each file.lines as line}
                  <div class="diff-line {line.kind}"><span class="diff-line-number" aria-hidden="true">{line.oldLine ?? ''}</span><span class="diff-line-number" aria-hidden="true">{line.newLine ?? ''}</span><span class="diff-marker" aria-hidden="true">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}</span><code class="diff-code">{line.text || ' '}</code></div>
                {/each}
              </div>
            </div>
          {:else if file.truncated}<p class="diff-file-note">Содержимое файла превышает лимит отображения.</p>
          {:else}<p class="diff-file-note">Содержимое файла не изменилось; обновлены его имя или свойства.</p>{/if}
          {#if file.truncated}<p class="diff-file-note">Diff этого файла показан не полностью.</p>{/if}
        </details>
      {/each}
    </div>
  {:else if !diff.truncated}
    <div class="conversation-empty"><Icon name="code" size={25} /><strong>Изменений кода нет</strong><p>В этом запуске файлы проекта не менялись.</p></div>
  {/if}
{/if}

<style>
  .diff-toolbar { display: flex; align-items: flex-end; gap: 9px; margin: 18px 0; min-width: 0; }
  .diff-run-picker { display: grid; gap: 7px; flex: 1; min-width: 0; color: var(--secondary); font-size: .85rem; }
  .diff-run-picker select { width: 100%; min-width: 0; padding: 9px; color: var(--text); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); text-overflow: ellipsis; }
  .diff-toolbar .button { padding: 10px; flex-shrink: 0; }
  .diff-message { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: .85rem; padding-block: 12px; }
  .diff-error { padding: 12px; border: 1px solid var(--error-line); background: var(--error-bg); border-radius: var(--radius-md); color: var(--error); font-size: .85rem; overflow-wrap: anywhere; }
  .diff-error p { margin: 0 0 12px; }
  .diff-note, .diff-warning, .diff-file-note { font-size: .85rem; line-height: 1.7; color: var(--muted); overflow-wrap: anywhere; }
  .diff-warning { padding: 10px; border: 1px solid var(--warning-line); border-radius: var(--radius-md); background: var(--warning-bg); color: var(--warning); }
  .diff-overview { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 18px 0 12px; font-size: .85rem; }
  .diff-overview strong { font-weight: 550; }
  .diff-added { color: var(--success); }
  .diff-deleted { color: var(--error); }
  .diff-files { display: grid; gap: 12px; min-width: 0; }
  .diff-file { border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; min-width: 0; }
  .diff-file summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; background: var(--subtle); cursor: pointer; list-style: none; font-size: .77rem; }
  .diff-file summary::-webkit-details-marker { display: none; }
  .diff-file-name { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
  .diff-file-name code { font-family: var(--font-mono); font-size: .85rem; color: var(--text); }
  .diff-file-name small { display: block; color: var(--muted); margin-top: 4px; }
  .diff-file-status { color: var(--muted); }
  .diff-file :global(.diff-chevron) { flex-shrink: 0; color: var(--muted); }
  .diff-file[open] :global(.diff-chevron) { transform: rotate(90deg); }
  .diff-file-note { margin: 12px; }
  .diff-scroll { overflow-x: auto; max-width: 100%; border-top: 1px solid var(--line); }
  .diff-lines { width: max-content; min-width: 100%; padding-block: 6px; }
  .diff-line { display: grid; grid-template-columns: 4ch 4ch 2ch minmax(0, 1fr); padding-right: 12px; font-family: var(--font-mono); font-size: .85rem; line-height: 1.8; white-space: pre; min-height: 1.8em; }
  .diff-line-number { padding-inline: 4px; color: var(--muted); text-align: right; user-select: none; font-size: .77rem; }
  .diff-marker { text-align: center; user-select: none; }
  .diff-code { font: inherit; tab-size: 4; }
  .diff-line.addition { background: var(--success-bg); }
  .diff-line.addition .diff-code, .diff-line.addition .diff-marker { color: var(--success); }
  .diff-line.deletion { background: var(--error-bg); }
  .diff-line.deletion .diff-code, .diff-line.deletion .diff-marker { color: var(--error); }
  .diff-line.hunk { background: var(--soft); color: var(--accent-text); }
  .diff-line.meta { color: var(--muted); }
</style>
