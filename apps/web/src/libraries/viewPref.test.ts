import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY_VIEW_KEY, readLibraryView, writeLibraryView } from './viewPref.ts';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('library view preference', () => {
  it('defaults to posters and remembers table', () => {
    expect(readLibraryView()).toBe('posters');
    writeLibraryView('table');
    expect(localStorage.getItem(LIBRARY_VIEW_KEY)).toBe('table');
    expect(readLibraryView()).toBe('table');
    writeLibraryView('posters');
    expect(readLibraryView()).toBe('posters');
  });

  it('reads posters for an unknown value', () => {
    localStorage.setItem(LIBRARY_VIEW_KEY, 'grid');
    expect(readLibraryView()).toBe('posters');
  });

  it('never throws when storage does', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readLibraryView()).toBe('posters');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => writeLibraryView('table')).not.toThrow();
  });
});
