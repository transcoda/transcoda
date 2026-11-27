import { describe, expect, it } from 'vitest';
import { stylesCss } from '../../styles/css-source.ts';

const css = stylesCss;

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('settings nav: the current item (Jan: green icon, no bar)', () => {
  it('is marked by a green icon, the text colour and the fill, with no bar, inset shadow or weight change', () => {
    const active = rule('.settings-nav-item.is-active');
    expect(active).not.toContain('inset');
    expect(active).not.toContain('font-weight');
    expect(active).toContain('color: var(--text)');
    expect(active).toContain('background: var(--raised)');
    expect(rule('.settings-nav-item.is-active .icon')).toContain('color: var(--accent-text)');
    expect(css).not.toContain('.settings-nav-item.is-active::before');
  });
});
