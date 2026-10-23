import { tk } from './i18n/key';

// Preview swatches: navigation, page, accent and the palette's second signature color.
// Two-tone palettes color the browser UI like their navigation, which tops narrow screens.
// Theme names are Russian keys; render them through t().
export const themes = [
  { id: 'light', label: tk('Светлая'), colorScheme: 'light', preview: ['#e9edf1', '#f4f5f7', '#315c87', '#dce6f0'], themeColor: '#f4f5f7' },
  { id: 'dark', label: tk('Тёмная'), colorScheme: 'dark', preview: ['#1b2027', '#171b21', '#85add5', '#34465a'], themeColor: '#171b21' },
  { id: 'spaceport', label: tk('Горизонт'), colorScheme: 'light', preview: ['#14213d', '#eef0f3', '#cc4a0c', '#d9e1ee'], themeColor: '#14213d' },
  { id: 'poster', label: tk('Плакат'), colorScheme: 'light', preview: ['#e4d8bf', '#ede4d1', '#1b1915', '#f4d553'], themeColor: '#ede4d1' },
  { id: 'dam', label: tk('Лишайник'), colorScheme: 'light', preview: ['#bfcaa6', '#d6d5cd', '#4a7020', '#dde58f'], themeColor: '#d6d5cd' },
  { id: 'rustbelt', label: tk('Патина'), colorScheme: 'light', preview: ['#d8c39d', '#e3d3b4', '#ad421a', '#17676d'], themeColor: '#e3d3b4' },
  { id: 'bluegate', label: tk('Тихая гавань'), colorScheme: 'light', preview: ['#dce6ec', '#e9eff2', '#b37b00', '#24526c'], themeColor: '#e9eff2' },
  { id: 'speranza', label: tk('Тёплый свет'), colorScheme: 'dark', preview: ['#12302f', '#1b1511', '#f2a43a', '#5fd0c4'], themeColor: '#12302f' },
  { id: 'arc', label: tk('Искра'), colorScheme: 'dark', preview: ['#0d0f12', '#13161a', '#ff4d3d', '#9fd3e8'], themeColor: '#13161a' },
  { id: 'terminal', label: tk('Терминал'), colorScheme: 'dark', preview: ['#091309', '#07100a', '#3ee07c', '#1b3a24'], themeColor: '#07100a' },
  { id: 'dusk', label: tk('Сумерки'), colorScheme: 'dark', preview: ['#14101f', '#19152a', '#ff8a5b', '#ff9fd0'], themeColor: '#19152a' },
  { id: 'alarm', label: tk('Тревога'), colorScheme: 'dark', preview: ['#f2c419', '#121211', '#ffd21a', '#3d3616'], themeColor: '#f2c419' },
  { id: 'bunker', label: tk('Бункер'), colorScheme: 'dark', preview: ['#212219', '#2a2b23', '#e6dcb8', '#ffb46b'], themeColor: '#2a2b23' },
] as const;

export type Theme = (typeof themes)[number]['id'];
export const themeStorageKey = 'brigd.theme';
export const legacyThemeStorageKey = 'trackt.theme';

// Retired palettes open in the closest current one with the same brightness.
export const retiredThemes: ReadonlyMap<string, Theme> = new Map([
  ['ocean', 'bluegate'], ['forest', 'dam'], ['rose', 'poster'], ['sand', 'rustbelt'], ['mint', 'dam'],
  ['peach', 'spaceport'], ['indigo', 'spaceport'], ['fog', 'bluegate'], ['olive', 'dam'],
  ['midnight', 'arc'], ['graphite', 'arc'], ['plum', 'dusk'], ['coffee', 'speranza'], ['pine', 'terminal'],
  ['lagoon', 'speranza'], ['ember', 'bunker'], ['garnet', 'dusk'], ['obsidian', 'alarm'],
]);

function isTheme(value: string | null): value is Theme {
  return themes.some(theme => theme.id === value);
}

export function readTheme(): Theme {
  try {
    const current = localStorage.getItem(themeStorageKey);
    if (isTheme(current)) return current;
    const replacement = current === null ? undefined : retiredThemes.get(current);
    if (replacement) return replacement;
    const legacy = localStorage.getItem(legacyThemeStorageKey);
    if (legacy === 'light' || legacy === 'dark') {
      // Copy once without removing the old preference. A full/blocked store must
      // not discard the theme that was already readable before the rename.
      try { localStorage.setItem(themeStorageKey, legacy); } catch {}
      return legacy;
    }
    return 'light';
  }
  catch { return 'light'; }
}

export function applyTheme(theme: Theme) {
  const palette = themes.find(palette => palette.id === theme)!;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.colorScheme = palette.colorScheme;
  document.documentElement.style.colorScheme = palette.colorScheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.themeColor);
}

export function saveTheme(theme: Theme): boolean {
  try { localStorage.setItem(themeStorageKey, theme); return true; }
  catch { return false; }
}
