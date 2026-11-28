// DESIGN.md quotes token values; tokens.css and variables.css hold them. DESIGN.md says
// that when the two disagree, the stylesheet is right and DESIGN.md needs updating: this test
// says when.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_STROKE } from '../components/Icon.tsx';
import { declsOf, stylesCss, tokensCss } from './testing/css-source.ts';
import { CONTAINER_WIDTHS } from './testing/design-exceptions.ts';

const design = readFileSync(join(__dirname, '../../../../DESIGN.md'), 'utf8');

function themeValues(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const source of [tokensCss, stylesCss]) {
    for (const d of declsOf(source)) {
      if (d.prop.startsWith('--') && d.selectors.length === 1 && d.selectors[0] === selector) {
        out.set(d.prop, d.value);
      }
    }
  }
  return out;
}
const dark = themeValues(':root');
const light = themeValues(':root[data-theme="light"]');
const tokenValue = (token: string, theme = dark) => theme.get(token) ?? light.get(token);

/** DESIGN.md's `--token` value pairs, as `` `--sp-1` 4 `` or a table row `| `--fs-h2` | 20px |`. */
function quoted(pattern: RegExp): [string, string][] {
  return [...design.matchAll(pattern)].map((m) => [m[1] ?? '', m[2] ?? '']);
}

const MISMATCH = 'DESIGN.md quotes a value that the stylesheet does not have: update DESIGN.md';

describe('DESIGN.md matches the stylesheet', () => {
  it('type scale', () => {
    const rows = quoted(/^\s*\| `(--fs-[\w-]+)` \| (\d+px)/gm);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const [token, size] of rows) expect(tokenValue(token), `${MISMATCH}: ${token}`).toBe(size);
  });

  it('spacing, radius, motion, targets and the top bar', () => {
    const pairs = [
      ...quoted(/`(--sp-\d+)` (\d+)\b/g).map(([t, v]): [string, string] => [t, `${v}px`]),
      ...quoted(/`(--r-(?:sm|md|lg))` (\d+px)/g),
      ...quoted(/`(--dur-[\w-]+)` (\d+ms)/g),
      ...quoted(/`(--topbar-h)` (\d+px)/g),
    ];
    expect(pairs.length).toBeGreaterThanOrEqual(14);
    for (const [token, value] of pairs)
      expect(tokenValue(token), `${MISMATCH}: ${token}`).toBe(value);
    expect(design).toContain(`\`--ease-out: ${tokenValue('--ease-out')}\``);
    expect(design).toMatch(
      new RegExp(`${tokenValue('--target-min')} targets \\(\`--target-min\`\\)`),
    );
  });

  it('colour roles, dark and light', () => {
    // | role | `--token` | dark cell | light cell |
    const rows = [...design.matchAll(/^\| [^|]+ \| `(--[\w-]+)` \| ([^|]+) \| ([^|]+) \|$/gm)];
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const [, token = '', darkCell = '', lightCell = ''] of rows) {
      const darkHex = /#[0-9A-Fa-f]{6}/.exec(darkCell)?.[0];
      if (darkHex) {
        expect(tokenValue(token)?.toUpperCase(), `${MISMATCH}: ${token} (dark)`).toBe(
          darkHex.toUpperCase(),
        );
      }
      // "same", or a cell that names another token's value ("lime fill, text #3E6A00"), is not
      // this token's light value.
      const lightHex = /^(?!same)[^,]*?(#[0-9A-Fa-f]{6})[^,]*$/.exec(lightCell.trim())?.[1];
      if (lightHex && !/fill/.test(lightCell)) {
        expect(tokenValue(token, light)?.toUpperCase(), `${MISMATCH}: ${token} (light)`).toBe(
          lightHex.toUpperCase(),
        );
      }
    }
  });

  it('node kind colours, dark and light', () => {
    const rows = [
      ...design.matchAll(
        /^\| (trigger|condition|action|finish|data) \| (#[0-9A-F]{6})[^|]*\| (#[0-9A-F]{6}) \|$/gm,
      ),
    ];
    expect(rows).toHaveLength(5);
    for (const [, kind, darkHex = '', lightHex = ''] of rows) {
      expect(tokenValue(`--kind-${kind}`)?.toUpperCase(), `${MISMATCH}: --kind-${kind}`).toBe(
        darkHex,
      );
      expect(
        tokenValue(`--kind-${kind}`, light)?.toUpperCase(),
        `${MISMATCH}: --kind-${kind}`,
      ).toBe(lightHex);
    }
  });

  it('icon stroke', () => {
    const stroke = /`currentColor` stroke ([\d.]+)/.exec(design)?.[1];
    expect(stroke, `${MISMATCH}: the icon stroke`).toBe(String(ICON_STROKE));
  });

  it('container query widths', () => {
    const line =
      /Container queries on the job list \(([^)]*)\) and the jobs overview \(([^)]*)\)/.exec(
        design,
      );
    const widths = (s = '') => [...s.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
    expect(widths(line?.[1]), MISMATCH).toEqual(CONTAINER_WIDTHS['job-list']);
    expect(widths(line?.[2]), MISMATCH).toEqual(CONTAINER_WIDTHS['jobs-overview']);
  });

  it('names test files that exist', () => {
    for (const [, file] of design.matchAll(/`(styles\/[\w.-]+\.test\.ts)`/g)) {
      expect(existsSync(join(__dirname, '..', file ?? '')), `DESIGN.md names ${file}`).toBe(true);
    }
  });
});
