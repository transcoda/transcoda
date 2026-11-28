import { describe, expect, it } from 'vitest';
import { stylesCss } from './testing/css-source.ts';

const css = stylesCss;

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

const PRESSED_TILE = '.stat-tile:has(> .stat-tile-button[aria-pressed="true"])';

describe('Jobs row detail (#44)', () => {
  it('is clamped to two lines and breaks a long word', () => {
    const clamp = rule('.job-detail-clamp');
    expect(clamp).toMatch(/-webkit-line-clamp:\s*2/);
    expect(clamp).toMatch(/overflow:\s*hidden/);
    expect(clamp).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('Jobs table (long titles)', () => {
  it('a title keeps one line with an ellipsis', () => {
    const t = rule('.job-title-text');
    expect(t).toMatch(/overflow:\s*hidden/);
    expect(t).toMatch(/text-overflow:\s*ellipsis/);
    expect(t).toMatch(/white-space:\s*nowrap/);
  });

  it('a job name (phone cards, Run page) keeps one line with an ellipsis', () => {
    const n = rule('.job-name');
    expect(n).toMatch(/overflow:\s*hidden/);
    expect(n).toMatch(/text-overflow:\s*ellipsis/);
    expect(n).toMatch(/white-space:\s*nowrap/);
  });

  it('column widths are fixed, so a long title never widens the table', () => {
    expect(rule('.job-table')).toMatch(/table-layout:\s*fixed/);
  });

  it('the minimum width leaves the Title column at least 240 px, with or without Actions', () => {
    const px = (decls: string, prop: string): number =>
      Number(decls.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`))?.[1] ?? Number.NaN);
    const col = (name: string) => px(rule(`.job-col-${name}`), 'width');
    const fixed = ['library', 'workflow', 'status', 'result', 'when'].reduce(
      (sum, c) => sum + col(c),
      0,
    );
    expect(Number.isNaN(fixed)).toBe(false);
    expect(px(rule('.job-table'), 'min-width') - fixed).toBeGreaterThanOrEqual(240);
    expect(
      px(rule('.job-table.has-actions'), 'min-width') - fixed - col('actions'),
    ).toBeGreaterThanOrEqual(240);
    // The table scrolls sideways inside its rounded box, not the page.
    expect(rule('.job-list')).toMatch(/overflow-x:\s*auto/);
  });
});

describe('Jobs on a narrow window', () => {
  /** The body of the `@container jobs-overview (max-width: Npx)` block. */
  const container = (max: number): string => {
    const start = css.indexOf(`@container jobs-overview (max-width: ${max}px) {`);
    if (start < 0) return '';
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
    }
    return '';
  };

  it('the tiles and history cards respond to the space beside the sidebar', () => {
    expect(rule('.jobs-overview')).toMatch(/container:\s*jobs-overview\s*\/\s*inline-size/);
  });

  it('below one row, "Saved all time" goes under the tiles and the cards go 2 × 2', () => {
    const block = container(699);
    expect(block).toMatch(/\.stat-row\s*\{\s*flex-wrap:\s*wrap/);
    expect(block).toMatch(/\.history-cards\s*\{\s*grid-template-columns:\s*repeat\(2,/);
  });

  it('narrower still, the lead tile takes its own row and the other three share the next', () => {
    const block = container(559);
    expect(block).toMatch(/\.stat-row > \.stat-tiles\s*\{\s*flex-wrap:\s*wrap/);
    expect(block).toMatch(/\.stat-row > \.stat-tiles > \.stat-tile\s*\{\s*flex:\s*1 1 0/);
    expect(block).toMatch(/\.stat-tile\.is-lead\s*\{\s*flex-basis:\s*100%/);
  });

  it('without room for every column, Library and Workflow give way and the Title keeps 240 px', () => {
    expect(rule('.job-list')).toMatch(/container:\s*job-list\s*\/\s*inline-size/);
    const px = (decls: string, prop: string): number =>
      Number(decls.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`))?.[1] ?? Number.NaN);
    const col = (name: string) => px(rule(`.job-col-${name}`), 'width');
    const kept = ['status', 'result', 'when'].reduce((sum, c) => sum + col(c), 0);
    const plain = px(rule('.job-table'), 'min-width');
    const actions = px(rule('.job-table.has-actions'), 'min-width');
    // The queries start one pixel below each full minimum width.
    const block = (max: number) => {
      const start = css.indexOf(`@container job-list (max-width: ${max}px) {`);
      return start < 0 ? '' : css.slice(start, css.indexOf('\n}', start));
    };
    const narrowPlain = block(plain - 1);
    const narrowActions = block(actions - 1);
    expect(narrowPlain).toMatch(
      /\.job-table:not\(\.has-actions\) \.job-optional\s*\{\s*display:\s*none/,
    );
    const minOf = (b: string) => Number(b.match(/min-width:\s*(\d+)px/)?.[1] ?? Number.NaN);
    expect(minOf(narrowPlain) - kept).toBeGreaterThanOrEqual(240);
    // With running jobs, When gives way too and Result narrows, so Pause and Cancel stay in view
    // at 1024 px beside the full sidebar (about 720 px of list); the Title keeps 200 px.
    expect(narrowActions).toMatch(
      /\.job-table\.has-actions \.job-optional,\s*\.job-table\.has-actions \.job-when,\s*\.job-table\.has-actions \.job-col-when\s*\{\s*display:\s*none/,
    );
    const narrowResult = px(
      narrowActions.match(/\.job-table\.has-actions \.job-col-result\s*\{([^}]*)\}/)?.[1] ?? '',
      'width',
    );
    const activeMin = minOf(narrowActions);
    expect(activeMin).toBeLessThanOrEqual(720);
    expect(activeMin - col('status') - narrowResult - col('actions')).toBeGreaterThanOrEqual(200);
  });

  it('each narrow-window rule comes after the base rule it overrides (same weight: order wins)', () => {
    const at = (needle: string) => {
      const i = css.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const overview = at('@container jobs-overview (max-width: 699px)');
    expect(overview).toBeGreaterThan(at('\n.history-cards {'));
    expect(overview).toBeGreaterThan(at('\n.stat-row > .stat-tiles {'));
    expect(at('@container jobs-overview (max-width: 559px)')).toBeGreaterThan(overview);
    const list = at('@container job-list (max-width: 1009px)');
    expect(list).toBeGreaterThan(at('\n.job-col-result {'));
    expect(list).toBeGreaterThan(at('\n.job-table td.job-when {'));
  });

  it('the queue buttons wrap under the title instead of squeezing it', () => {
    expect(rule('.jobs-head.head-row')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.jobs-title')).toMatch(/flex:\s*1 1 280px/);
  });

  it('a long status wraps inside its column instead of running into Result', () => {
    const chip = rule('.job-table .job-chip');
    expect(chip).toMatch(/white-space:\s*normal/);
    expect(chip).toMatch(/max-width:\s*100%/);
    expect(chip).toMatch(/height:\s*auto/);
    expect(rule('.job-table .job-chips')).toMatch(/max-width:\s*100%/);
  });
});

describe('Jobs stat tiles (#31)', () => {
  it('the button fills the stretched tile, so no tinted band shows under it', () => {
    expect(rule('.stat-tile.is-button')).toMatch(/display:\s*flex/);
    expect(rule('.stat-tile-button')).toMatch(/flex:\s*1/);
  });

  it('the tile, not the button, carries the selected ring, and the label keeps its weight', () => {
    const ring = rule(PRESSED_TILE);
    expect(ring).toMatch(/box-shadow:\s*0 0 0 2px var\(--bg\),\s*0 0 0 4px currentColor/);
    expect(css).not.toMatch(
      /\.stat-tile:has\(> \.stat-tile-button\[aria-pressed="true"\]\) \.stat-label/,
    );
  });

  it('the pressed button draws no border or ring of its own', () => {
    expect(css).not.toMatch(/\.stat-tile-button\[aria-pressed="true"\]\s*\{/);
    expect(rule('.stat-tile-button')).toMatch(/border:\s*0/);
  });
});

describe('Jobs stat tiles: one figure leads', () => {
  it('the lead tile is wider and its figure is a step larger than the others', () => {
    expect(rule('.stat-tile.is-lead')).toMatch(/flex:\s*2/);
    expect(rule('.stat-value')).toMatch(/font-size:\s*var\(--fs-h2\)/);
    expect(rule('.stat-tile.is-lead .stat-value')).toMatch(/font-size:\s*var\(--fs-h1\)/);
  });

  it('on a phone the lead has its own row, so NEEDS ATTENTION fits its tile', () => {
    expect(rule('.is-phone .stat-row > .stat-tiles')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.is-phone .stat-tile.is-lead')).toMatch(/flex-basis:\s*100%/);
  });
});

describe('Jobs stat tiles (#54)', () => {
  it('values never break across lines, and "Saved today" is a plain tile with an accent value', () => {
    expect(rule('.stat-value')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.stat-tile.has-accent-value .stat-value')).toMatch(
      /color:\s*var\(--accent-text\)/,
    );
    expect(css).not.toMatch(/\.stat-tile\.has-accent-value\s*\{[^}]*background/);
  });
});

describe('Jobs table When column', () => {
  it('is 100px wide, room for "28 min ago" after its padding, and the table minimums follow', () => {
    expect(rule('.job-col-when')).toMatch(/width:\s*100px/);
    expect(rule('.job-table')).toMatch(/min-width:\s*1010px/);
    expect(rule('.job-table.has-actions')).toMatch(/min-width:\s*1160px/);
  });
});
