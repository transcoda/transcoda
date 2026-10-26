import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAt } from '../test/render.tsx';
import { NotFound } from './NotFound.tsx';

afterEach(cleanup);

describe('NotFound', () => {
  it('says what is missing, never "no longer" for something that never was, and links back', () => {
    renderAt('/jobs/nope', <NotFound what="job" backHref="/jobs" backLabel="Back to jobs" />);
    expect(screen.getByRole('heading', { name: 'Job not found' })).toBeTruthy();
    expect(screen.getByText('This job does not exist, or it was deleted.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to jobs' }).getAttribute('href')).toBe('/jobs');
    expect(document.title).toMatch(/^Job not found · /);
  });

  it('defaults to a page and a way back to the start', () => {
    renderAt('/nope', <NotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to workflows' }).getAttribute('href')).toBe('/');
  });
});
