import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = ['tokens.css', '../styles.css'].map((f) =>
  readFileSync(join(__dirname, f), 'utf8'),
);

/** The text between the braces of the block that starts with `head` (nested braces handled). */
function block(source: string, head: string): string {
  const start = source.indexOf(head);
  if (start < 0) return '';
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(source.indexOf('{', start) + 1, i);
  }
  return '';
}

function decls(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) {
    out.set(m[1] ?? '', (m[2] ?? '').replace(/\/\*.*?\*\//g, '').trim());
  }
  return out;
}

const MANUAL = ':root[data-theme="light"]';
const AUTO = ':root:not([data-theme="dark"])';

function merged(pick: (source: string) => string): Map<string, string> {
  const all = new Map<string, string>();
  for (const source of sources) for (const [k, v] of decls(pick(source))) all.set(k, v);
  return all;
}
const manual = merged((s) => block(s, `${MANUAL} {`));
const auto = merged((s) => block(block(s, '@media (prefers-color-scheme: light)'), `${AUTO} {`));
const dark = merged((s) => block(s, ':root {'));

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text pairs [foreground, background]: AA 4.5:1. The tokens are those the stylesheet pairs. */
const SURFACES = ['bg', 'surface', 'raised'];
const TEXT_ON_SURFACES = [
  'text',
  'muted',
  'faint',
  'accent-text',
  'st-replaced-text',
  'danger-text',
  'kind-trigger',
  'kind-condition',
  'kind-action',
  'kind-finish',
  'kind-data',
  'st-dry',
  'st-needs-setting',
  'st-failed-text',
  'st-kept-text',
  'st-skipped-text',
];
const PAIRS: Array<[string, string]> = [
  ['on-accent', 'accent'],
  ['st-replaced-ink', 'st-replaced'],
  ['st-kept-ink', 'st-kept'],
  ['st-noop-ink', 'st-noop'],
  ['st-skipped-ink', 'st-skipped'],
  ['st-failed-ink', 'st-failed'],
  ['st-running-ink', 'st-running'],
  ['st-dry-ink', 'st-dry'],
  ['needs-setting-ink', 'st-needs-setting'],
  ['st-failed-text', 'st-failed-bg'],
  ['danger-text', 'st-failed-bg'],
  ['st-dry', 'st-dry-bg'],
  ['kind-data', 'data-chip-bg'],
  ['legend-text', 'legend-kbd-bg'],
  ['text', 'row-new'],
  ['text', 'plan-drop-row'],
  ['text', 'st-failed-bg'],
  ['text', 'st-dry-bg'],
];

describe('light theme (UI review M13)', () => {
  it('follows the OS preference unless the user chose dark, and data-theme=light forces it', () => {
    expect(auto.size).toBeGreaterThan(40);
    expect(manual).toEqual(auto);
    expect(auto.get('color-scheme')).toBe('light');
  });

  it('overrides every --st-* token and every colour the stylesheet pairs with them', () => {
    const stTokens = [...dark.keys()].filter((k) => k.startsWith('--st-'));
    expect(stTokens.length).toBeGreaterThan(15);
    for (const k of stTokens) expect(auto.has(k), k).toBe(true);
    // Each dark-only colour (hex or rgb literal) has a light value; var() aliases follow their target.
    for (const [k, v] of dark) {
      if (k.startsWith('--') && /^(#|rgb)/.test(v) && !/^--(font|fs|sp|r-|fw|target)/.test(k)) {
        expect(auto.has(k), k).toBe(true);
      }
    }
  });

  it('keeps AA contrast (4.5:1) on every text pair, in light and dark', () => {
    for (const name of ['light', 'dark'] as const) {
      const get = (token: string): string => {
        const v =
          (name === 'light' ? auto.get(`--${token}`) : undefined) ?? dark.get(`--${token}`) ?? '';
        expect(v, `${name} --${token}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        return v;
      };
      for (const fg of TEXT_ON_SURFACES) {
        for (const bg of SURFACES) {
          expect(ratio(get(fg), get(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const [fg, bg] of PAIRS) {
        expect(ratio(get(fg), get(bg)), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("Bold light: the fills are the dark theme's bright ones, with the same dark ink on them", () => {
    for (const t of [
      'accent',
      'on-accent',
      'st-replaced',
      'st-replaced-ink',
      'st-kept',
      'st-kept-ink',
      'st-skipped',
      'st-skipped-ink',
      'st-failed',
      'st-failed-ink',
    ]) {
      expect(auto.get(`--${t}`), t).toBe(dark.get(`--${t}`));
    }
    // Text and lines on the light page take the deep variant, never the bright fill.
    expect(auto.get('--accent-text')).not.toBe(auto.get('--accent'));
    expect(auto.get('--st-replaced-text')).not.toBe(auto.get('--st-replaced'));
  });

  it('draws the focus ring in a colour that shows against the page, in light', () => {
    for (const t of ['accent-text', 'text']) {
      expect(ratio(auto.get(`--${t}`) ?? '', auto.get('--bg') ?? '')).toBeGreaterThanOrEqual(3);
    }
  });
});
