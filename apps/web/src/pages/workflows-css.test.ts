import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('workflows table CSS', () => {
  it('a long version line is cut short instead of running under the row menu', () => {
    const version = rule('.wf-version');
    expect(version).toContain('overflow: hidden');
    expect(version).toContain('text-overflow: ellipsis');
  });

  it('the actions column fits the 44 px menu button and its padding', () => {
    expect(rule('.wf-col-actions')).toContain('width: calc(var(--target-min) + 24px)');
  });
});
