import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

const SPACING =
  /(?<![\w-])((?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)*)\s*:\s*([^;{}]+);/g;
const RADIUS = /(?<![\w-])border-radius\s*:\s*([^;{}]+);/g;

// Spacing values that stay raw, with the reason (also described at the top of styles.css):
//  - 1px: hairline offsets (chip padding, a 1px row gap, a -1px margin that cancels a border).
//  - off-token steps on the 4px grid that tokens.css has no name for (28, 44, 52, 56, 60, 64, 76).
//  - calc(), max() and em/ch values, which are derived from other values.
//  - negative margins that pair with a positive padding of the same step (-4px, -8px).
const SPACING_OK = new Set([
  '1px',
  '-1px',
  '-4px',
  '28px',
  '44px',
  '52px',
  '56px',
  '60px',
  '64px',
  '76px',
  '-8px',
]);

// Radii that stay raw: 2px marks (swatches, handles, a search highlight), pills and circles.
const RADIUS_OK = new Set(['2px', '50%', '0', 'inherit']);

function rawLengths(value: string): string[] {
  const stripped = value.replace(/var\([^)]*\)/g, '').replace(/(calc|max|min|clamp)\([^)]*\)/g, '');
  return (stripped.match(/-?[\d.]+(?:px)\b/g) ?? []).filter((v) => !SPACING_OK.has(v));
}

describe('spacing and radius scale', () => {
  it('puts every padding, margin and gap length on a token or a documented exception', () => {
    const raw: string[] = [];
    for (const m of css.matchAll(SPACING)) {
      const bad = rawLengths(m[2] ?? '');
      if (bad.length > 0) raw.push(`${m[1]}: ${m[2]}`);
    }
    expect(raw).toEqual([]);
  });

  it('keeps every raw spacing length on the 4px grid', () => {
    for (const v of SPACING_OK) {
      if (v === '1px' || v === '-1px') continue;
      expect(Math.abs(Number.parseInt(v, 10)) % 4).toBe(0);
    }
  });

  it('uses --r-* tokens for every border-radius, apart from the documented exceptions', () => {
    const raw = [...css.matchAll(RADIUS)]
      .map((m) => (m[1] ?? '').trim())
      .filter(
        (v) => !v.startsWith('var(--r-') && !v.startsWith('calc(var(--r-') && !RADIUS_OK.has(v),
      );
    expect(raw).toEqual([]);
  });

  it('defines the 20px and 40px steps tokens.css lacks', () => {
    expect(css).toMatch(/--sp-5:\s*20px/);
    expect(css).toMatch(/--sp-10:\s*40px/);
  });

  it('caps help text at 70ch', () => {
    expect(css).toMatch(/\.about-backups-hint,[\s\S]*?max-width: 70ch;/);
    expect(css).toMatch(/\.recycle-note,[\s\S]*?max-width: 70ch;/);
  });
});
