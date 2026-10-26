import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

const PRESSED_TILE = '.stat-tile:has(> .stat-tile-button[aria-pressed="true"])';

describe('Jobs stat tiles (#31)', () => {
  it('the button fills the stretched tile, so no tinted band shows under it', () => {
    expect(rule('.stat-tile.is-button')).toMatch(/display:\s*flex/);
    expect(rule('.stat-tile-button')).toMatch(/flex:\s*1/);
  });

  it('the tile, not the button, carries the selected ring and a bold label', () => {
    const ring = rule(PRESSED_TILE);
    expect(ring).toMatch(/box-shadow:\s*0 0 0 2px var\(--bg\),\s*0 0 0 4px currentColor/);
    expect(rule(`${PRESSED_TILE} .stat-label`)).toMatch(/font-weight:\s*700/);
  });

  it('the pressed button draws no border or ring of its own', () => {
    expect(css).not.toMatch(/\.stat-tile-button\[aria-pressed="true"\]\s*\{/);
    expect(rule('.stat-tile-button')).toMatch(/border:\s*0/);
  });
});
