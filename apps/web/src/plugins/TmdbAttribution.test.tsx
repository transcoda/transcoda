import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TmdbAttribution } from './TmdbAttribution.tsx';

afterEach(cleanup);

describe('TmdbAttribution', () => {
  it('shows the logo and the required notice', () => {
    render(<TmdbAttribution />);
    const logo = screen.getByRole('img', { name: 'TMDB' });
    expect(logo.getAttribute('height')).toBe('20');
    expect(
      screen.getByText('This product uses the TMDB API but is not endorsed or certified by TMDB.'),
    ).toBeTruthy();
  });

  it('links to themoviedb.org in a new tab without a referrer', () => {
    render(<TmdbAttribution />);
    const link = screen.getByRole('link', { name: /TMDB/ });
    expect(link.getAttribute('href')).toBe('https://www.themoviedb.org');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
