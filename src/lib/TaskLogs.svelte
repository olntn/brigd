<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import AttachmentList from './AttachmentList.svelte';
  import { followupStage } from './followups';
  import type { ActivityLog } from './activity';
  import type { Attachment, Run } from './types';

  let { logs, runs, taskId, author }: {
    logs: ActivityLog[]; runs: Run[]; taskId: string; author: (file: Attachment) => string;
  } = $props();

  const icons: Record<string, string> = { command: 'terminal', file: 'folder', tool: 'code', search: 'search', lifecycle: 'play', system: 'history' };
  const dateTime = (time: number) => new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(time);
  const failed = (entry: ActivityLog) => Boolean(entry.error?.trim()) || entry.summary.startsWith('Ошибка ') ||
    entry.details.includes('Состояние: завершено с ошибкой.');

  let copied = $state<string | null>(null);
  let copyFailed = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copyTimer));

  async function copyError(id: string, error: string) {
    copyFailed = null;
    copied = null;
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(error);
      copied = id;
      copyTimer = setTimeout(() => { copied = null; }, 2000);
    } catch { copyFailed = id; }
  }
</script>

<p class="activity-help">Действия работника и события запуска. Раскройте запись, чтобы увидеть подробности.</p>
<div class="task-logs">
  {#each logs as entry (entry.id)}
    {@const run = runs.find(run => run.id === entry.runId)}
    {@const step = entry.stepIndex != null ? run?.steps?.[entry.stepIndex] : null}
    {@const worker = step?.worker ?? run?.worker}
    <details class="task-log" class:has-error={failed(entry)}>
      <summary>
        <span class="log-icon"><Icon name={failed(entry) ? 'alert' : icons[entry.kind] ?? 'terminal'} size={16} /></span>
        <span class="log-heading"><strong>{entry.summary}</strong><span class="log-meta"><span>{worker?.name ?? (entry.kind === 'system' ? 'brigd' : run?.provider === 'claude' ? 'Claude Code' : run ? 'Codex' : 'Работник')}</span>{#if entry.stepIndex != null}<span>Этап {entry.stepIndex + 1}{#if step}: {step.title}{/if}</span>{:else if run?.followup && followupStage(run)}<span>Этап {followupStage(run)!.index + 1}</span>{/if}<time datetime={new Date(entry.createdAt).toISOString()}>{dateTime(entry.createdAt)}</time></span></span>
        <Icon name="chevron" size={15} class="log-chevron" />
      </summary>
      <div class="log-details">
        {#if run}<p class="log-run-reference">{run.followup ? 'Дополнительный запрос' : run.reconcile ? 'Разрешение конфликта' : 'Запуск'} {run.id.slice(0, 6)}</p>{/if}
        {#each entry.details as line}<p>{line}</p>{:else}<p>Дополнительные детали для этого события не сохранены.</p>{/each}
        {#if failed(entry)}
          <div class="log-error">
            <div class="log-error-heading"><strong>Ошибка</strong>{#if entry.error?.trim()}<button type="button" class="button secondary" onclick={() => copyError(entry.id, entry.error!)}><Icon name={copied === entry.id ? 'check' : 'code'} size={14} /><span aria-live="polite">{copied === entry.id ? 'Скопировано' : 'Копировать ошибку'}</span></button>{/if}</div>
            {#if entry.error?.trim()}<pre class="log-error-text" aria-label="Текст ошибки">{entry.error}</pre>{:else}<p>Текст ошибки не был сохранён. Для новых запусков он появится здесь.</p>{/if}
            {#if copyFailed === entry.id}<p class="log-copy-error" role="status">Не удалось скопировать. Выделите текст ошибки и скопируйте вручную.</p>{/if}
          </div>
        {/if}
        <AttachmentList attachments={entry.attachments ?? []} {taskId} label="Вложения события" {author} />
      </div>
    </details>
  {:else}
    <div class="conversation-empty"><Icon name="terminal" size={25} /><strong>Логов пока нет</strong><p>Во время работы здесь появятся действия работника и их результаты.</p></div>
  {/each}
</div>
