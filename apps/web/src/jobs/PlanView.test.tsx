import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blueyPlan, blueyProbe, blueyResult, identityPlan } from '../test/fixtures/plan.ts';
import { PlanView } from './PlanView.tsx';

afterEach(cleanup);

const ACTIVE = {
  version: 7,
  runnable: true,
  activatedAt: '2026-10-16T18:00:00.000Z',
  activatedBy: 'u1',
};
// The plan is for v8; v7 is the active one.
const workflow = { id: 'wf1', name: 'TV cleanup', version: 8, active: ACTIVE };

function rowOf(table: HTMLElement, text: string): HTMLElement {
  const cell = within(table).getByRole('rowheader', { name: new RegExp(`^${text}`) });
  return cell.closest('tr') as HTMLElement;
}

/** The DEFAULT column's words ("no yes": before, an arrow, after). */
function defaultWords(row: HTMLElement): string {
  const cells = within(row).getAllByRole('cell');
  return (cells[1]?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('PlanView', () => {
  it('PlanView renders the eyebrow, tiles, audio rows with ORIGINAL tag and default no → yes / yes → gone, subtitles, video line and buttons', () => {
    const onActivate = vi.fn();
    const onTryAnother = vi.fn();
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={onActivate}
        onTryAnother={onTryAnother}
      />,
    );
    expect(screen.getByText('Nothing on disk changed')).toBeTruthy();
    const would = screen.getByText('Would do').parentElement as HTMLElement;
    expect(would.textContent).toBe('Would doRewrite once');
    const size = screen.getByText('Size (est.)').parentElement as HTMLElement;
    expect(size.textContent).toBe('Size (est.)2.41 → 1.62 GB');
    expect(screen.getByText('−33%')).toBeTruthy();

    const audio = screen.getByRole('region', { name: 'Audio' });
    expect(within(audio).getByText('3 of 20 tracks kept')).toBeTruthy();
    const table = within(audio).getByRole('table');
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual(['Language', 'Tracks', 'Default', 'Result']);

    const english = rowOf(table, 'English');
    expect(within(english).getByText('eng')).toBeTruthy();
    expect(within(english).getByText('a:2 · AAC 5.1')).toBeTruthy();
    expect(defaultWords(english)).toBe('No Yes');
    expect(within(english).getByText('Keep')).toBeTruthy();

    const japanese = rowOf(table, 'Japanese');
    expect(within(japanese).getByText('Original')).toBeTruthy();
    expect(within(japanese).getByText('a:11 · AAC 2.0')).toBeTruthy();
    expect(defaultWords(japanese)).toBe('No');

    const turkish = rowOf(table, 'Turkish');
    expect(defaultWords(turkish)).toBe('Yes Gone');
    expect(within(turkish).getByText('Drop')).toBeTruthy();

    // The rows: the three kept languages, then Turkish; the rest fold into the drop line.
    const languages = within(table)
      .getAllByRole('rowheader')
      .map((c) => c.firstChild?.textContent);
    expect(languages).toEqual(['English', 'German', 'Japanese', 'Turkish']);
    const drop = within(audio).getByText(
      'Drop 16 more in 14 languages: French, Spanish, Italian, Portuguese …',
    );
    const details = drop.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Portuguese')).toBeTruthy();
    expect(within(details).getByText('a:19')).toBeTruthy();

    const subs = screen.getByRole('region', { name: 'Subtitles' });
    expect(within(subs).getByText('4 of 21 tracks kept')).toBeTruthy();
    expect(within(subs).getByText('s:2 · signs and songs')).toBeTruthy();
    expect(within(subs).getByText(/^Drop 17 more in /)).toBeTruthy();

    const other = screen.getByRole('region', { name: 'Video and attachments' });
    expect(other.textContent).toContain('v:0 · HEVC 1080p · 6.1 Mb/s');
    expect(other.textContent).toContain('copied, already under 8 Mb/s');
    expect(other.textContent).toContain('cover.png');
    expect(other.textContent).toContain('kept, no rule applies');
    expect(other.textContent).toContain('Container MP4 → MKV · remux');

    fireEvent.click(screen.getByRole('button', { name: 'Activate v8 of TV cleanup…' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dry run another file' }));
    expect(onTryAnother).toHaveBeenCalledTimes(1);
  });

  it('an identity plan says "WOULD DO Nothing" and hides the activate button when the planned version is already active', () => {
    render(
      <PlanView
        plan={identityPlan()}
        probe={blueyProbe()}
        result={blueyResult({ outcome: 'nothing_to_do', estimatedBytes: null, command: null })}
        workflow={{ ...workflow, active: { ...ACTIVE, version: 8 } }}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const would = screen.getByText('Would do').parentElement as HTMLElement;
    expect(would.textContent).toBe('Would doNothing');
    const size = screen.getByText('Size (est.)').parentElement as HTMLElement;
    expect(size.textContent).toBe('Size (est.)2.41 GB');
    expect(screen.queryByText('−33%')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dry run another file' })).toBeTruthy();
    const other = screen.getByRole('region', { name: 'Video and attachments' });
    expect(other.textContent).toContain('Container MKV');
    expect(screen.getByText('20 of 20 tracks kept')).toBeTruthy();
  });
  it('lists subtitle files in their own table: File, Language, Forced, SDH, Result', () => {
    const plan = {
      ...blueyPlan(),
      sidecars: [
        {
          file: 'Bluey.S01E03.de.srt',
          language: 'deu',
          forced: true,
          sdh: false,
          codec: 'subrip',
          action: 'embed' as const,
          note: '',
        },
        {
          file: 'Bluey.S01E03.en.hi.sup',
          language: 'eng',
          forced: false,
          sdh: true,
          codec: 'hdmv_pgs_subtitle',
          action: 'drop' as const,
          note: "container can't hold it",
        },
        {
          file: 'Bluey.S01E03.xx.srt',
          language: null,
          forced: false,
          sdh: false,
          codec: 'subrip',
          action: 'embed' as const,
          note: '',
        },
      ],
    };
    render(
      <PlanView
        plan={plan}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const region = screen.getByRole('region', { name: 'Subtitle files' });
    const table = within(region).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['File', 'Language', 'Forced', 'SDH', 'Result']);
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      );
    const th = (r: number) =>
      within(table).getAllByRole('row')[r + 1]?.querySelector('th')?.textContent;
    expect(th(0)).toBe('Bluey.S01E03.de.srt');
    expect(rows).toEqual([
      ['German', 'Yes', 'No', 'Embed'],
      ['English', 'No', 'Yes', 'Drop'],
      ['Untagged', 'No', 'No', 'Embed'],
    ]);
    expect(within(region).getByText("container can't hold it")).toBeTruthy();
  });

  it('shows no subtitle-files table without sidecars', () => {
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Subtitle files' })).toBeNull();
  });

  it('says "NOW 2.41 GB → ?" when a rewrite has no size estimate, not an estimate that contradicts itself', () => {
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult({ estimatedBytes: null })}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const size = screen.getByText('Size').parentElement as HTMLElement;
    expect(size.textContent).toBe('SizeNow 2.41 GB → ?(no estimate yet)');
    expect(screen.queryByText('Size (est.)')).toBeNull();
  });

  it('a test encode shows the measured size, not "→ ?" or an estimate', () => {
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult({ estimatedBytes: null, afterBytes: 1_660_000_000 })}
        measured
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const size = screen.getByText('Size').parentElement as HTMLElement;
    expect(size.textContent).toBe('Size2.41 → 1.66 GB');
    expect(screen.queryByText('Size (est.)')).toBeNull();
    expect(screen.getByText('−31%')).toBeTruthy();
  });

  it('a test encode still running says "Now 2.41 GB → …", not a size under the measured label', () => {
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={null}
        measured
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const size = screen.getByText('Size').parentElement as HTMLElement;
    expect(size.textContent).toBe('SizeNow 2.41 GB → …(measuring)');
  });

  it('a test encode that ended without a measured size says "Now 2.41 GB", not "no estimate yet"', () => {
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult({ estimatedBytes: null, afterBytes: null })}
        measured
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const size = screen.getByText('Size').parentElement as HTMLElement;
    expect(size.textContent).toBe('SizeNow 2.41 GB(not measured)');
    expect(screen.queryByText('(no estimate yet)')).toBeNull();
  });

  it('carries one dry-run marker in the hero: a plain line, not a second "Dry run" pill', () => {
    const { container } = render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    expect(container.querySelector('.badge-dry')).toBeNull();
    expect(screen.queryByText(/^dry run$/i)).toBeNull();
    expect(container.querySelector('.plan-eyebrow .icon')).toBeNull();
  });

  it('the Audio and Subtitles tables share one fixed column layout', () => {
    const { container } = render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const tables = [...container.querySelectorAll('table.plan-table')];
    expect(tables).toHaveLength(2);
    const widths = tables.map((t) =>
      [...t.querySelectorAll('colgroup col')].map((c) => (c as HTMLElement).className),
    );
    expect(widths[0]).toEqual([
      'plan-col-lang',
      'plan-col-track',
      'plan-col-default',
      'plan-col-result',
    ]);
    expect(widths[1]).toEqual(widths[0]);
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.plan-table\s*\{[^}]*table-layout:\s*fixed/);
    for (const col of widths[0] ?? []) {
      expect(css).toMatch(new RegExp(`\\.${col}\\s*\\{[^}]*width:`));
    }
  });

  it('labels every cell for the phone cards and repeats the language on each card', () => {
    render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const table = within(screen.getByRole('region', { name: 'Audio' })).getByRole('table');
    const row = rowOf(table, 'English');
    const cells = [...row.querySelectorAll('td')];
    expect(cells.map((c) => c.getAttribute('data-label'))).toEqual(['Tracks', 'Default', 'Result']);
    // A second track of a language gets its own language line (hidden from desktop and readers).
    const repeats = table.querySelectorAll('td.plan-lang-repeat');
    for (const r of repeats) expect(r.getAttribute('aria-hidden')).toBe('true');
  });

  it('below 640px the plan tables become stacked row cards with RESULT beside the track, not behind a scroll', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const start = css.indexOf('@media (max-width: 639px) {\n  .plan-table');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('\n}\n', start));
    expect(block).toMatch(/\.plan-table\s*\{[^}]*min-width:\s*0/);
    expect(block).toMatch(/\.plan-row\s*\{[^}]*display:\s*grid/);
    expect(block).toMatch(/attr\(data-label\)/);
    // The desktop rule keeps the width the cards drop.
    expect(css).toMatch(/\.plan-table\s*\{[^}]*min-width:\s*600px/);
  });

  it('the hero is the dry-run tone (amber, dashed), not the success lime', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const rule = css.match(/\.plan-tiles\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--st-dry-bg\)/);
    expect(rule).toMatch(/color:\s*var\(--st-dry\)/);
    expect(rule).toMatch(/dashed var\(--st-dry\)/);
    expect(rule).not.toMatch(/--accent|--on-accent/);
  });

  it('shows why the engine set a default flag the workflow did not ask for (the mp4 rule)', () => {
    const plan = blueyPlan();
    const sub = plan.streams.find((s) => s.type === 'subtitle' && s.action === 'keep');
    if (!sub) throw new Error('fixture has a kept subtitle');
    sub.default = { before: false, after: true };
    sub.note = 'default; mp4 cannot have no default subtitle';
    render(
      <PlanView
        plan={plan}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={workflow}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const table = screen.getByRole('region', { name: 'Subtitles' });
    expect(within(table).getByText('mp4 cannot have no default subtitle')).toBeTruthy();
    // Plain notes ("default", a language code) stay out of the table.
    expect(within(screen.getByRole('region', { name: 'Audio' })).queryByText('default')).toBeNull();
  });

  it('shows "Activate v8 of TV cleanup…" when nothing is active, and waits while the workflow has not loaded', () => {
    const { rerender } = render(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={{ ...workflow, active: null }}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    const activate = screen.getByRole('button', { name: 'Activate v8 of TV cleanup…' });
    // The next step sits in the hero with the verdict, before the track tables (polish review).
    expect(activate.closest('.plan-hero')).toBeTruthy();
    rerender(
      <PlanView
        plan={blueyPlan()}
        probe={blueyProbe()}
        result={blueyResult()}
        workflow={{ ...workflow, active: undefined }}
        onActivate={() => {}}
        onTryAnother={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
  });
});
