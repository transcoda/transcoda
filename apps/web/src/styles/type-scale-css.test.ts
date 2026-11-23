// DESIGN.md › Typography: every font-size is a --fs-* token.
import { describe, expect, it } from 'vitest';
import { declsOf, stylesCss, where } from './css-source';
import { FONT_SIZE_OK } from './design-exceptions';

function sizeProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => d.prop === 'font-size')
    .filter((d) => !d.value.startsWith('var(--fs-') && !(d.value in FONT_SIZE_OK))
    .map(where);
}

describe('type scale', () => {
  it('uses --fs-* tokens for every font-size, apart from the documented exceptions', () => {
    expect(
      sizeProblems(stylesCss),
      'DESIGN.md › Typography: use an --fs-* token (exceptions: styles/design-exceptions.ts FONT_SIZE_OK)',
    ).toEqual([]);
    expect(sizeProblems('.a { color: red; font-size: 13px }')).toHaveLength(1);
  });

  it('sets no size through the font shorthand', () => {
    const shorthand = declsOf(stylesCss).filter((d) => d.prop === 'font' && d.value !== 'inherit');
    expect(shorthand.map(where), 'DESIGN.md › Typography: font is only `inherit`').toEqual([]);
  });

  it('raises the micro label size to 12px on phone', () => {
    expect(stylesCss).toMatch(/@media \(max-width: 639px\) \{\s*body \{\s*--fs-micro: 12px;/);
  });
});
