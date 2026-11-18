import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Library poster grid', () => {
  it('the grid fills columns of at least 140 px', () =>
    expect(rule('.library-grid')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(140px,\s*1fr\)\)/,
    ));
  it('phones show two posters per row', () =>
    expect(css).toMatch(
      /@media \(max-width: 639px\)\s*\{[^@]*\.library-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    ));
  it('a long title keeps two lines and never widens its card', () => {
    const t = rule('.library-card-title');
    expect(t).toMatch(/-webkit-line-clamp:\s*2/);
    expect(t).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('the placeholder stays a centered flex box inside a card', () => {
    // No card rule may override .poster-empty's display; it is what centers the film icon.
    expect(css).not.toMatch(/\.library-card\s+\.poster-card\s*\{[^}]*display:/);
    const empty = rule('.poster-empty');
    expect(empty).toMatch(/display:\s*flex/);
    expect(empty).toMatch(/align-items:\s*center/);
    expect(empty).toMatch(/justify-content:\s*center/);
  });
  it('focus rings use the app focus ring, not the accent outline', () => {
    for (const sel of ['.library-card:focus-visible', '.library-sort:focus-visible']) {
      expect(rule(sel)).toMatch(/box-shadow:\s*var\(--focus-ring\)/);
      expect(rule(sel)).not.toMatch(/var\(--accent\)/);
    }
  });
  it('a disabled ghost button (the pager) is dimmed like a disabled secondary one', () => {
    expect(rule('.btn-ghost:disabled')).toMatch(/color:\s*var\(--faint\)/);
  });
});
