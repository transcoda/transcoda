import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupLabel, SectionHeading } from './Headings.tsx';

afterEach(cleanup);

describe('Headings', () => {
  it('SectionHeading is an H2 with a muted count and a note on its own line', () => {
    render(
      <SectionHeading count={1866} note="Only files this run touched.">
        Files
      </SectionHeading>,
    );
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2.className).toBe('section-h2');
    expect(h2.textContent).toBe('Files1,866');
    expect(h2.querySelector('.section-count')?.textContent).toBe('1,866');
    expect(screen.getByText('Only files this run touched.').className).toBe('section-note');
  });

  it('SectionHeading without a count shows no count', () => {
    render(<SectionHeading>Finished</SectionHeading>);
    expect(document.querySelector('.section-count')).toBeNull();
  });

  it('GroupLabel is a muted H3', () => {
    render(<GroupLabel>Change password</GroupLabel>);
    expect(screen.getByRole('heading', { level: 3, name: 'Change password' }).className).toBe(
      'group-h3',
    );
  });
});
