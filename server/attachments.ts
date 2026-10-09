import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from './errors';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_PREVIEW_MAX_BYTES } from '../src/lib/attachments';

sharp.cache({ memory: 16, files: 0, items: 16 });
sharp.concurrency(2);
let decoding = 0;
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 16_384;
const payloads = new WeakMap<PreparedAttachment, { data: Uint8Array; preview: Uint8Array | null }>();
export interface PreparedAttachment {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly previewable: boolean;
}
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENT_MAX_COUNT || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id))) {
    throw new AppError(`Вложения: выберите не больше ${ATTACHMENT_MAX_COUNT} файлов`);
  }
  if (new Set(value).size !== value.length) throw new AppError('Вложения не должны повторяться');
  return value as string[];
}
export function attachmentName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || Buffer.byteLength(value, 'utf8') > 255 || /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new AppError('Некорректное имя вложения: используйте имя файла без пути и управляющих символов');
  }
  const name = value.normalize('NFC').trim();
  if (Buffer.byteLength(name, 'utf8') > 255 || name === '.' || name === '..') throw new AppError('Некорректное имя вложения');
  return name;
}
function safeMime(value: string): string {
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : 'application/octet-stream';
}
function rasterMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}
/** Decoder input is always bytes, never a path, URL, SVG, or user-selected sharp options. */
export async function prepareAttachment(bytes: Uint8Array, claimedMime: string, name: string): Promise<PreparedAttachment> {
  const cleanName = attachmentName(name);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new AppError('Вложение должно быть не больше 10 МиБ', 413);
  const data = Buffer.from(bytes); // No caller-owned alias survives preparation.
  let mime = safeMime(claimedMime), preview: Uint8Array | null = null;
  const raster = rasterMime(data);
  if (raster) {
    mime = raster;
    if (decoding >= 2) throw new AppError('Предпросмотр занят. Повторите загрузку через несколько секунд.', 429);
    decoding++;
    try {
      const options = { limitInputPixels: MAX_PIXELS, failOn: 'warning' as const, animated: false, pages: 1, sequentialRead: true };
      const metadata = await sharp(data, options).metadata();
      const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' }[raster];
      if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * (metadata.pageHeight ?? metadata.height) > MAX_PIXELS) throw new Error('Unsafe dimensions');
      // Decode exactly the first frame and re-encode. Raw originals are never used as tool image content.
      for (const size of [1024, 768, 512, 320, 192]) {
        const result = await sharp(data, options).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).timeout({ seconds: 8 }).toBuffer();
        if (result.length <= ATTACHMENT_PREVIEW_MAX_BYTES) { preview = result; break; }
      }
    } catch { /* Malformed/oversized images remain available as download-only originals. */ } finally { decoding--; }
  } else if (mime.startsWith('image/')) {
    // A claimed image type never earns inline rendering without matching safe raster magic.
    mime = 'application/octet-stream';
  }
  const prepared: PreparedAttachment = Object.freeze({ name: cleanName, mime, size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), previewable: !!preview });
  payloads.set(prepared, { data, preview });
  return prepared;
}
/** Only payloads made by this module are admissible; external fields cannot forge a preview. */
export function preparedAttachmentPayload(prepared: PreparedAttachment): { data: Uint8Array; preview: Uint8Array | null } {
  const value = payloads.get(prepared);
  if (!value) throw new AppError('Вложение не подготовлено');
  return { data: new Uint8Array(value.data), preview: value.preview ? new Uint8Array(value.preview) : null };
}
export function attachmentDisposition(name: string, inline = false): string {
  const fallback = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
