// The shared conventions of the UI consistency pass, pinned in the stylesheet.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Comments dropped, so a rule's selector list is only selectors.
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector list contains `selector` as one entry. */
function rulesFor(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((x) => x.trim());
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  return out.join('\n');
}

describe('chips (conventions 7/8)', () => {
  it('the status chip is the Jobs list chip: sans, one size', () => {
    const chip = rulesFor('.chip');
    expect(chip).not.toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(chip).toMatch(/height:\s*28px/);
    expect(chip).toMatch(/font-size:\s*var\(--fs-small\)/);
    expect(rulesFor('.job-chip')).toMatch(/height:\s*28px/);
  });

  it('no change is a neutral outline: kept original, nothing to do, skipped', () => {
    for (const v of ['kept', 'noop', 'skipped', 'cancelled', 'already']) {
      const rule = rulesFor(`.job-chip.is-${v}`);
      expect(rule).toMatch(/background:\s*transparent/);
      expect(rule).toMatch(/border-color:\s*var\(--line-strong\)/);
    }
    expect(rulesFor('.chip-neutral')).toMatch(/var\(--line-strong\)/);
    // "Kept original" is no longer the bright blue anywhere in the jobs list.
    expect(rulesFor('.job-chip.is-kept')).not.toContain('--st-kept');
    expect(rulesFor('.phone-finished-icon.is-kept')).not.toContain('--st-kept');
  });
});

describe('stat tiles (convention 6)', () => {
  it('no tile is filled: saved, failed, attention and all time are plain tiles', () => {
    for (const v of ['is-saved', 'is-failed', 'is-attention', 'is-alltime']) {
      expect(rulesFor(`.stat-tile.${v}`)).not.toMatch(/background/);
    }
  });
  it('a zero that is not good news is dimmed', () => {
    expect(rulesFor('.stat-tile.is-zero .stat-value')).toMatch(/color:\s*var\(--faint\)/);
  });
});

describe('headings and links (conventions 4/5/9)', () => {
  it('section heading and group label are sans, sentence case', () => {
    for (const sel of ['.section-h2', '.group-h3']) {
      expect(rulesFor(sel)).toMatch(/text-transform:\s*none/);
      expect(rulesFor(sel)).toMatch(/font-family:\s*var\(--font-ui\)/);
    }
    expect(rulesFor('.section-count')).toMatch(/color:\s*var\(--muted\)/);
    expect(rulesFor('.group-h3')).toMatch(/color:\s*var\(--muted\)/);
  });
  it('a row name is semibold and never underlined; secondary links underline on hover', () => {
    expect(rulesFor('.row-link-main')).toMatch(/font-weight:\s*600/);
    expect(rulesFor('.row-link-main:hover')).toMatch(/text-decoration:\s*none/);
    expect(rulesFor('.link-muted')).toMatch(/text-decoration:\s*none/);
    expect(rulesFor('.link-muted:hover')).toMatch(/text-decoration:\s*underline/);
    expect(rulesFor('.job-name:hover')).not.toMatch(/underline/);
  });
});

describe('no coloured edge bars (convention 16)', () => {
  it('run tiles carry no outcome-coloured left edge', () => {
    expect(css).not.toMatch(/border-left:\s*\d+px solid var\(--outcome\)/);
  });
});
