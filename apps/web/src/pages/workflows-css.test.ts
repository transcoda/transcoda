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

  it('names are underlined only on hover and keyboard focus', () => {
    expect(rule('.wf-link')).toContain('text-decoration: none');
    expect(rule('.wf-link:hover,\n.wf-link:focus-visible')).toContain('text-decoration: underline');
  });

  it('at phone width a workflow row is a card with one meta line, without column names', () => {
    expect(css).not.toMatch(/\.wf-table \[data-label\]/);
    expect(rule('.wf-table .wf-meta + .wf-meta::before')).toContain('content: "·"');
  });

  it('the Last edited column fits "v12 · 27 Oct 2025" (mono 12 px) and its padding', () => {
    expect(rule('.wf-col-edited')).toContain('width: 160px');
  });

  it('the actions column fits the 44 px menu button and its padding', () => {
    expect(rule('.wf-col-actions')).toContain('width: calc(var(--target-min) + 24px)');
  });
});
