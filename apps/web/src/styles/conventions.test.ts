// The shared conventions of the UI consistency pass, pinned in the stylesheet.
import { describe, expect, it } from 'vitest';
import { stylesCss } from './testing/css-source.ts';

// Comments dropped, so a rule's selector list is only selectors.
const css = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector list contains `selector` as one entry, at the
 *  top level or one level inside an at-rule such as `@media (hover: hover)`. */
function rulesFor(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/(?:^|\n)\s*([^{}\s@][^{}]*)\{([^}]*)\}/g)) {
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

describe('the library name on the Libraries page reads as a link (not by hover or colour alone)', () => {
  it('is accent and underlined at rest, with a focus ring', () => {
    expect(rulesFor('.lib-name-text')).toMatch(/color:\s*var\(--accent-text\)/);
    expect(rulesFor('.lib-name-text')).toMatch(/text-decoration:\s*underline/);
    expect(rulesFor('.lib-name-text:focus-visible')).toMatch(/box-shadow:\s*var\(--focus-ring\)/);
  });
});

describe('accessibility: focus and target size', () => {
  it('focus and in-page jumps stop below the sticky top bar; the editor has no top bar', () => {
    expect(rulesFor('html')).toMatch(
      /scroll-padding-top:\s*calc\(var\(--topbar-h\) \+ var\(--sp-4\)\)/,
    );
    expect(rulesFor('html:has(.editor)')).toMatch(/scroll-padding-top:\s*0/);
  });

  it('a small button keeps a 44 px hit area around its 36 px box, border or not', () => {
    expect(rulesFor('.btn-sm')).toMatch(/height:\s*36px/);
    expect(rulesFor('.btn')).toMatch(/position:\s*relative/);
    const before = rulesFor('.btn-sm::before');
    expect(before).toMatch(/content:\s*""/);
    expect(before).toMatch(/position:\s*absolute/);
    // A height, not an inset: an inset counts from the padding box and loses the border.
    expect(before).toMatch(/height:\s*var\(--target-min\)/);
    expect(before).toMatch(/top:\s*50%/);
    expect(before).toMatch(/transform:\s*translateY\(-50%\)/);
    expect(before).not.toMatch(/inset:/);
    expect(rulesFor('.editor-head .btn::before')).toMatch(/height:\s*var\(--target-min\)/);
  });

  it('small text links grow to 24 px without moving the text', () => {
    const rule = rulesFor('.text-target');
    expect(rule).toMatch(/padding-block:\s*var\(--sp-1\)/);
    expect(rule).toMatch(/margin-block:\s*-4px/);
    expect(rulesFor('.wf-activate')).toMatch(/min-height:\s*32px/);
    expect(rulesFor('.lib-name-text')).toMatch(/padding:\s*var\(--sp-1\)/);
  });

  it("the canvas's + and group toggle never drop below 24 px on screen when zoomed out", () => {
    for (const sel of ['.tc-plus', '.tc-group-toggle']) {
      const rule = rulesFor(sel);
      expect(rule).toMatch(
        /--tc-hit:\s*max\(var\(--target-min\), calc\(24px \/ var\(--tc-zoom, 1\)\)\)/,
      );
      expect(rule).toMatch(/width:\s*var\(--tc-hit\)/);
      expect(rule).toMatch(/height:\s*var\(--tc-hit\)/);
    }
  });

  it("the canvas's + starts past the output handle's hit area at every zoom, so a handle drag is never blocked", () => {
    // Its right edge sits `gap + --tc-hit` right of the card edge, so its left edge is `gap` right
    // of the card edge, whatever --tc-hit grows to as the canvas zooms out.
    const plus = rulesFor('.tc-plus');
    const gap = Number(
      plus.match(/right:\s*calc\(-(\d+)px - var\(--tc-hit\)\)/)?.[1] ?? Number.NaN,
    );
    // The handle is centred on the card edge; its hit area is half its width plus the ::after.
    const handle = rulesFor('.tc-node .tc-handle');
    const half = Number(handle.match(/(?:^|\n)\s*width:\s*(\d+)px/)?.[1] ?? Number.NaN) / 2;
    const after = rulesFor('.tc-node .tc-handle::after');
    const reach = -Number(after.match(/inset:\s*(-\d+)px/)?.[1] ?? Number.NaN);
    expect(half + reach).toBe(15);
    expect(gap).toBeGreaterThanOrEqual(half + reach);
  });
});

describe('the canvas colour scheme (React Flow 13)', () => {
  it("the canvas keeps the app's colour scheme; the box-select rectangles keep React Flow's dark one", () => {
    // forceColorMode="dark" sets color-scheme: dark on .react-flow (in React Flow's @layer xyflow);
    // the cards' selects, inputs and buttons follow the app's theme as with React Flow 12.
    expect(rulesFor('.canvas .react-flow')).toMatch(/color-scheme:\s*inherit/);
    expect(rulesFor('.canvas .react-flow__selection')).toMatch(/color-scheme:\s*dark/);
    expect(rulesFor('.canvas .react-flow__nodesselection-rect')).toMatch(/color-scheme:\s*dark/);
  });
});

describe('Jobs stat tiles on a phone', () => {
  it('a filtering tile stays unpadded so its button covers the whole tile', () => {
    expect(rulesFor('.stat-tile.is-button')).toMatch(/padding:\s*0/);
    // No phone rule pads every tile (that would pad the filtering tile around its button).
    expect(rulesFor('.is-phone .stat-tile')).not.toMatch(/padding/);
    expect(rulesFor('.is-phone .stat-tile:not(.is-button)')).toMatch(
      /padding-inline:\s*var\(--sp-3\)/,
    );
    expect(rulesFor('.is-phone .stat-tile-button')).toMatch(/padding-inline:\s*var\(--sp-3\)/);
  });
});
