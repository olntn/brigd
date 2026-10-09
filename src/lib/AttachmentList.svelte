<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { Attachment } from './types';
  let { attachments = [], taskId, label = 'Вложения', author }: { attachments?: Attachment[]; taskId: string; label?: string; author?: (attachment: Attachment) => string } = $props();
  let preview = $state<Attachment | null>(null);
  let failed = $state<string[]>([]);
  let previewFailed = $state(false);
  let dialog: HTMLDialogElement;
  function url(file: Attachment, download = false) { return `/api/tasks/${encodeURIComponent(file.taskId ?? taskId)}/attachments/${encodeURIComponent(file.id)}${download ? '?download=1' : '?preview=1'}`; }
  function sizeLabel(size: number) { return size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ` : `${(size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`; }
  function provenance(file: Attachment) { return [author?.(file) ?? (file.source === 'agent' ? 'Агент' : 'Вы'), file.runId ? `запуск ${file.runId.slice(0, 6)}` : '', file.stepIndex != null ? `этап ${file.stepIndex + 1}` : ''].filter(Boolean).join(' · '); }
  async function open(file: Attachment) { preview = file; previewFailed = false; await tick(); dialog.showModal(); }
  function close() { dialog.close(); preview = null; }
</script>

{#if attachments.length}
  <ul class="attachment-list" aria-label={label}>{#each attachments as file (file.id)}
    <li class="attachment-item">
      {#if file.previewable}<button class="attachment-thumbnail" type="button" onclick={() => open(file)} aria-label={`Открыть изображение: ${file.name}`}>{#if !failed.includes(file.id)}<img src={url(file)} alt="" loading="lazy" onerror={() => failed = [...failed, file.id]} />{:else}<Icon name="folder" size={22} />{/if}</button>{:else}<span class="attachment-file-icon"><Icon name="folder" size={22} /></span>{/if}
      <div class="attachment-info"><span class="attachment-name">{file.name}</span><span class="attachment-meta">{sizeLabel(file.size)} · {provenance(file)}</span>{#if failed.includes(file.id)}<span class="attachment-error">Предпросмотр недоступен. Файл можно скачать.</span>{/if}</div>
      <a class="attachment-download" href={url(file, true)} download={file.name} aria-label={`Скачать: ${file.name}`}><Icon name="down" size={16} /><span>Скачать</span></a>
    </li>
  {/each}</ul>
{/if}

<dialog class="attachment-preview-dialog" bind:this={dialog} aria-label={preview?.name ?? 'Просмотр изображения'} oncancel={(event) => { event.preventDefault(); close(); }} onclick={(event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>
  {#if preview}<header class="attachment-preview-header"><div><strong>{preview.name}</strong><span>{sizeLabel(preview.size)} · {provenance(preview)}</span></div><button class="icon-button" type="button" aria-label="Закрыть просмотр" onclick={close}><Icon name="close" size={21} /></button></header><div class="attachment-preview-body">{#if previewFailed}<p role="alert">Не удалось показать изображение. Скачайте файл, чтобы открыть его на компьютере.</p>{:else}<img src={url(preview)} alt={preview.name} onerror={() => previewFailed = true} />{/if}</div><footer><a class="button secondary" href={url(preview, true)} download={preview.name}><Icon name="down" size={16} />Скачать оригинал</a></footer>{/if}
</dialog>
