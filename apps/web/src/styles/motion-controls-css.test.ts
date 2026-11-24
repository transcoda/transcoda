// Design audit fixes (2026-11-20): control edges, motion, press state, hover on touch, no glows.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commaValues, declsOf, spaceValues } from './css-source.ts';
import { LINEAR_PROGRESS } from './design-exceptions.ts';

const tokens = readFileSync(join(__dirname, 'tokens.css'), 'utf8');
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`, at any depth. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

/** The progress fills: the only rules whose transition may run at a linear pace. */
const PROGRESS = Object.keys(LINEAR_PROGRESS);

/** Every transition declaration (the shorthand and its timing longhands) with the selector list
 *  of the rule that holds it, at any depth. */
function transitionsOf(source: string): { selectors: string[]; prop: string; value: string }[] {
  return declsOf(source)
    .filter((d) => /^transition(-duration|-timing-function)?$/.test(d.prop))
    .map((d) => ({ selectors: d.selectors, prop: d.prop, value: d.value }));
}

const DURATION_TOKEN = /^var\(--dur-(fast|base)\)$/;
const TIME = /^[\d.]+m?s$/;
const EASING =
  /^(var\(--ease-[\w-]+\)|linear|ease(-in|-out|-in-out)?|step-(start|end)|(cubic-bezier|steps|linear)\(.*\))$/;

/** One layer of a transition shorthand, read by position: the first time is the duration and
 *  the second the delay (CSS Transitions › transition). A token counts as a time. */
function transitionLayer(layer: string): {
  property?: string;
  duration?: string;
  delay?: string;
  easing?: string;
  unknown: string[];
} {
  const out: ReturnType<typeof transitionLayer> = { unknown: [] };
  for (const part of spaceValues(layer)) {
    const isTime = TIME.test(part) || /^var\(--dur-[\w-]+\)$/.test(part);
    if (isTime && out.duration === undefined) out.duration = part;
    else if (isTime && out.delay === undefined) out.delay = part;
    else if (EASING.test(part) && out.easing === undefined) out.easing = part;
    else if (/^[a-z-]+$/.test(part) && out.property === undefined) out.property = part;
    else out.unknown.push(part);
  }
  return out;
}

const ms = (t: string) => (t.endsWith('ms') ? Number.parseFloat(t) : Number.parseFloat(t) * 1000);

/** Transitions off the motion tokens: every layer's duration is --dur-fast or --dur-base and
 *  its easing --ease-out, with no delay. Linear is allowed only on a rule of progress fills
 *  alone, at 400ms to 600ms (DESIGN.md › Motion). */
function transitionProblems(source: string): string[] {
  const bad: string[] = [];
  for (const { selectors, prop, value } of transitionsOf(source)) {
    if (value === 'none') continue;
    const progress = selectors.length > 0 && selectors.every((s) => PROGRESS.includes(s));
    const ok = commaValues(value).every((part) => {
      if (prop === 'transition-duration') return DURATION_TOKEN.test(part);
      if (prop === 'transition-timing-function') return part === 'var(--ease-out)';
      const { duration = '', delay, easing, unknown } = transitionLayer(part);
      if (unknown.length > 0 || delay !== undefined) return false;
      if (DURATION_TOKEN.test(duration) && easing === 'var(--ease-out)') return true;
      return (
        progress &&
        easing === 'linear' &&
        TIME.test(duration) &&
        ms(duration) >= 400 &&
        ms(duration) <= 600
      );
    });
    if (!ok) bad.push(`${selectors.join(', ')} { ${prop}: ${value} }`);
  }
  return bad;
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
    expect(
      transitionProblems(css),
      'DESIGN.md › Motion: transitions use --dur-fast/--dur-base and --ease-out; linear only on the progress fills (styles/design-exceptions.ts LINEAR_PROGRESS)',
    ).toEqual([]);
    // The check is not vacuous: it sees transitions, including both progress fills.
    const seen = transitionsOf(css);
    expect(seen.length).toBeGreaterThan(5);
    for (const sel of PROGRESS)
      expect(
        seen.some((t) => t.selectors.includes(sel)),
        sel,
      ).toBe(true);
  });

  it('the linear exception holds only for the progress fills', () => {
    expect(transitionProblems('.scope-chip { transition: background-color 2s linear; }')).toEqual([
      '.scope-chip { transition: background-color 2s linear }',
    ]);
    expect(
      transitionProblems(
        '.tc-node .tc-node-fill, .scope-chip { transition: clip-path 1s linear; }',
      ),
    ).toHaveLength(1);
    expect(
      transitionProblems('.activity-ring-value { transition: opacity 500ms linear; }'),
    ).toEqual([]);
    // Progress fills run 400ms to 600ms.
    expect(
      transitionProblems('.activity-ring-value { transition: opacity 2s linear }'),
    ).toHaveLength(1);
    // A last declaration without a semicolon, and the timing longhands.
    expect(transitionProblems('.a { transition: opacity 1s ease }')).toHaveLength(1);
    expect(transitionProblems('.a { transition-duration: 300ms }')).toHaveLength(1);
    expect(transitionProblems('.a { transition-timing-function: linear }')).toHaveLength(1);
    // The shorthand is read by position: the first time is the duration, the second the delay.
    expect(
      transitionProblems('.a { transition: opacity 10s var(--dur-fast) var(--ease-out) }'),
    ).toHaveLength(1);
    expect(
      transitionProblems(
        '.a { transition: transform var(--dur-fast) var(--ease-out), opacity 10s var(--dur-fast) var(--ease-out) }',
      ),
    ).toHaveLength(1);
    expect(
      transitionProblems('.a { transition: opacity var(--ease-out) var(--dur-base) }'),
    ).toEqual([]);
    expect(
      transitionProblems(
        '.a { transition: transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out) }',
      ),
    ).toEqual([]);
    expect(
      transitionProblems(
        '@media (hover: hover) { .a { transition: color var(--dur-fast) var(--ease-out) } }',
      ),
    ).toEqual([]);
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
