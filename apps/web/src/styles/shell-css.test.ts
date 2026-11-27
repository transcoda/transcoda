import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BP_DESKTOP_MAX, BP_PHONE_MAX, BP_TABLET_MAX } from '../lib/breakpoints.ts';
import { stylesCss } from './css-source.ts';

const css = stylesCss;
const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

function rule(source: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('editor canvas controls (#45)', () => {
  it("our stroked icons are not filled by React Flow's control style (no blank square)", () => {
    expect(rule(css, '.canvas .react-flow__controls-button svg.icon')).toMatch(/fill:\s*none/);
  });
});

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
    const onLime = css.match(/[^}]*\.btn-primary:focus-visible[^{]*\{([^}]*)\}/)?.[1] ?? '';
    expect(onLime).toMatch(/--focus-ring-on-accent/);
  });

  it('marks the current nav item with a neutral fill and a green icon, not a lime fill', () => {
    const active = css.match(/\na\.nav-item\.is-active \{([^}]*)\}/)?.[1] ?? '';
    expect(active).toContain('background: var(--raised)');
    expect(active).toContain('color: var(--text)');
    expect(active).not.toMatch(/--accent|font-weight|inset/);
    expect(css).toMatch(/\n\.nav-item\.is-active \.icon \{\s*color: var\(--accent-text\)/);
  });

  it('uses only the named breakpoints (phone 639, tablet 1023, desktop 1280 inclusive; 899 is the auth page)', () => {
    const widths = new Set(
      [...css.matchAll(/@media[^{]*max-width:\s*(\d+)px/g)].map((m) => Number(m[1])),
    );
    for (const w of widths) expect([BP_PHONE_MAX, 899, BP_TABLET_MAX, BP_DESKTOP_MAX]).toContain(w);
  });
});
