import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAt } from '../testing/render.tsx';
import { NotFound } from './NotFound.tsx';

afterEach(cleanup);

describe('NotFound', () => {
  it('says what is missing, never "no longer" for something that never was, and links back', () => {
    renderAt('/jobs/nope', <NotFound what="job" backHref="/jobs" backLabel="Back to jobs" />);
    expect(screen.getByRole('heading', { name: 'Job not found' })).toBeTruthy();
    expect(screen.getByText('This job does not exist, or it was deleted.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to jobs' }).getAttribute('href')).toBe('/jobs');
    // The second way out never repeats the first.
    expect(screen.getByRole('link', { name: 'Go to workflows' }).getAttribute('href')).toBe('/');
    expect(document.title).toMatch(/^Job not found · /);
  });

  it('defaults to a page and a way back to the start', () => {
    renderAt('/nope', <NotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to workflows' });
    expect(back.getAttribute('href')).toBe('/');
    expect(back.className).toContain('btn-primary');
    const jobs = screen.getByRole('link', { name: 'Go to jobs' });
    expect(jobs.getAttribute('href')).toBe('/jobs');
    expect(jobs.className).toContain('btn-secondary');
  });

  it('draws the address as a node with a cable to nothing, hidden from screen readers', () => {
    renderAt('/nope', <NotFound />);
    const chain = document.querySelector('.lost-chain');
    expect(chain?.getAttribute('aria-hidden')).toBe('true');
    expect(chain?.querySelector('.lost-node-path')?.textContent).toBe('/nope');
  });
});
