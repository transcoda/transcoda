import type { Theme } from '@transcoda/contract';

/** Where the last server theme is kept, so the next load paints in it before `auth.me` answers. */
export const THEME_STORAGE_KEY = 'transcoda.theme';
const THEMES: readonly Theme[] = ['system', 'dark', 'light'];

/**
 * Sets <html data-theme> ('system' removes it) and caches the choice for the next load; a preview
 * passes `{ cache: false }` so only a theme the server holds is remembered.
 */
export function applyTheme(theme: Theme, opts: { cache?: boolean } = {}): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (opts.cache === false) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private window, site data off): the theme still applies to this page.
  }
}

/** The cached choice (localStorage 'transcoda.theme'), or null; never throws. */
export function cachedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.find((t) => t === v) ?? null;
  } catch {
    return null;
  }
}
