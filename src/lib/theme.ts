export type Theme = 'light' | 'dark';
export const themeStorageKey = 'trackt.theme';

export function readTheme(): Theme {
  try { return localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light'; }
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
