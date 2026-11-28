// DESIGN.md › Spacing, radius, shadow: spacing and radius come from the token scale.
import { describe, expect, it } from 'vitest';
import { declsOf, rulesFor, spaceValues, stylesCss, where } from './testing/css-source.ts';
import { RADIUS_OK, SPACING_OK } from './testing/design-exceptions.ts';

const SPACING_PROP = /^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)*$/;
const RADIUS_PROP = /^border(?:-[a-z]+)*-radius$/;

/** The raw px lengths of a spacing value outside the documented exceptions. Lengths inside a
 *  function (calc, max, var) are derived from other values and are not counted. */
function rawLengths(value: string): string[] {
  return spaceValues(value)
    .filter((v) => !v.includes('('))
    .filter((v) => /^-?[\d.]+px$/.test(v) && !(v in SPACING_OK));
}

const radiusOk = (v: string) =>
  v.startsWith('var(--r-') || v.startsWith('calc(var(--r-') || v in RADIUS_OK;

function spacingProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => SPACING_PROP.test(d.prop) && rawLengths(d.value).length > 0)
    .map(where);
}

function radiusProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => RADIUS_PROP.test(d.prop) && !spaceValues(d.value).every(radiusOk))
    .map(where);
}

describe('spacing and radius scale', () => {
  it('puts every padding, margin and gap length on a token or a documented exception', () => {
    expect(
      spacingProblems(stylesCss),
      'DESIGN.md › Spacing: use a --sp-* token (exceptions: styles/testing/design-exceptions.ts SPACING_OK)',
    ).toEqual([]);
  });

  it('keeps every raw spacing length on the 4px grid', () => {
    for (const v of Object.keys(SPACING_OK)) {
      if (v === '1px' || v === '-1px') continue;
      expect(Math.abs(Number.parseInt(v, 10)) % 4, v).toBe(0);
    }
  });

  it('uses --r-* tokens for every radius, apart from the documented exceptions', () => {
    expect(
      radiusProblems(stylesCss),
      'DESIGN.md › Radius: use an --r-* token (exceptions: styles/testing/design-exceptions.ts RADIUS_OK)',
    ).toEqual([]);
  });

  it('sees every value, longhand and last declaration (the checks are not blind)', () => {
    // A last declaration without a semicolon.
    expect(spacingProblems('.a { gap: 3px }')).toHaveLength(1);
    expect(spacingProblems('.a { color: red; margin-inline: var(--sp-1) 6px }')).toHaveLength(1);
    // Nested in an at-rule.
    expect(spacingProblems('@media (hover: hover) { .a { padding: 5px } }')).toHaveLength(1);
    expect(spacingProblems('.a { padding: calc(var(--sp-2) + 1px) var(--sp-1) }')).toEqual([]);
    // Every corner, either side of a slash, and the longhands.
    expect(radiusProblems('.a { border-radius: var(--r-sm) 23px }')).toHaveLength(1);
    expect(radiusProblems('.a { border-radius: var(--r-md) / 9px }')).toHaveLength(1);
    expect(radiusProblems('.a { border-top-left-radius: 5px }')).toHaveLength(1);
    expect(radiusProblems('.a { border-radius: calc(var(--r-lg) - 2px) 0 }')).toEqual([]);
    expect(radiusProblems('.a { border-radius: 5px }')).toHaveLength(1);
  });

  it('defines the 20px and 40px steps tokens.css lacks', () => {
    expect(stylesCss).toMatch(/--sp-5:\s*20px/);
    expect(stylesCss).toMatch(/--sp-10:\s*40px/);
  });

  it('caps help text at 70ch, in the rule that holds each selector', () => {
    for (const sel of ['.about-backups-hint', '.recycle-note']) {
      expect(
        rulesFor(stylesCss, sel).some((body) => /max-width: 70ch/.test(body)),
        sel,
      ).toBe(true);
    }
    // A 70ch in the next rule does not count for this one.
    expect(rulesFor('.x { color: red } .y { max-width: 70ch }', '.x')).toEqual(['color: red;']);
  });
});
