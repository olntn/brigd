/** Human sizes in Russian: whole bytes below a kilobyte, then one decimal up the binary ladder. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`; // i18n-ignore: server text; the interface uses formatSize()
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']; // i18n-ignore
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${units[unit]}`;
}
/** Picks the Russian noun form for a count: 1 папка, 2 папки, 5 папок. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10, mod100 = count % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
}
/** Short count for the given BCP 47 locale: 980, then 12,3 тыс. or 4,2 млн in ru-RU and 12.3K or 4.2M in en-US. */
export function formatCompactNumber(value: number, tag: string): string {
  return new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
/** US dollars as the CLI reports them, sign first: $0,42 in ru-RU, $0.42 in en-US; a nonzero amount below a cent is <$0,01. */
export function formatUsd(value: number, tag: string): string {
  const cents = (amount: number) => amount.toLocaleString(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value > 0 && value < 0.005 ? `<$${cents(0.01)}` : `$${cents(value)}`;
}
/** A duration rounded to its largest shown unit: seconds below a minute, whole minutes below an hour, then hours and minutes. */
export function durationParts(ms: number): { hours: number; minutes: number; seconds: number } {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return { hours: 0, minutes: 0, seconds };
  const minutes = Math.round(seconds / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: 0 };
}
