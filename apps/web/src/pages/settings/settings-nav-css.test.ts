import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('settings nav: the current item (Jan: no curved highlight)', () => {
  it('is marked by a straight square bar, not an inset shadow that bends with the corner', () => {
    expect(rule('.settings-nav-item.is-active')).not.toContain('inset');
    expect(rule('.settings-nav-item')).toContain('position: relative');
    const bar = rule('.settings-nav-item.is-active::before');
    expect(bar).toContain('position: absolute');
    expect(bar).toContain('width: 3px');
    expect(bar).toContain('border-radius: 0');
    expect(bar).toContain('background: var(--accent-text)');
  });
});
