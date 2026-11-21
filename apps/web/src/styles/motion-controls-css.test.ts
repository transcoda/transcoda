// Design audit fixes (2026-11-20): control edges, motion, press state, hover on touch, no glows.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8');
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`, at any depth. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('form control edges', () => {
  it('every form control edge uses --line-control', () => {
    for (const sel of [
      '.input',
      '.tc-segmented',
      '.tc-chips',
      '.listbox-select-field .listbox-select-button',
      '.tc-onnode-input,\n.tc-onnode-select',
      '.tc-chip-add,\n.tc-toggle-chip',
    ]) {
      expect(rule(sel), sel).toMatch(/border: [\d.]+px solid var\(--line-control\)/);
    }
  });
});

describe('motion', () => {
  it('defines the motion tokens', () => {
    expect(tokens).toMatch(/--ease-out: cubic-bezier\(0\.23, 1, 0\.32, 1\);/);
    expect(tokens).toMatch(/--dur-fast: 120ms;/);
    expect(tokens).toMatch(/--dur-base: 160ms;/);
  });

  it('reduced motion clamps durations instead of removing animations', () => {
    const reduce =
      tokens.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(reduce).toMatch(/\*::before/);
    expect(reduce).toMatch(/animation-duration: 0\.01ms !important/);
    expect(reduce).toMatch(/animation-iteration-count: 1 !important/);
    expect(reduce).toMatch(/transition-duration: 0\.01ms !important/);
    expect(reduce).not.toMatch(/animation: none/);
  });

  it('every UI transition uses the motion tokens; only progress fills stay linear', () => {
    const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    expect(transitions.length).toBeGreaterThan(5);
    for (const t of transitions) {
      if (t === 'none' || / linear$/.test(t)) continue;
      for (const part of t.split(',')) {
        expect(part, t).toMatch(/var\(--dur-(fast|base)\) var\(--ease-out\)/);
      }
    }
  });

  it('every looping animation has a still state under reduced motion', () => {
    // Loops that run regardless of the preference are switched off under reduce.
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.tc-edge\.edge-path\s*\{\s*animation: none/,
    );
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.tc-node\.is-running::before\s*\{\s*animation: none;\s*background: var\(--accent\)/,
    );
    // The spinners only turn when motion is allowed.
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\)\s*\{\s*\.job-chip\.is-working \.icon\s*\{\s*animation:/,
    );
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\)\s*\{\s*\.loading-spinner\s*\{\s*animation:/,
    );
  });

  it('a button moves down a pixel when pressed, only when motion is allowed, and not its hit area', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\)\s*\{[^@]*\.btn:active:not\(:disabled\)\s*\{\s*transform: translateY\(1px\)/,
    );
    expect(css).not.toMatch(/:active::before/);
  });
});

describe('hover on touch', () => {
  it('hover fills and colours apply only where a pointer hovers', () => {
    for (const sel of [
      '.btn-ghost:hover',
      'a.nav-item:hover',
      '.row-link:hover',
      '.versions-row:hover',
    ]) {
      const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(css, sel).toMatch(new RegExp(`@media \\(hover: hover\\) \\{\\s*${escaped} \\{`));
    }
    // Keyboard focus is never gated.
    expect(rule('.versions-row:focus-visible')).toContain('background: var(--line)');
  });
});

describe('no side tabs, no glows', () => {
  it('the viewed version row is a fill, not an inset bar', () => {
    const current = rule('.versions-row[aria-current="page"]');
    expect(current).not.toMatch(/inset/);
    expect(current).toContain('background: var(--line)');
  });

  it('a selected edge is a heavier stroke, not a drop-shadow glow', () => {
    expect(css).not.toMatch(/drop-shadow/);
    expect(rule('.react-flow__edge.selected .tc-edge')).toMatch(
      /stroke-width: calc\(var\(--edge-w/,
    );
  });
});

describe('type details', () => {
  it('the danger outline button reads at the UI size (14px)', () => {
    expect(rule('.btn-danger-outline')).toContain('font-size: var(--fs-ui)');
  });

  it('display headings sit at line-height 1.2', () => {
    expect(rule('h1,\nh2')).toContain('line-height: 1.2');
  });
});
