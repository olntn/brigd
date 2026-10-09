<script lang="ts">
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
</script>

<p class="activity-help">Действия работника и события запуска. Раскройте запись, чтобы увидеть подробности.</p>
<div class="task-logs">
  {#each logs as entry (entry.id)}
    {@const run = runs.find(run => run.id === entry.runId)}
    {@const step = entry.stepIndex != null ? run?.steps?.[entry.stepIndex] : null}
    {@const worker = step?.worker ?? run?.worker}
    <details class="task-log">
      <summary>
        <span class="log-icon"><Icon name={icons[entry.kind] ?? 'terminal'} size={16} /></span>
        <span class="log-heading"><strong>{entry.summary}</strong><span class="log-meta"><span>{worker?.name ?? (entry.kind === 'system' ? 'brigd' : run?.provider === 'claude' ? 'Claude Code' : run ? 'Codex' : 'Работник')}</span>{#if entry.stepIndex != null}<span>Этап {entry.stepIndex + 1}{#if step}: {step.title}{/if}</span>{:else if run?.followup && followupStage(run)}<span>Этап {followupStage(run)!.index + 1}</span>{/if}<time datetime={new Date(entry.createdAt).toISOString()}>{dateTime(entry.createdAt)}</time></span></span>
        <Icon name="chevron" size={15} class="log-chevron" />
      </summary>
      <div class="log-details">
        {#if run}<p class="log-run-reference">{run.followup ? 'Дополнительный запрос' : 'Запуск'} {run.id.slice(0, 6)}</p>{/if}
        {#each entry.details as line}<p>{line}</p>{:else}<p>Дополнительные детали для этого события не сохранены.</p>{/each}
        <AttachmentList attachments={entry.attachments ?? []} {taskId} label="Вложения события" {author} />
      </div>
    </details>
  {:else}
    <div class="conversation-empty"><Icon name="terminal" size={25} /><strong>Логов пока нет</strong><p>Во время работы здесь появятся действия работника и их результаты.</p></div>
  {/each}
</div>
