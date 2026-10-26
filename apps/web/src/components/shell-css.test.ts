import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string, from = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return from.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

/** The App shell section, and its phone-width media blocks joined. */
const shell = css.slice(
  css.indexOf('/* ---------- App shell (screens/02, 03) ---------- */'),
  css.indexOf('/* ---------- Workflow canvas (screens/02) ---------- */'),
);
const phone = [...shell.matchAll(/@media \(max-width: 639px\)\s*\{([\s\S]*?)\n\}/g)]
  .map((m) => m[1] ?? '')
  .join('\n');

describe('side nav divider runs the full height (#42)', () => {
  it('the shell body fills the window and the main column stretches to it', () => {
    expect(rule('.shell', shell)).toMatch(/min-height:\s*100vh/);
    expect(rule('.shell-body', shell)).toMatch(/flex:\s*1\b/);
    // Stretching (the flex default) is what makes the line reach the bottom: never opt out.
    expect(rule('.shell-main', shell)).not.toMatch(/align-self/);
  });

  it('the divider is drawn by the main column, not the content-tall sticky nav', () => {
    expect(rule('.shell-main', shell)).toMatch(/border-left:\s*1px solid var\(--line\)/);
    expect(rule('.sidenav', shell)).not.toMatch(/border-right/);
  });

  it('the phone layout (nav as a drawer above the page) has no divider', () => {
    expect(rule('.shell-main', phone)).toMatch(/border-left:\s*0/);
    // Same specificity as the base rule: the override must come after it to win.
    expect(shell.lastIndexOf('border-left: 0')).toBeGreaterThan(shell.indexOf('.shell-main {'));
  });
});
