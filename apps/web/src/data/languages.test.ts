import { describe, expect, it } from 'vitest';
import { LANGUAGE_PATTERN } from '../editor/model/schema-fields.ts';
import { LANGUAGES, languageName } from './languages.ts';

describe('LANGUAGES', () => {
  it('lists unique ISO 639-1 codes the server accepts, with English names, plus Untagged', () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(175);
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    const pattern = new RegExp(LANGUAGE_PATTERN);
    for (const { code, name } of LANGUAGES) {
      expect(code, code).toMatch(pattern);
      expect(name.length, code).toBeGreaterThan(1);
    }
    expect(codes.filter((c) => c !== 'unknown').every((c) => c.length === 2)).toBe(true);
    expect(LANGUAGES).toContainEqual({ code: 'en', name: 'English' });
    expect(LANGUAGES).toContainEqual({ code: 'de', name: 'German' });
    expect(LANGUAGES).toContainEqual({ code: 'tr', name: 'Turkish' });
    expect(LANGUAGES).toContainEqual({ code: 'unknown', name: 'Untagged' });
  });
});

describe('languageName', () => {
  it('names known codes and returns unknown codes unchanged', () => {
    expect(languageName('ja')).toBe('Japanese');
    expect(languageName('unknown')).toBe('Untagged');
    expect(languageName('ger')).toBe('ger');
    expect(languageName('')).toBe('');
  });
});
