import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('settings nav: the current item (Jan: green icon, no bar)', () => {
  it('is marked by a green icon, bold text and the fill, with no bar or inset shadow', () => {
    const active = rule('.settings-nav-item.is-active');
    expect(active).not.toContain('inset');
    expect(active).toContain('font-weight: 700');
    expect(active).toContain('background: var(--raised)');
    expect(rule('.settings-nav-item.is-active .icon')).toContain('color: var(--accent-text)');
    expect(css).not.toContain('.settings-nav-item.is-active::before');
  });
});
