export const TAG_NAME_LIMIT = 50;
export const TAG_COUNT_LIMIT = 100;
export const DEFAULT_TAG_COLOR = '#7764cf';
export const TAG_COLORS = [
  { name: 'Фиолетовый', value: DEFAULT_TAG_COLOR },
  { name: 'Синий', value: '#3b82f6' },
  { name: 'Голубой', value: '#0891b2' },
  { name: 'Зелёный', value: '#16a34a' },
  { name: 'Жёлтый', value: '#eab308' },
  { name: 'Оранжевый', value: '#ea580c' },
  { name: 'Красный', value: '#dc2626' },
  { name: 'Розовый', value: '#db2777' },
] as const;

/** Soften the chosen color while keeping white text readable on either theme. */
export function tagColorStyle(value?: string): string {
  const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_TAG_COLOR;
  const channels = [1, 3, 5].map((offset, index) => {
    const neutral = index === 2 ? 115 : 107;
    const channel = (parseInt(color.slice(offset, offset + 2), 16) * .55 + neutral * .45) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  const scale = Math.min(1, .175 / luminance);
  const rgb = channels.map(channel => {
    const scaled = channel * scale;
    return Math.round((scaled <= .0031308 ? scaled * 12.92 : 1.055 * scaled ** (1 / 2.4) - .055) * 255);
  });
  const hex = (values: number[]) => '#' + values.map(channel => channel.toString(16).padStart(2, '0')).join('');
  const background = hex(rgb);
  const border = hex(rgb.map(channel => Math.round(channel * .72 + 255 * .28)));
  return `--tag-color: ${color}; --tag-background: ${background}; --tag-text-color: #ffffff; --tag-border-color: ${border};`;
}
