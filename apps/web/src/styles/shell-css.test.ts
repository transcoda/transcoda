import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

function rule(source: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('shell css (UI review H1, M15, L10, L15)', () => {
  it('keeps the top bar and the side nav in view on long pages', () => {
    expect(rule(css, '.topbar')).toMatch(/position:\s*sticky/);
    expect(rule(css, '.topbar')).toMatch(/top:\s*0/);
    expect(rule(css, '.topbar')).toMatch(/z-index/);
    expect(rule(css, '.shell:not(.is-rail) .sidenav')).toMatch(/position:\s*sticky/);
    expect(rule(css, '.shell:not(.is-rail) .sidenav')).toMatch(/top:\s*var\(--topbar-h\)/);
  });

  it('has a skip link that appears on focus', () => {
    expect(rule(css, '.skip-link')).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/\.skip-link:focus/);
  });

  it('Jobs no longer carries a private phone header or menu', () => {
    expect(css).not.toMatch(/\.jobs-menu/);
    expect(css).not.toMatch(/jobs-page\[data-menu/);
    expect(css).not.toMatch(/jobs-page\.is-phone\) > \.topbar/);
  });

  it('draws a visible focus ring on lime elements (ring in the text colour)', () => {
    expect(tokens).toMatch(/--focus-ring-on-accent:/);
    const onLime =
      css.match(/[^}]*a\.nav-item\.is-active:focus-visible[^{]*\{([^}]*)\}/)?.[1] ?? '';
    expect(onLime).toMatch(/--focus-ring-on-accent/);
    expect(css).toMatch(/\.btn-primary:focus-visible/);
  });

  it('uses only the named breakpoints (phone 639, tablet 1023, desktop 1280 inclusive; 899 is the auth page)', () => {
    const widths = new Set(
      [...css.matchAll(/@media[^{]*max-width:\s*(\d+)px/g)].map((m) => Number(m[1])),
    );
    for (const w of widths) expect([639, 899, 1023, 1280]).toContain(w);
  });
});
