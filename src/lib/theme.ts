export type Theme = 'light' | 'dark';
export const themeStorageKey = 'brigd.theme';
export const legacyThemeStorageKey = 'trackt.theme';

export function readTheme(): Theme {
  try {
    const current = localStorage.getItem(themeStorageKey);
    if (current === 'light' || current === 'dark') return current;
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
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#18171e' : '#fbfbfd');
}

export function saveTheme(theme: Theme): boolean {
  try { localStorage.setItem(themeStorageKey, theme); return true; }
  catch { return false; }
}
