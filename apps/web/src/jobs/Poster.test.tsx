import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { job } from '../test/fixtures/jobs.ts';
import { Poster } from './Poster.tsx';

afterEach(cleanup);

const withPoster = (poster: boolean, id = 'j-1') => ({
  id,
  media: { ...job().media, poster },
});

describe('Poster', () => {
  it('renders the thumbnail lazily', () => {
    const { container } = render(<Poster job={withPoster(true)} size="row" />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/v1/jobs/j-1/poster');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });
  it('encodes the id', () => {
    const { container } = render(<Poster job={withPoster(true, 'a/b c')} size="row" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/jobs/a%2Fb%20c/poster',
    );
  });
  it('falls back to the placeholder when the image fails', () => {
    const { container } = render(<Poster job={withPoster(true)} size="row" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.poster-empty')).not.toBeNull();
  });
  it('shows the placeholder without a poster', () => {
    const { container } = render(<Poster job={withPoster(false)} size="row" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.poster-empty')).not.toBeNull();
  });
  it('sizes by class', () => {
    const page = render(<Poster job={withPoster(false)} size="page" />);
    expect(page.container.querySelector('.poster')?.classList.contains('poster-page')).toBe(true);
    const row = render(<Poster job={withPoster(false)} size="row" />);
    expect(row.container.querySelector('.poster')?.classList.contains('poster-row')).toBe(true);
  });
  it('has a full-width card size', () => {
    const { container } = render(<Poster job={withPoster(false)} size="card" />);
    expect(container.querySelector('.poster')?.classList.contains('poster-card')).toBe(true);
  });
  it("of show: asks for the show's own poster, then the job's own, then the placeholder", () => {
    const { container } = render(<Poster job={withPoster(true)} size="card" of="show" />);
    const src = () => container.querySelector('img')?.getAttribute('src');
    expect(src()).toBe('/api/v1/jobs/j-1/poster?of=show');
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(src()).toBe('/api/v1/jobs/j-1/poster');
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.poster-empty')).not.toBeNull();
  });
  it('tries the image again for another job', () => {
    const { container, rerender } = render(<Poster job={withPoster(true)} size="row" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    rerender(<Poster job={withPoster(true, 'j-2')} size="row" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/v1/jobs/j-2/poster');
  });
});
