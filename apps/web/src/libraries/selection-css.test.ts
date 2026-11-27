import { describe, expect, it } from 'vitest';
import { stylesCss } from '../styles/css-source.ts';

const css = stylesCss;

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Selection styles', () => {
  it('the bar sticks to the bottom above the rows, clear of the safe area', () => {
    const bar = rule('.selection-bar');
    expect(bar).toMatch(/position:\s*sticky/);
    expect(bar).toMatch(/bottom:\s*0/);
    expect(bar).toMatch(/z-index:\s*[2-9]/);
    expect(bar).toMatch(/background:\s*var\(--/);
    expect(bar).toMatch(/env\(safe-area-inset-bottom/);
  });
  it('a long path in a radio label wraps instead of overflowing the dialog', () => {
    expect(rule('.lib-radio span,\n.lib-check span')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.lib-radio span,\n.lib-check span')).toMatch(/min-width:\s*0/);
  });
});
