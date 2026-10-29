import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { source, testEncode } from '../test/fixtures/beforeAfter.ts';
import { BeforeAfter } from './BeforeAfter.tsx';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');

describe('BeforeAfter', () => {
  it('is a table with Before and After column headers and a row header per row', () => {
    render(<BeforeAfter job={testEncode()} />);
    const table = screen.getByRole('table', { name: 'Before and after' });
    const cols = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(cols).toEqual(['Before', 'After']);
    const rows = within(table)
      .getAllByRole('rowheader')
      .map((h) => h.textContent);
    expect(rows).toEqual(['File', 'Video', 'Audio 1', 'Audio 2', 'Subtitles']);
  });

  it('shows each value whole, never as a "·" chain that wraps mid-list', () => {
    const { container } = render(<BeforeAfter job={testEncode()} />);
    const video = screen.getByRole('row', { name: /^Video/ });
    const items = [...(video.querySelectorAll('td')[0]?.querySelectorAll('.ba-item') ?? [])].map(
      (i) => i.textContent,
    );
    expect(items).toEqual(['HEVC Main,', '1920×1080,', '23.976 fps,', '8-bit SDR,', '≈9.6 Mb/s']);
    expect(container.textContent).not.toContain('·');
    expect(css).toMatch(/\.ba-item\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('marks a loss in amber with an icon and a word, and explains it to screen readers', () => {
    render(<BeforeAfter job={testEncode()} />);
    const audio = screen.getByRole('row', { name: /^Audio 1/ });
    const after = audio.querySelectorAll('td')[1] as HTMLElement;
    const losses = [...after.querySelectorAll('.ba-loss')];
    expect(losses.map((l) => l.textContent)).toEqual([
      'downmixed: fewer channels than the original (5.1 → 2.0)',
      'lossy: the original is lossless, this is not',
    ]);
    for (const l of losses) {
      expect(l.querySelector('svg[data-icon="alert"]')).not.toBeNull();
      expect(l.querySelector('.sr-only')?.textContent).toMatch(/^: /);
    }
    expect(css).toMatch(/\.ba-loss\s*\{[^}]*color:\s*var\(--st-dry\)/);
    // Kept subtitles are not a loss.
    const subs = screen.getByRole('row', { name: /^Subtitles/ });
    expect(subs.querySelector('.ba-loss')).toBeNull();
    expect(subs.querySelectorAll('td')[1]?.textContent).toBe('kept');
  });

  it('the amber legend is there only when a row loses something', () => {
    const { container } = render(
      <BeforeAfter job={testEncode({ state: 'done', dryRun: false })} />,
    );
    expect(container.querySelector('.before-after-legend')?.textContent).toBe(
      'Amber marks what the output loses.',
    );
    cleanup();
    const same = render(
      <BeforeAfter
        job={testEncode({ state: 'done', dryRun: false, testEncode: false, outputProbe: source() })}
      />,
    );
    expect(same.container.querySelector('.ba-loss')).toBeNull();
    expect(same.container.querySelector('.before-after-legend')).toBeNull();
  });

  it('a plan-only dry run says its After is the plan', () => {
    render(
      <BeforeAfter
        job={testEncode({
          testEncode: false,
          outputProbe: null,
          result: { beforeBytes: 11_580_000_000, afterBytes: null, estimatedBytes: 2_120_000_000 },
        })}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'After (planned)' })).toBeTruthy();
    expect(screen.getByText('2.12 GB (est.),')).toBeTruthy();
  });

  it('says where After comes from when it is not the verified output', () => {
    const header = () => screen.getAllByRole('columnheader')[1]?.textContent;
    render(
      <BeforeAfter
        job={testEncode({ dryRun: false, testEncode: false, state: 'kept_original' })}
      />,
    );
    expect(header()).toBe('After (not kept)');
    cleanup();
    render(
      <BeforeAfter
        job={testEncode({ dryRun: false, testEncode: false, state: 'done', outputProbe: null })}
      />,
    );
    expect(header()).toBe('After (from the plan)');
    expect(
      screen.getByText(
        /This job's output details weren't kept; After is the plan with the measured size\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/nothing was encoded/)).toBeNull();
  });

  it('renders nothing when there is nothing to compare', () => {
    const { container } = render(<BeforeAfter job={testEncode({ probe: null })} />);
    expect(container.innerHTML).toBe('');
  });

  it('stacks Before and After per row on a phone, each with its label', () => {
    const phone = css.match(/@media \(max-width: 639px\)\s*\{\s*\.ba-table,[^@]*/)?.[0] ?? '';
    expect(phone).toMatch(/\.ba-table td::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    render(<BeforeAfter job={testEncode()} />);
    const cells = screen.getByRole('row', { name: /^File/ }).querySelectorAll('td');
    expect([...cells].map((c) => c.getAttribute('data-label'))).toEqual(['Before', 'After']);
  });
});
