import { describe, expect, it } from 'vitest';
import { changedFields, sectionDirty } from './dirty.ts';

describe('sectionDirty', () => {
  it.each([
    ['same values', { a: 7, b: 'x' }, { a: 7, b: 'x' }, false],
    ['a number typed as text equals the saved number', { a: '7' }, { a: 7 }, false],
    ['a different number', { a: '14' }, { a: 7 }, true],
    ['an empty number field differs from a saved number', { a: '' }, { a: 7 }, true],
    ['"07" is 7', { a: '07' }, { a: 7 }, false],
    ['empty name equals no name', { n: '' }, { n: null }, false],
    ['blank name equals no name', { n: '   ' }, { n: null }, false],
    ['surrounding spaces do not count', { n: ' Den ' }, { n: 'Den' }, false],
    ['a new name', { n: 'Den' }, { n: null }, true],
    ['a different theme', { t: 'light' }, { t: 'system' }, true],
  ])('%s', (_name, draft, saved, dirty) => {
    expect(sectionDirty(draft as Record<string, unknown>, saved as Record<string, unknown>)).toBe(
      dirty,
    );
  });
});

describe('changedFields', () => {
  it('keeps only the fields that differ', () => {
    expect(
      changedFields(
        { recycleRetentionDays: 14, recycleMaxFreePercent: 25 },
        { recycleRetentionDays: 7, recycleMaxFreePercent: 25 },
      ),
    ).toEqual({ recycleRetentionDays: 14 });
  });

  it('a cleared name is sent as null; an unchanged one not at all', () => {
    expect(
      changedFields({ serverName: null, theme: 'dark' }, { serverName: 'Den', theme: 'system' }),
    ).toEqual({ serverName: null, theme: 'dark' });
    expect(changedFields({ serverName: 'Den' }, { serverName: 'Den' })).toEqual({});
  });
});
