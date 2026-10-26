import { describe, expect, it } from 'vitest';
import { envDocsUrl, envSourceText, sourceText } from './sourceText.ts';

describe('sourceText', () => {
  it.each([
    [{ kind: 'database' } as const, 'Set here'],
    [{ kind: 'default' } as const, 'Default'],
    [{ kind: 'env', variable: 'TRANSCODA_X' } as const, 'From TRANSCODA_X'],
    [{ kind: 'setup' } as const, 'Recorded at setup'],
    [{ kind: 'built-in' } as const, 'Built in'],
  ])('%o reads "%s"', (source, text) => {
    expect(sourceText(source)).toBe(text);
  });

  it('an env value says whether the variable is set', () => {
    expect(envSourceText('TRANSCODA_X', true)).toBe('From TRANSCODA_X');
    expect(envSourceText('TRANSCODA_X', false)).toBe('Default · set TRANSCODA_X to change');
  });

  it('links each variable to its section of docs/env.md', () => {
    expect(envDocsUrl('TRANSCODA_PUBLIC_URL')).toBe(
      'https://github.com/transcoda/transcoda/blob/main/docs/env.md#server',
    );
    expect(envDocsUrl('TRANSCODA_PLUGIN_ISOLATION')).toBe(
      'https://github.com/transcoda/transcoda/blob/main/docs/env.md#plugins',
    );
  });
});
