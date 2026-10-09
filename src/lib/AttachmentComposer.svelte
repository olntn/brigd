<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import type { Attachment } from './types';
  import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from './attachments';

  type DraftFile = { key: string; file?: File; attachment?: Attachment; error: string; uploading: boolean; preview?: string; previewFailed?: boolean };
  let { initial = [], label = 'Файлы', disabled = false, count = $bindable(0), uploading = $bindable(false), invalid = $bindable(false) }: {
    initial?: Attachment[]; label?: string; disabled?: boolean; count?: number; uploading?: boolean; invalid?: boolean;
  } = $props();
  // Each mounted composer owns its staging, even if an earlier request finishes after navigation.
  let rows = $state<DraftFile[]>(untrack(() => initial.map(attachment => ({ key: attachment.id, attachment, error: '', uploading: false }))));
  let error = $state('');
  let dragging = $state(false);
  let fileInput: HTMLInputElement;
  let alive = true;
  let leased = false;
  let queueRunning = false;
  const safeLocalImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
  const helpId = `attachment-help-${crypto.randomUUID()}`;
  $effect(() => { count = rows.length; uploading = rows.some(row => row.uploading || (!row.attachment && !row.error)); invalid = rows.some(row => !!row.error); });

  function sizeLabel(size: number) { return size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ` : `${(size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`; }
  async function discard(attachment: Attachment) {
    if (attachment.taskId) return;
    // A retry covers a transient connection failure. The server expires abandoned staging too.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const response = await fetch(`/api/uploads/${encodeURIComponent(attachment.id)}`, { method: 'DELETE', keepalive: true }); if (response.ok || response.status === 404 || response.status === 409) return; } catch { /* retry once */ }
    }
  }
  function previewUrl(row: DraftFile) {
    if (row.previewFailed) return undefined;
    return row.preview ?? (row.attachment?.previewable && row.attachment.taskId ? `/api/tasks/${encodeURIComponent(row.attachment.taskId)}/attachments/${encodeURIComponent(row.attachment.id)}?preview=1` : undefined);
  }
  function releasePreview(row: DraftFile) { if (row.preview) { URL.revokeObjectURL(row.preview); row.preview = undefined; } }
  function dispose(row: DraftFile) { releasePreview(row); if (row.attachment) void discard(row.attachment); }
  onDestroy(() => { alive = false; for (const row of rows) { releasePreview(row); if (!leased && row.attachment) void discard(row.attachment); } });

  export function prepareSubmission(): { attachmentIds: string[]; finish: (saved: boolean) => void } {
    if (leased || rows.some(row => row.uploading || !row.attachment || row.error)) throw new Error('Дождитесь загрузки файлов. Неудачные загрузки можно повторить или убрать.');
    leased = true;
    const submitted = [...rows];
    let finished = false;
    return { attachmentIds: submitted.map(row => row.attachment!.id), finish(saved: boolean) {
      if (finished) return;
      finished = true;
      leased = false;
      if (saved) {
        for (const row of submitted) releasePreview(row);
        if (alive) { rows = []; error = ''; }
      } else if (!alive) { for (const row of submitted) dispose(row); }
    } };
  }

  export function handlePaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || disabled || leased) return;
    event.stopPropagation();
    // Preserve a mixed clipboard's text; image-only pastes should not insert an empty line.
    if (!event.clipboardData?.getData('text/plain')) event.preventDefault();
    addFiles(files);
  }
  export function handleDrop(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.stopPropagation(); dragging = false;
    if (disabled || leased) return;
    addFiles([...event.dataTransfer.files]);
  }
  function dragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled || leased ? 'none' : 'copy';
    dragging = !disabled && !leased;
  }
  function addFiles(files: File[]) {
    if (!alive || disabled || leased) return;
    error = '';
    const available = Math.max(0, ATTACHMENT_MAX_COUNT - rows.length);
    if (files.length > available) { error = `Можно прикрепить до ${ATTACHMENT_MAX_COUNT} файлов. Добавлены первые ${available}.`; }
    const added = files.slice(0, available).map(file => ({ key: crypto.randomUUID(), file, error: file.size > ATTACHMENT_MAX_BYTES ? `Файл больше ${sizeLabel(ATTACHMENT_MAX_BYTES)}.` : '', uploading: false }));
    rows = [...rows, ...added];
    void uploadQueue();
  }
  async function uploadQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (alive) {
        const row = rows.find(item => item.file && !item.attachment && !item.error && !item.uploading);
        if (!row?.file) break;
        row.uploading = true;
        try {
          const response = await fetch(`/api/uploads?name=${encodeURIComponent(row.file.name || 'Вложение')}`, { method: 'POST', headers: { 'Content-Type': row.file.type || 'application/octet-stream' }, body: row.file });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error || `Не удалось загрузить файл (${response.status}).`);
          if (!result || typeof result.id !== 'string' || typeof result.name !== 'string' || typeof result.size !== 'number') throw new Error('Сервер вернул неожиданный ответ при загрузке файла.');
          const attachment = result as Attachment;
          if (!alive || !rows.some(item => item.key === row.key)) { void discard(attachment); continue; }
          row.attachment = attachment;
          if (attachment.previewable && safeLocalImages.has(attachment.mime)) row.preview = URL.createObjectURL(new Blob([row.file], { type: attachment.mime }));
        } catch (failure) {
          if (alive && rows.some(item => item.key === row.key)) row.error = failure instanceof Error ? failure.message : 'Не удалось загрузить файл. Повторите попытку.';
        } finally { if (alive) row.uploading = false; }
      }
    } finally { queueRunning = false; }
  }
  function remove(row: DraftFile) {
    if (disabled || leased) return;
    rows = rows.filter(item => item.key !== row.key); dispose(row); error = '';
  }
  function retry(row: DraftFile) {
    if (disabled || leased || !row.file || row.file.size > ATTACHMENT_MAX_BYTES) return;
    row.error = ''; void uploadQueue();
  }
</script>

<section class="attachment-composer" class:dragging aria-label={label} ondragover={dragOver} ondragleave={() => dragging = false} ondrop={handleDrop} onpaste={handlePaste}>
  <div class="attachment-composer-heading"><span>{label}{#if rows.length}<small>{rows.length}/{ATTACHMENT_MAX_COUNT}</small>{/if}</span><button class="attachment-add" type="button" disabled={disabled || rows.length >= ATTACHMENT_MAX_COUNT} onclick={() => fileInput.click()}><Icon name="plus" size={15} />Прикрепить файлы</button></div>
  <input bind:this={fileInput} class="sr-only" type="file" multiple tabindex="-1" aria-label={label} aria-describedby={helpId} disabled={disabled} onchange={(event) => { addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ''; }} />
  <p id={helpId} class="attachment-help">Перетащите файлы сюда или вставьте изображение из буфера. До {ATTACHMENT_MAX_COUNT} файлов, до {sizeLabel(ATTACHMENT_MAX_BYTES)} каждый.</p>
  {#if error}<p class="attachment-error" role="alert">{error}</p>{/if}
  {#if rows.length}<ul class="attachment-drafts">{#each rows as row (row.key)}
    <li class="attachment-draft" class:has-error={!!row.error}>
      <span class="attachment-draft-icon">{#if previewUrl(row)}<img src={previewUrl(row)} alt="" loading="lazy" onerror={() => row.previewFailed = true} />{:else}<Icon name={row.uploading ? 'refresh' : 'folder'} class={row.uploading ? 'spin' : ''} size={20} />{/if}</span>
      <div class="attachment-draft-info"><strong class="attachment-name">{row.attachment?.name ?? row.file?.name ?? 'Вложение'}</strong><span>{sizeLabel(row.attachment?.size ?? row.file?.size ?? 0)} · {row.uploading ? 'Загружается…' : row.error ? 'Не загружен' : row.attachment ? 'Прикреплён' : 'В очереди'}</span>{#if row.error}<p class="attachment-error" role="alert">{row.error}</p>{/if}</div>
      <div class="attachment-draft-actions">{#if row.error && row.file && row.file.size <= ATTACHMENT_MAX_BYTES}<button class="attachment-retry" type="button" onclick={() => retry(row)} disabled={disabled} aria-label={`Повторить загрузку: ${row.file.name}`}>Повторить</button>{/if}<button class="icon-button" type="button" onclick={() => remove(row)} disabled={disabled} aria-label={`Убрать файл: ${row.attachment?.name ?? row.file?.name}`}><Icon name="close" size={16} /></button></div>
    </li>
  {/each}</ul>{/if}
  <span class="sr-only" role="status" aria-live="polite">{uploading ? 'Файлы загружаются' : rows.length ? `Файлов: ${rows.length}` : ''}</span>
</section>
