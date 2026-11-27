import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fx } from '../testing/fixtures/jobs.ts';
import { ResultCell, TitleSub } from './JobCells.tsx';

afterEach(cleanup);

describe('ResultCell', () => {
  it('shows the sizes and the change for a replaced job', () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <ResultCell job={fx.replaced} queuePaused={false} />
          </tr>
        </tbody>
      </table>,
    );
    expect(container.querySelector('td.job-outcome')).toBeTruthy();
    expect(screen.getByText('2.41 GB → 1.62 GB')).toBeTruthy();
    expect(container.querySelector('.job-outcome-change.is-saved')?.textContent).toMatch(
      /^saved \d+(\.\d+)?% · /,
    );
  });
});

describe('TitleSub', () => {
  it('renders the episode code in bold, then the episode title', () => {
    const media = { ...fx.replaced.media, season: 1, episode: 2, episodeTitle: 'Ada Buys Stock' };
    const { container } = render(<TitleSub media={media} />);
    expect(container.querySelector('b.job-title-code')?.textContent).toBe('S01E02');
    expect(container.querySelector('.job-title-sub')?.textContent).toBe('S01E02 · Ada Buys Stock');
  });
  it('renders nothing without a code or text', () => {
    const media = { ...fx.replaced.media, kind: 'movie' as const, year: null };
    const { container } = render(<TitleSub media={media} />);
    expect(container.firstChild).toBeNull();
  });
});
