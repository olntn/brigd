import { createSubscriber } from 'svelte/reactivity';
import { plural as russianPlural } from '../format';
import { en, enPatterns } from './en';

/**
 * Interface localisation. Russian is the source language: its text is the key,
 * and a missing English entry falls back to the Russian original.
 */
export const locales = [
  { id: 'ru', label: 'Русский', tag: 'ru-RU' },
  { id: 'en', label: 'English', tag: 'en-US' },
] as const;

export type Locale = (typeof locales)[number]['id'];
export type Params = Record<string, string | number>;
export const DEFAULT_LOCALE: Locale = 'ru';
export const localeStorageKey = 'brigd.locale';

export function isLocale(value: unknown): value is Locale {
  return locales.some(locale => locale.id === value);
}

export function readLocale(): Locale {
  try {
    const value = localStorage.getItem(localeStorageKey);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch { return DEFAULT_LOCALE; }
}

export function saveLocale(locale: Locale): boolean {
  try { localStorage.setItem(localeStorageKey, locale); return true; }
  catch { return false; }
}

let current: Locale = readLocale();
let changed = () => {};
// Components and $derived values that read the locale re-render when it changes.
const track = createSubscriber(update => {
  changed = update;
  return () => { changed = () => {}; };
});

export function getLocale(): Locale {
  track();
  return current;
}

export function applyLocale(locale: Locale = current) {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function setLocale(locale: Locale) {
  applyLocale(locale);
  if (locale === current) return;
  current = locale;
  changed();
}

/** BCP 47 tag for Intl formatting in the current interface language. */
export function localeTag(locale: Locale = getLocale()): string {
  return locales.find(item => item.id === locale)!.tag;
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

/** Context keeps one Russian word apart when English needs two different translations. */
export const contextKey = (context: string, text: string) => `${context}::${text}`;

export function translate(locale: Locale, text: string, params?: Params, context?: string): string {
  if (locale === 'ru') return interpolate(text, params);
  return interpolate((context ? en[contextKey(context, text)] : undefined) ?? en[text] ?? text, params);
}

/** Translates interface text written in Russian; `{name}` placeholders are filled from params. */
export function t(text: string, params?: Params): string {
  return translate(getLocale(), text, params);
}

/** Like t(), for a Russian text whose English depends on where it is shown. */
export function tc(context: string, text: string, params?: Params): string {
  return translate(getLocale(), text, params, context);
}

export { tk } from './key';

/** Russian takes one of three noun forms (1 папка, 2 папки, 5 папок); English uses one of two. */
export function plural(count: number, one: string, few: string, many: string): string {
  const locale = getLocale();
  return locale === 'ru' ? russianPlural(count, one, few, many) : translate(locale, count === 1 ? one : many);
}

/**
 * Text produced by the server: API errors, stored run logs and system notes.
 * They are recorded in Russian; exact matches and known patterns get English.
 */
export function translateServer(locale: Locale, text: string): string {
  if (locale === 'ru' || !text) return text;
  const exact = en[text];
  if (exact !== undefined) return exact;
  for (const [pattern, replacement] of enPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    return typeof replacement === 'string' ? text.replace(pattern, replacement) : replacement(match, part => translateServer(locale, part));
  }
  return text;
}

export function serverText(text: string): string {
  return translateServer(getLocale(), text);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(localeTag(), options);
}

export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(localeTag(), options).format(value);
}

/** Human file sizes: whole bytes below a kilobyte, then one decimal up the binary ladder. */
export function formatSize(bytes: number): string {
  const units = [t('Б'), t('КБ'), t('МБ'), t('ГБ'), t('ТБ')];
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  let value = bytes / 1024, unit = 1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${formatNumber(value, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
