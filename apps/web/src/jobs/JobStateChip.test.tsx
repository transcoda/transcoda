import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fx, job } from '../test/fixtures/jobs.ts';
import { JobStateChip } from './JobStateChip.tsx';

afterEach(cleanup);

describe('JobStateChip', () => {
  it('always has an icon and a word, with the verdict as a class', () => {
    for (const [j, word, kind] of [
      [fx.running, 'Encoding', 'running'],
      [fx.queued, 'Queued', 'queued'],
      [fx.replaced, 'Replaced', 'replaced'],
      [fx.kept, 'Kept original', 'kept'],
      [fx.noop, 'Nothing to do', 'noop'],
      [fx.skipped, 'Skipped', 'skipped'],
      [fx.failed, 'Failed', 'failed'],
      [fx.dry, 'Would replace', 'dry'],
    ] as const) {
      const { container } = render(<JobStateChip job={j} />);
      const chip = container.querySelector('.job-chip') as HTMLElement;
      expect(chip.textContent).toBe(word);
      expect(chip.classList.contains(`is-${kind}`)).toBe(true);
      expect(chip.querySelector('svg')).not.toBeNull();
      cleanup();
    }
  });

  it('adds a secondary "Paused" chip for a paused job', () => {
    const { container } = render(<JobStateChip job={job({ ...fx.running, paused: true })} />);
    const chips = container.querySelectorAll('.job-chip');
    expect([...chips].map((c) => c.textContent)).toEqual(['Encoding', 'Paused']);
    expect(chips[1]?.classList.contains('is-paused')).toBe(true);
  });

  it('tags a dry run with a "Dry run" badge whatever its state; a real run has none', () => {
    for (const state of ['queued', 'encoding', 'failed', 'cancelled'] as const) {
      const { container } = render(<JobStateChip job={job({ state, dryRun: true })} />);
      const badge = container.querySelector('.badge-dry') as HTMLElement;
      expect(badge.textContent).toBe('Dry run');
      expect(badge.querySelector('svg')).not.toBeNull();
      cleanup();
    }
    const real = render(<JobStateChip job={job({ state: 'queued', dryRun: false })} />);
    expect(real.container.querySelector('.badge-dry')).toBeNull();
    cleanup();
    // A finished dry run shows its would-be verdict AND the badge beside it: the tag is not the outcome.
    const { container } = render(<JobStateChip job={job({ ...fx.dry, dryRun: true })} />);
    expect(container.querySelector('.job-chip')?.textContent).toBe('Would replace');
    expect(container.querySelector('.badge-dry')?.textContent).toBe('Dry run');
    cleanup();
    const kept = render(<JobStateChip job={job({ ...fx.kept, dryRun: true })} />);
    expect(kept.container.querySelector('.job-chip')?.textContent).toBe('Would keep original');
    expect(kept.container.querySelector('.badge-dry')).not.toBeNull();
  });
});

describe('JobStateChip estimate', () => {
  const withSize = (extra: Partial<Parameters<typeof job>[0]>) =>
    job({
      ...fx.dry,
      result: {
        outcome: 'dry_run',
        beforeBytes: 1000,
        afterBytes: null,
        replacedTo: null,
        sourceDamaged: false,
      },
      ...extra,
    });

  it('a dry run with an estimate says how much smaller it would be', () => {
    const { container } = render(<JobStateChip job={withSize({ estimatedBytes: 660 })} />);
    expect(container.querySelector('.job-chip')?.textContent).toBe('Would replace · −34%');
  });

  it('without an estimate it says only "Would replace"; a real run never gets a percent', () => {
    const none = render(<JobStateChip job={withSize({ estimatedBytes: null })} />);
    expect(none.container.querySelector('.job-chip')?.textContent).toBe('Would replace');
    cleanup();
    const real = render(<JobStateChip job={job({ ...fx.replaced, estimatedBytes: 660 })} />);
    expect(real.container.querySelector('.job-chip')?.textContent).toBe('Replaced');
  });
});
