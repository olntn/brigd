<script lang="ts">
  import { onDestroy } from 'svelte';
  import { AVATAR_SIZE, avatarCropRect, defaultAvatarCrop, drawAvatar, exportAvatar, type AvatarCrop } from './avatar';

  let { image, crop = $bindable(defaultAvatarCrop()), disabled = false, onpreview, onbusy, onerror }: {
    image: ImageBitmap; crop?: AvatarCrop; disabled?: boolean;
    onpreview: (blob: Blob) => void; onbusy: (busy: boolean) => void; onerror: (message: string) => void;
  } = $props();
  let canvas = $state<HTMLCanvasElement>();
  let drag: { id: number; x: number; y: number; crop: AvatarCrop; displaySize: number } | null = null;
  let sequence = 0;
  const rect = $derived(avatarCropRect(image.width, image.height, crop));
  onDestroy(() => { sequence++; });

  $effect(() => {
    if (!canvas) return;
    const source = image;
    const selection = { ...crop };
    const current = ++sequence;
    onbusy(true);
    try { drawAvatar(canvas, source, selection); }
    catch (error) {
      onerror(error instanceof Error ? error.message : 'Не удалось подготовить аватар.');
      onbusy(false);
      return;
    }
    // Encode a separate canvas so a later drag cannot change this preview's pixels.
    void exportAvatar(source, selection).then(blob => {
      if (current !== sequence) return;
      onpreview(blob);
      onbusy(false);
    }).catch(error => {
      if (current !== sequence) return;
      onerror(error instanceof Error ? error.message : 'Не удалось подготовить аватар.');
      onbusy(false);
    });
  });

  function startDrag(event: PointerEvent) {
    if (disabled || event.button !== 0 || !canvas) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, crop: { ...crop }, displaySize: canvas.getBoundingClientRect().width };
    canvas.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId || disabled) return;
    const start = avatarCropRect(image.width, image.height, drag.crop);
    const units = start.size / drag.displaySize;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    crop = {
      ...crop,
      x: image.width !== start.size ? clamp(drag.crop.x - (event.clientX - drag.x) * units / (image.width - start.size)) : .5,
      y: image.height !== start.size ? clamp(drag.crop.y - (event.clientY - drag.y) * units / (image.height - start.size)) : .5,
    };
  }
  function stopDrag() { drag = null; }
</script>

<fieldset class="avatar-editor" disabled={disabled}>
  <legend>Размер и область аватара</legend>
  <div class="avatar-editor-layout">
    <canvas bind:this={canvas} width={AVATAR_SIZE} height={AVATAR_SIZE} aria-label="Предпросмотр области аватара" onpointerdown={startDrag} onpointermove={moveDrag} onpointerup={stopDrag} onpointercancel={stopDrag} onlostpointercapture={stopDrag}>Предпросмотр аватара. Для изменения области используйте ползунки ниже.</canvas>
    <div class="avatar-editor-controls">
      <label class="form-field"><span>Масштаб <output>{Math.round(crop.zoom * 100)}%</output></span><input aria-label="Масштаб аватара" type="range" min="0.25" max="3" step="0.01" bind:value={crop.zoom} /></label>
      <label class="form-field"><span>По горизонтали</span><input aria-label="Положение аватара по горизонтали" type="range" min="0" max="1" step="0.01" bind:value={crop.x} disabled={disabled || image.width === rect.size} /></label>
      <label class="form-field"><span>По вертикали</span><input aria-label="Положение аватара по вертикали" type="range" min="0" max="1" step="0.01" bind:value={crop.y} disabled={disabled || image.height === rect.size} /></label>
      <button type="button" class="button secondary" onclick={() => crop = defaultAvatarCrop()}>Сбросить кадрирование</button>
    </div>
  </div>
  <p class="worker-image-status">Перетащите изображение или используйте ползунки. Выбранная область сохранится как аватар 256 × 256.</p>
</fieldset>
