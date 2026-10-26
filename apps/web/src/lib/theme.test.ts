import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, cachedTheme, THEME_STORAGE_KEY } from './theme.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme', () => {
  it('sets data-theme for dark and light; system removes it', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('caches the choice for the next load', () => {
    expect(cachedTheme()).toBeNull();
    applyTheme('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(cachedTheme()).toBe('light');
    applyTheme('system');
    expect(cachedTheme()).toBe('system');
  });

  it('a preview (cache: false) applies without caching', () => {
    applyTheme('dark', { cache: false });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('ignores a cached value that is not a theme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(cachedTheme()).toBeNull();
  });

  it('survives a localStorage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(cachedTheme()).toBeNull();
    expect(() => applyTheme('light')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
