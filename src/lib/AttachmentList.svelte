<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { Attachment } from './types';
  let { attachments = [], taskId, label = 'Вложения', author }: { attachments?: Attachment[]; taskId: string; label?: string; author?: (attachment: Attachment) => string } = $props();
  let preview = $state<Attachment | null>(null);
  let failed = $state<string[]>([]);
  let previewFailed = $state(false);
  let dialog: HTMLDialogElement;
  // The lightbox shows the server's re-encoded full-size view and falls back to the small preview when that render fails.
  let source = $state<'view' | 'preview'>('view');
  let natural = $state<{ width: number; height: number } | null>(null);
  let scale = $state(1);
  let fitted = $state(true);
  let dragging = $state(false);
  let viewport = $state<HTMLDivElement | null>(null);
  const MIN_SCALE = 0.05, MAX_SCALE = 8, STEP = 1.25;
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { scale: number; distance: number; scrollLeft: number; scrollTop: number; x: number; y: number; moved: boolean; image: boolean } | null = null;
  function url(file: Attachment, variant: 'preview' | 'view' | 'download' = 'preview') { return `/api/tasks/${encodeURIComponent(file.taskId ?? taskId)}/attachments/${encodeURIComponent(file.id)}?${variant}=1`; }
  function sizeLabel(size: number) { return size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ` : `${(size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`; }
  function provenance(file: Attachment) { return [author?.(file) ?? (file.source === 'agent' ? 'Агент' : 'Вы'), file.runId ? `запуск ${file.runId.slice(0, 6)}` : '', file.stepIndex != null ? `этап ${file.stepIndex + 1}` : ''].filter(Boolean).join(' · '); }
  async function open(file: Attachment) {
    preview = file; previewFailed = false; source = 'view'; natural = null; scale = 1; fitted = true; dragging = false; gesture = null; pointers.clear();
    await tick();
    dialog.showModal();
  }
  function close() { dialog.close(); preview = null; }
  function fitScale() {
    if (!natural || !viewport) return 1;
    return Math.max(MIN_SCALE, Math.min((viewport.offsetWidth - 32) / natural.width, (viewport.offsetHeight - 32) / natural.height, 1));
  }
  function loaded(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    natural = { width: image.naturalWidth, height: image.naturalHeight };
    if (fitted) scale = fitScale();
  }
  function failedToLoad() { if (source === 'view') source = 'preview'; else previewFailed = true; }
  function fit() { fitted = true; scale = fitScale(); }
  /** Rescales around an anchor point so the pixel under the cursor or pinch stays in place. */
  async function zoomTo(next: number, anchor?: { x: number; y: number }) {
    if (!natural || !viewport) return;
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    const rect = viewport.getBoundingClientRect();
    const x = anchor ? anchor.x - rect.left : viewport.clientWidth / 2;
    const y = anchor ? anchor.y - rect.top : viewport.clientHeight / 2;
    const offset = (length: number, client: number) => Math.max(0, (client - length) / 2);
    const pointX = (viewport.scrollLeft + x - offset(natural.width * scale, viewport.clientWidth)) / scale;
    const pointY = (viewport.scrollTop + y - offset(natural.height * scale, viewport.clientHeight)) / scale;
    scale = next; fitted = false;
    await tick();
    if (!viewport || !natural) return;
    viewport.scrollLeft = pointX * next + offset(natural.width * next, viewport.clientWidth) - x;
    viewport.scrollTop = pointY * next + offset(natural.height * next, viewport.clientHeight) - y;
  }
  function toggleZoom(anchor: { x: number; y: number }) {
    const fitting = fitScale();
    if (Math.abs(scale - fitting) < 0.01) zoomTo(fitting < 1 ? 1 : 2, anchor); else fit();
  }
  function wheel(event: WheelEvent) {
    if (!natural) return;
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
    zoomTo(scale * Math.exp(-delta / 400), { x: event.clientX, y: event.clientY });
  }
  function spread() { const [first, second] = [...pointers.values()]; return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0; }
  function center() { const points = [...pointers.values()]; return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }; }
  function pointerDown(event: PointerEvent) {
    if (!natural || !viewport || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture = { scale, distance: spread(), scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, x: event.clientX, y: event.clientY, moved: pointers.size > 1, image: event.target instanceof HTMLImageElement };
    dragging = true;
  }
  function pointerMove(event: PointerEvent) {
    if (!gesture || !viewport || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      const distance = spread();
      if (gesture.distance > 0 && distance > 0) zoomTo(gesture.scale * distance / gesture.distance, center());
      gesture.moved = true;
      return;
    }
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 4) gesture.moved = true;
    viewport.scrollLeft = gesture.scrollLeft - dx;
    viewport.scrollTop = gesture.scrollTop - dy;
  }
  function pointerUp(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    const remaining = [...pointers.values()][0];
    if (remaining && gesture && viewport) { gesture = { ...gesture, x: remaining.x, y: remaining.y, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, moved: true }; return; }
    const tapped = event.type === 'pointerup' && gesture?.image && !gesture.moved;
    gesture = null; dragging = false;
    if (tapped) toggleZoom({ x: event.clientX, y: event.clientY });
  }
  function key(event: KeyboardEvent) {
    if (!natural || event.ctrlKey || event.metaKey || event.altKey) return;
    const actions: Record<string, () => void> = { '+': () => zoomTo(scale * STEP), '=': () => zoomTo(scale * STEP), '-': () => zoomTo(scale / STEP), '_': () => zoomTo(scale / STEP), '0': fit, '1': () => zoomTo(1) };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }
  $effect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => { if (fitted && natural) scale = fitScale(); });
    observer.observe(viewport);
    return () => observer.disconnect();
  });
</script>

{#if attachments.length}
  <ul class="attachment-list" aria-label={label}>{#each attachments as file (file.id)}
    <li class="attachment-item">
      {#if file.previewable}<button class="attachment-thumbnail" type="button" onclick={() => open(file)} aria-label={`Открыть изображение: ${file.name}`}>{#if !failed.includes(file.id)}<img src={url(file)} alt="" loading="lazy" onerror={() => failed = [...failed, file.id]} />{:else}<Icon name="folder" size={22} />{/if}</button>{:else}<span class="attachment-file-icon"><Icon name="folder" size={22} /></span>{/if}
      <div class="attachment-info"><span class="attachment-name">{file.name}</span><span class="attachment-meta">{sizeLabel(file.size)} · {provenance(file)}</span>{#if failed.includes(file.id)}<span class="attachment-error">Предпросмотр недоступен. Файл можно скачать.</span>{/if}</div>
      <a class="attachment-download" href={url(file, 'download')} download={file.name} aria-label={`Скачать: ${file.name}`}><Icon name="down" size={16} /><span>Скачать</span></a>
    </li>
  {/each}</ul>
{/if}

<dialog class="attachment-preview-dialog" bind:this={dialog} aria-label={preview?.name ?? 'Просмотр изображения'} oncancel={(event) => { event.preventDefault(); close(); }} onkeydown={key} onclick={(event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>
  {#if preview}
    <header class="attachment-preview-header">
      <div class="attachment-preview-title"><strong>{preview.name}</strong><span>{sizeLabel(preview.size)} · {provenance(preview)}{#if !natural && !previewFailed} · Загрузка…{:else if source === 'preview' && natural} · уменьшенная копия{/if}</span></div>
      <div class="attachment-zoom" role="group" aria-label="Масштаб">
        <button class="icon-button" type="button" aria-label="Уменьшить" disabled={!natural || scale <= MIN_SCALE} onclick={() => zoomTo(scale / STEP)}><Icon name="minus" size={18} /></button>
        <button class="attachment-zoom-level" type="button" aria-label="Исходный размер" title="Показать в масштабе 100%" disabled={!natural} onclick={() => zoomTo(1)}>{natural ? `${Math.round(scale * 100)}%` : '…'}</button>
        <button class="icon-button" type="button" aria-label="Увеличить" disabled={!natural || scale >= MAX_SCALE} onclick={() => zoomTo(scale * STEP)}><Icon name="plus" size={18} /></button>
        <button class="icon-button" type="button" aria-label="Вписать в окно" aria-pressed={fitted} disabled={!natural} onclick={fit}><Icon name="fit" size={18} /></button>
      </div>
      <button class="icon-button attachment-preview-close" type="button" aria-label="Закрыть просмотр" onclick={close}><Icon name="close" size={21} /></button>
    </header>
    <!-- svelte-ignore a11y_no_static_element_interactions (Pointer and wheel gestures only supplement the zoom buttons and dialog keys.) -->
    <div class="attachment-preview-body" class:zoomed={natural && !fitted} class:dragging bind:this={viewport} onwheel={wheel} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}>
      {#if previewFailed}<p role="alert">Не удалось показать изображение. Скачайте файл, чтобы открыть его на компьютере.</p>
      {:else}<img src={url(preview, source)} alt={preview.name} draggable="false" class:pending={!natural} style:width={natural ? `${natural.width * scale}px` : undefined} style:height={natural ? `${natural.height * scale}px` : undefined} onload={loaded} onerror={failedToLoad} />{/if}
    </div>
    <footer>
      <a class="button secondary" href={url(preview, source)} target="_blank" rel="noopener"><Icon name="external" size={16} />Открыть в новом окне</a>
      <a class="button secondary" href={url(preview, 'download')} download={preview.name}><Icon name="down" size={16} />Скачать оригинал</a>
    </footer>
  {/if}
</dialog>
