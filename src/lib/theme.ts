export const themes = [
  { id: 'light', label: 'Светлая', colorScheme: 'light', preview: ['#fbfbfd', '#ffffff', '#7764cf'], themeColor: '#fbfbfd' },
  { id: 'dark', label: 'Тёмная', colorScheme: 'dark', preview: ['#18171e', '#22212a', '#8d76d9'], themeColor: '#18171e' },
  { id: 'ocean', label: 'Океан', colorScheme: 'light', preview: ['#f3f8fc', '#ffffff', '#26749d'], themeColor: '#f3f8fc' },
  { id: 'forest', label: 'Лес', colorScheme: 'light', preview: ['#f5f9f4', '#ffffff', '#45744a'], themeColor: '#f5f9f4' },
  { id: 'rose', label: 'Роза', colorScheme: 'light', preview: ['#fdf6f8', '#ffffff', '#b44f7b'], themeColor: '#fdf6f8' },
  { id: 'sand', label: 'Песок', colorScheme: 'light', preview: ['#fbf8f1', '#ffffff', '#956723'], themeColor: '#fbf8f1' },
  { id: 'midnight', label: 'Полночь', colorScheme: 'dark', preview: ['#111b2c', '#1b2940', '#72a7eb'], themeColor: '#111b2c' },
  { id: 'graphite', label: 'Графит', colorScheme: 'dark', preview: ['#1d2024', '#282d33', '#abbfce'], themeColor: '#1d2024' },
  { id: 'plum', label: 'Слива', colorScheme: 'dark', preview: ['#241926', '#312334', '#c489d6'], themeColor: '#241926' },
  { id: 'coffee', label: 'Кофе', colorScheme: 'dark', preview: ['#241e1a', '#302824', '#d3a46d'], themeColor: '#241e1a' },
] as const;

export type Theme = (typeof themes)[number]['id'];
export const themeStorageKey = 'brigd.theme';
export const legacyThemeStorageKey = 'trackt.theme';

function isTheme(value: string | null): value is Theme {
  return themes.some(theme => theme.id === value);
}

export function readTheme(): Theme {
  try {
    const current = localStorage.getItem(themeStorageKey);
    if (isTheme(current)) return current;
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
