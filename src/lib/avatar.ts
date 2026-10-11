export const AVATAR_SIZE = 256;
export interface AvatarCrop { zoom: number; x: number; y: number; }
export const defaultAvatarCrop = (): AvatarCrop => ({ zoom: 1, x: .5, y: .5 });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The visible square in source coordinates, including padding when zoomed out. */
export function avatarCropRect(width: number, height: number, crop: AvatarCrop) {
  const size = Math.min(width, height) / clamp(crop.zoom, .25, 3);
  return { x: (width - size) * clamp(crop.x, 0, 1), y: (height - size) * clamp(crop.y, 0, 1), size };
}

export function drawAvatar(canvas: HTMLCanvasElement, image: ImageBitmap, crop: AvatarCrop) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Не удалось обработать изображение в этом браузере.');
  const rect = avatarCropRect(image.width, image.height, crop);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  const scale = canvas.width / rect.size;
  context.drawImage(image, -rect.x * scale, -rect.y * scale, image.width * scale, image.height * scale);
}

export async function exportAvatar(image: ImageBitmap, crop: AvatarCrop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  drawAvatar(canvas, image, crop);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .85));
  if (!blob || blob.size > 256 * 1024) throw new Error('Не удалось уменьшить изображение до 256 КБ. Выберите другое.');
  return blob;
}
