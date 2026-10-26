import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Loading } from './Loading.tsx';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');

describe('Loading', () => {
  it('is a status with a decorative spinner and the label as text', () => {
    render(<Loading label="Loading run…" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading run…');
    expect(status.classList.contains('loading')).toBe(true);
    expect(status.querySelector('.loading-spinner')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('defaults the label to "Loading…"', () => {
    render(<Loading />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
  });

  it('has an inline variant for dialogs and panels: the same status, not centred, a small spinner', () => {
    render(<Loading inline label="Loading the log…" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading the log…');
    expect([...status.classList]).toEqual(['loading', 'loading-inline']);
    expect(status.querySelector('.loading-spinner')?.getAttribute('aria-hidden')).toBe('true');
    const inline = css.match(/\n\.loading-inline\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(inline).toMatch(/flex-direction:\s*row/);
    expect(inline).toMatch(/justify-content:\s*flex-start/);
    expect(inline).toMatch(/min-height:\s*0/);
    const spinner = css.match(/\n\.loading-inline \.loading-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(spinner).toMatch(/width:\s*14px/);
  });

  it('the page variant has only the base class', () => {
    render(<Loading />);
    expect([...screen.getByRole('status').classList]).toEqual(['loading']);
  });

  it('is centred, and only spins when the user has not asked for reduced motion', () => {
    const base = css.match(/\n\.loading\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(base).toMatch(/justify-content:\s*center/);
    expect(base).toMatch(/align-items:\s*center/);
    const spinBase = css.match(/\n\.loading-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(spinBase).not.toMatch(/animation/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.loading-spinner\s*\{[^}]*animation:/,
    );
  });
});

describe('uppercase labels use text-transform, not typed capitals', () => {
  it('styles the tile label and the phone section headings as uppercase', () => {
    expect(css.match(/\n\.stat-label\s*\{([^}]*)\}/)?.[1]).toMatch(/text-transform:\s*uppercase/);
    expect(css.match(/\n\.phone-section h2\s*\{([^}]*)\}/)?.[1]).toMatch(
      /text-transform:\s*uppercase/,
    );
    expect(css.match(/\n\.run-files th\s*\{([^}]*)\}/)?.[1]).toMatch(/text-transform:\s*uppercase/);
  });
});
