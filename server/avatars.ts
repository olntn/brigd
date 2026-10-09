import { AppError } from './store';

export const MAX_AVATAR_BYTES = 256 * 1024;
const MAX_DIMENSION = 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const invalid = () => new AppError('Не удалось прочитать изображение аватара');

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngSize(b: Buffer): [number, number] {
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw invalid();
  let offset = 8, width = 0, height = 0, image = false;
  while (offset + 12 <= b.length) {
    const length = b.readUInt32BE(offset);
    if (length > b.length - offset - 12) throw invalid();
    const kind = b.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (crc32(b.subarray(offset + 4, end)) !== b.readUInt32BE(end)) throw invalid();
    if (offset === 8) {
      if (kind !== 'IHDR' || length !== 13) throw invalid();
      width = b.readUInt32BE(offset + 8); height = b.readUInt32BE(offset + 12);
    } else if (kind === 'IHDR') throw invalid();
    if (kind === 'acTL') throw new AppError('Используйте неподвижный аватар');
    if (kind === 'IDAT' && length > 0) image = true;
    if (kind === 'IEND') {
      if (length !== 0 || !image || end + 4 !== b.length) throw invalid();
      return [width, height];
    }
    offset = end + 4;
  }
  throw invalid();
}

function jpegSize(b: Buffer): [number, number] {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) throw invalid();
  let i = 2, width = 0, height = 0;
  while (i + 3 < b.length) {
    if (b[i++] !== 0xff) break;
    while (b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === 0xd9 || marker === undefined) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > b.length) break;
    const length = b.readUInt16BE(i);
    if (length < 2 || i + length > b.length) break;
    if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) throw invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      if (width || height) throw invalid();
      height = b.readUInt16BE(i + 3); width = b.readUInt16BE(i + 5);
    }
    if (marker === 0xda) {
      if (!width || !height || length < 6 || i + length >= b.length - 2) break;
      return [width, height];
    }
    i += length;
  }
  throw invalid();
}

function webpSize(b: Buffer): [number, number] {
  if (b.length < 25 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) throw invalid();
  let i = 12, width = 0, height = 0, canvas: [number, number] | null = null, image = false;
  while (i + 8 <= b.length) {
    const kind = b.toString('ascii', i, i + 4), length = b.readUInt32LE(i + 4), data = i + 8;
    const next = data + length + (length % 2);
    if (length > b.length - data || next > b.length) throw invalid();
    if (kind === 'ANIM' || kind === 'ANMF') throw new AppError('Используйте неподвижный аватар');
    if (kind === 'VP8X') {
      if (i !== 12 || length !== 10 || (b[data]! & 2)) throw invalid();
      canvas = [b.readUIntLE(data + 4, 3) + 1, b.readUIntLE(data + 7, 3) + 1];
    } else if (kind === 'VP8 ') {
      if (image || length < 11 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) throw invalid();
      width = b.readUInt16LE(data + 6) & 0x3fff; height = b.readUInt16LE(data + 8) & 0x3fff; image = true;
    } else if (kind === 'VP8L') {
      if (image || length < 6 || b[data] !== 0x2f) throw invalid();
      width = 1 + (b.readUInt32LE(data + 1) & 0x3fff); height = 1 + ((b.readUInt32LE(data + 1) >>> 14) & 0x3fff); image = true;
    }
    i = next;
  }
  if (i !== b.length || !image || (canvas && (canvas[0] !== width || canvas[1] !== height))) throw invalid();
  return [width, height];
}

/** Bounded raster containers only. Browser decoding/resizing is an additional client check. */
export function validateAvatar(data: Uint8Array, mime: string): void {
  if (!MIME_TYPES.has(mime)) throw new AppError('Аватар: нужен PNG, JPEG или WebP', 415);
  if (!data.length || data.length > MAX_AVATAR_BYTES) throw new AppError('Аватар должен быть не больше 256 КиБ', 413);
  const b = Buffer.from(data);
  const [width, height] = mime === 'image/png' ? pngSize(b) : mime === 'image/jpeg' ? jpegSize(b) : webpSize(b);
  if (!width || !height) throw invalid();
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new AppError('Аватар должен быть не больше 1024 × 1024 пикселей');
}
