import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8');

/** The declarations of the first `selector { … }` in any `@media (…)` block that starts with `media`. */
function inMedia(media: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media (${media}) {`, from);
    if (start < 0) return '';
    let depth = 0;
    let end = start;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const found = css.slice(start, end).match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`))?.[1];
    if (found !== undefined) return found;
    from = end;
  }
}

describe('editor layout CSS', () => {
  it('the mid-width columns apply at 1280 px too (max-width: 1280px, not 1279px)', () => {
    expect(css).not.toMatch(/@media \(max-width: 1279px\) \{\s*\.editor-body/);
    expect(inMedia('max-width: 1280px', '.editor-body')).toMatch(/grid-template-columns:/);
  });

  it('below 1024 px the canvas has the whole width; the palette is hidden and the inspector is a bottom sheet', () => {
    expect(inMedia('max-width: 1023px', '.editor-body')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(inMedia('max-width: 1023px', '.editor-body > .palette')).toMatch(/display:\s*none/);
    const sheet = inMedia('max-width: 1023px', '.inspector-col.is-sheet');
    expect(sheet).toMatch(/position:\s*absolute/);
    expect(sheet).toMatch(/bottom:\s*0/);
  });

  it('the Versions panel stays inside a phone-width screen', () => {
    expect(css.match(/\.versions-panel\s*\{([^}]*)\}/)?.[1] ?? '').toMatch(/max-width:/);
  });
});
