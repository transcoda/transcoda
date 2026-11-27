import { cleanup, screen, within } from '@testing-library/react';
import type { LibraryTitle } from '@transcoda/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { fx } from '../testing/fixtures/jobs.ts';
import { renderAt } from '../testing/render.tsx';
import { outcomeLine, SeasonGrid, TitleGrid } from './TitleGrid.tsx';

afterEach(cleanup);

const none = { replaced: 0, kept: 0, failed: 0, other: 0 };
const SHOW: LibraryTitle = {
  type: 'show',
  key: 'a/b c',
  title: 'The Bramblewood Family',
  year: 1962,
  poster: null,
  episodes: 3,
  seasons: 1,
  outcomes: { replaced: 1, kept: 1, failed: 1, other: 0 },
  savedBytes: 400,
};
const MOVIE: LibraryTitle = {
  type: 'movie',
  fileId: 'f9',
  poster: null,
  latest: {
    ...fx.kept,
    media: { ...fx.kept.media, title: 'Nocturne of the Quiet Moon', year: 1968, kind: 'movie' },
  },
};

describe('outcomeLine', () => {
  it('joins the non-zero parts and leaves zero parts out', () => {
    expect(outcomeLine({ replaced: 12, kept: 2, failed: 1, other: 0 }, 4_200_000_000)).toBe(
      '12 replaced · 2 kept original · 1 failed · saved 4.20 GB',
    );
    expect(outcomeLine({ replaced: 0, kept: 2, failed: 0, other: 0 }, 0)).toBe('2 kept original');
  });
  it('is empty when only other outcomes exist and nothing was saved', () => {
    expect(outcomeLine({ replaced: 0, kept: 0, failed: 0, other: 2 }, 0)).toBe('');
  });
});

describe('TitleGrid', () => {
  it('a show card is one link with its title, year, episodes and outcomes', () => {
    renderAt('/', <TitleGrid libraryId="l1" items={[SHOW]} />);
    const list = screen.getByRole('list', { name: 'Titles' });
    const link = within(list).getByRole('link', { name: /The Bramblewood Family/ });
    expect(link.getAttribute('href')).toBe('/libraries/l1/shows/a%2Fb%20c');
    expect(within(link).getByText('1962 · 3 episodes')).toBeTruthy();
    expect(
      within(link).getByText('1 replaced · 1 kept original · 1 failed · saved 400 B'),
    ).toBeTruthy();
    expect(within(list).getAllByRole('link')).toHaveLength(1);
  });

  it('a movie card links to its file and shows year and the latest verdict', () => {
    renderAt('/', <TitleGrid libraryId="l1" items={[MOVIE]} />);
    const link = screen.getByRole('link', { name: /Nocturne of the Quiet Moon/ });
    expect(link.getAttribute('href')).toBe('/libraries/l1/files/f9');
    expect(within(link).getByText('1968')).toBeTruthy();
    expect(within(link).getByText('Kept original')).toBeTruthy();
  });

  it('a null poster shows the placeholder, not an image', () => {
    const { container } = renderAt('/', <TitleGrid libraryId="l1" items={[SHOW, MOVIE]} />);
    expect(container.querySelectorAll('.poster-card.poster-empty')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
  });

  it("a show card with the show's own poster asks for it (?of=show); an episode poster does not", () => {
    const media = { ...fx.kept.media, poster: true };
    const { container } = renderAt(
      '/',
      <TitleGrid
        libraryId="l1"
        items={[
          { ...SHOW, poster: { id: 'j-show', media, of: 'show' } },
          { ...SHOW, key: 'other', title: 'Other', poster: { id: 'j-ep', media } },
        ]}
      />,
    );
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      '/api/v1/jobs/j-show/poster?of=show',
      '/api/v1/jobs/j-ep/poster',
    ]);
  });
});

describe('SeasonGrid', () => {
  it('names season 0 Specials and a missing season No season, and links each', () => {
    renderAt(
      '/',
      <SeasonGrid
        libraryId="l1"
        showKey="k"
        seasons={[
          { season: 0, episodes: 1, poster: null, outcomes: none, savedBytes: 0 },
          {
            season: 2,
            episodes: 24,
            poster: null,
            outcomes: { ...none, replaced: 3 },
            savedBytes: 0,
          },
          { season: 'none', episodes: 1, poster: null, outcomes: none, savedBytes: 0 },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: /Specials/ }).getAttribute('href')).toBe(
      '/libraries/l1/shows/k/seasons/0',
    );
    const two = screen.getByRole('link', { name: /Season 2/ });
    expect(two.getAttribute('href')).toBe('/libraries/l1/shows/k/seasons/2');
    expect(within(two).getByText('24 episodes')).toBeTruthy();
    expect(within(two).getByText('3 replaced')).toBeTruthy();
    expect(screen.getByRole('link', { name: /No season/ }).getAttribute('href')).toBe(
      '/libraries/l1/shows/k/seasons/none',
    );
  });
});
