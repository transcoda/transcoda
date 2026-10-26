import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string, from = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return from.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

/** The "App shell" section, where the widget's rules live. */
const shell = css.slice(
  css.indexOf('/* ---------- App shell (screens/02, 03) ---------- */'),
  css.indexOf('/* ---------- Workflow canvas (screens/02) ---------- */'),
);

/** Every `.activity…` rule body in the stylesheet. */
const activityRules = [...css.matchAll(/(^|\n)[^\n{}]*\.activity[^{}]*\{([^}]*)\}/g)].map(
  (m) => m[0],
);

describe('activity widget CSS (#9)', () => {
  it('lives in the App shell section', () => {
    expect(activityRules.length).toBeGreaterThan(0);
    for (const r of activityRules) expect(shell).toContain(r.trim());
  });

  it('the button is a full-size target with the focus ring on :focus-visible', () => {
    expect(rule('.activity-button', shell)).toMatch(/min-height:\s*var\(--target-min\)/);
    expect(rule('.activity-button', shell)).toMatch(/min-width:\s*var\(--target-min\)/);
    expect(rule('.activity-button:focus-visible', shell)).toMatch(/var\(--focus-ring\)/);
  });

  it('the ring moves smoothly, but not under reduced motion', () => {
    expect(rule('.activity-ring-value', shell)).toMatch(/transition:\s*stroke-dashoffset/);
    const reduced = [
      ...shell.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g),
    ].map((m) => m[1] ?? '');
    expect(
      reduced.some((body) => /\.activity-ring-value\s*\{[^}]*transition:\s*none/.test(body)),
    ).toBe(true);
  });

  it('the panel is anchored under the button and fits a phone', () => {
    const panel = rule('.activity-panel', shell);
    expect(panel).toMatch(/position:\s*absolute/);
    expect(panel).toMatch(/right:\s*0/);
    expect(panel).toMatch(/width:\s*min\(360px, calc\(100vw - 32px\)\)/);
  });

  it('uses tokens only: no hex colours', () => {
    for (const r of activityRules) expect(r).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
