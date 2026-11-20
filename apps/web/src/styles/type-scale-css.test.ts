import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

// Raw font sizes that are allowed, with the reason (also listed at the top of styles.css).
const ALLOWED = new Set(['64px', '40px', '0.92em']);

describe('type scale', () => {
  it('uses --fs-* tokens for every font-size, apart from the documented exceptions', () => {
    const raw = [...css.matchAll(/font-size:\s*([^;}]+)[;}]/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((v) => !v.startsWith('var(--fs-') && !ALLOWED.has(v));
    expect(raw).toEqual([]);
  });

  it('raises the micro label size to 12px on phone', () => {
    expect(css).toMatch(/@media \(max-width: 639px\) \{\s*body \{\s*--fs-micro: 12px;/);
  });
});
