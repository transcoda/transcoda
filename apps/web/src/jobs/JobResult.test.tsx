import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import type { JobDetail } from '@transcoda/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { fmtDate } from '../lib/time.ts';
import { JobResult } from './JobResult.tsx';
import { RESULT_TONE } from './jobOutcome.ts';
import { VERDICT_WORD } from './jobText.ts';

afterEach(cleanup);

const DONE: NonNullable<JobDetail['result']> = {
  outcome: 'done',
  beforeBytes: 472_000,
  afterBytes: 118_000,
  estimatedBytes: null,
  command: null,
  replacedTo: 'recycle',
  sourceDamaged: false,
  warnings: [],
  problems: [],
};

const head = (c: HTMLElement) => c.querySelector('.job-result-head')?.textContent;

describe('JobResult', () => {
  it('a replaced file leads with the sizes and the percent; where the original went is a muted line', () => {
    const { container } = render(
      <JobResult job={{ state: 'done', dryRun: false, reason: null, result: DONE }} />,
    );
    expect(head(container)).toBe('472 kB → 118 kB−75%');
    expect(container.querySelector('.job-result-pct')?.textContent).toBe('−75%');
    expect(container.querySelector('.job-result-meta')?.textContent).toBe(
      'Original in recycle folder',
    );
    // The chip in the header says "Replaced": the card does not repeat it, nor label its cells.
    expect(screen.queryByText('Replaced')).toBeNull();
    expect(container.querySelector('.job-result-label')).toBeNull();
    expect(container.querySelector('.job-result')?.classList.contains('is-ok')).toBe(true);
  });

  it('a kept original leads with its reason and is neutral, never blue or green', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'kept_original',
          dryRun: false,
          reason: 'saved only 2.9%, below 20%',
          result: { ...DONE, outcome: 'kept_original', afterBytes: 460_000, replacedTo: null },
        }}
      />,
    );
    expect(head(container)).toBe('Saved only 2.9%, below 20%');
    expect(container.querySelector('.job-result-meta')?.textContent).toBe('472 kB → 460 kB');
    const card = container.querySelector('.job-result');
    expect(card?.classList.contains('is-neutral')).toBe(true);
    expect(card?.classList.contains('v-kept')).toBe(true);
  });

  it('a failed probe says in plain words that the file could not be read; the raw error is not the headline', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'failed',
          dryRun: false,
          reason: 'probe failed: Invalid data found when processing input',
          result: null,
        }}
        raw={<details className="ffmpeg-raw" />}
      />,
    );
    expect(head(container)).toBe('The file could not be read');
    expect(container.querySelector('.job-result-text')?.textContent).toBe(
      'ffprobe found invalid data in the file, so the workflow never started.',
    );
    expect(container.querySelector('.job-result')?.classList.contains('is-error')).toBe(true);
    // The raw output slot comes last in the card.
    expect(container.querySelector('.job-result')?.lastElementChild?.className).toBe('ffmpeg-raw');
  });

  it('words a nothing-to-do job without a reason and an already-processed reason', () => {
    render(
      <JobResult job={{ state: 'nothing_to_do', dryRun: false, reason: null, result: null }} />,
    );
    expect(screen.getByText('Already complies with every rule')).toBeTruthy();
    cleanup();

    const at = '2026-10-17T04:18:10.386Z';
    render(
      <JobResult
        job={{
          state: 'already_processed',
          dryRun: false,
          reason: `already nothing_to_do on ${at}`,
          result: null,
        }}
      />,
    );
    expect(screen.getByText(`Processed on ${fmtDate(at)}: nothing to do`)).toBeTruthy();
  });

  it('lists the problems of a done job before its warnings, in amber', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'done',
          dryRun: false,
          reason: null,
          problems: ['ntfy:notify failed: 503'],
          result: { ...DONE, warnings: ['a warning'], problems: ['ntfy:notify failed: 503'] },
        }}
      />,
    );
    const problems = screen.getByRole('list', { name: 'Problems' });
    const warnings = screen.getByRole('list', { name: 'Warnings' });
    expect(problems.textContent).toContain('ntfy:notify failed: 503');
    expect(
      problems.compareDocumentPosition(warnings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector('.job-result')?.classList.contains('is-warning')).toBe(true);
  });

  it('the raw ffmpeg output is one disclosure: the command in it is flat and its summary is a full-size target', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const flat = css.match(/\.ffmpeg-raw \.command-block\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(flat).toMatch(/border:\s*0/);
    expect(flat).toMatch(/background:\s*transparent/);
    const summary = css.match(/\.ffmpeg-raw > summary\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(summary).toMatch(/min-height:\s*var\(--target-min\)/);
    expect(summary).toMatch(/cursor:\s*pointer/);
  });

  describe('the card is neutral; only the icon circle takes the chip colour', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');

    it('no outcome colours the panel itself (no slab, no edge bar)', () => {
      expect(css).not.toMatch(/\.job-result\.(v|is)-[a-z]+\s*\{/);
      const panel = css.match(/\n\.job-result\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(panel).not.toMatch(/background|border/);
    });

    it.each(Object.keys(VERDICT_WORD) as (keyof typeof RESULT_TONE)[])(
      '%s has a tone with a tinted icon rule (or the neutral default)',
      (v) => {
        const tone = RESULT_TONE[v];
        if (tone === 'neutral') return;
        expect(css).toMatch(new RegExp(`\\.job-result\\.is-${tone} \\.job-result-icon\\s*\\{`));
      },
    );

    it('maps the outcomes to the chip system', () => {
      expect(RESULT_TONE.replaced).toBe('ok');
      expect(RESULT_TONE.failed).toBe('error');
      expect(RESULT_TONE.attention).toBe('warning');
      for (const v of ['kept', 'noop', 'skipped', 'cancelled', 'already'] as const)
        expect(RESULT_TONE[v]).toBe('neutral');
    });
  });

  it('a dry run its size gate decides: the dry-run word with its threshold, "→ ?" and the action (#41)', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'dry_run',
          dryRun: true,
          reason: null,
          dependsOnSize: { minSavingPercent: 25 },
          result: {
            ...DONE,
            outcome: 'dry_run',
            beforeBytes: 315_000_000,
            afterBytes: null,
            estimatedBytes: 190_000_000,
            replacedTo: null,
          },
        }}
        testEncodeAction={<button type="button">Test-encode this file</button>}
      />,
    );
    expect(container.querySelector('.job-result')?.classList.contains('v-dry')).toBe(true);
    expect(head(container)).toBe('Would replace if it saves ≥ 25%');
    expect(screen.getByText('315 MB → ? · decided after encoding')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test-encode this file' })).toBeTruthy();
    // No estimate, no percent.
    expect(container.querySelector('.job-result-pct')).toBeNull();
  });

  it('a test-encode says its measured sizes once, never as an estimate', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'dry_run',
          dryRun: true,
          testEncode: true,
          reason: null,
          result: {
            ...DONE,
            outcome: 'dry_run',
            beforeBytes: 315_000_000,
            afterBytes: 190_000_000,
            estimatedBytes: 400_000_000,
            replacedTo: null,
          },
        }}
      />,
    );
    expect(head(container)).toBe('315 MB → 190 MB−40%');
    expect(container.querySelector('.job-result-meta')?.textContent).toBe('Would replace');
    expect(container.textContent?.match(/315 MB/g)).toHaveLength(1);
    expect(container.textContent?.match(/−40%/g)).toHaveLength(1);
    cleanup();

    const kept = render(
      <JobResult
        job={{
          state: 'kept_original',
          dryRun: true,
          testEncode: true,
          reason: 'saved only 3.0%, below 10%',
          result: {
            ...DONE,
            outcome: 'kept_original',
            beforeBytes: 315_000_000,
            afterBytes: 305_000_000,
            replacedTo: null,
          },
        }}
      />,
    );
    // The gate's saving is the headline, worded once (never the engine's raw reason).
    expect(head(kept.container)).toBe('Saved only 3% (gate ≥ 10%)');
    expect(screen.queryByText('saved only 3.0%, below 10%')).toBeNull();
    expect(kept.container.querySelector('.job-result-meta')?.textContent).toBe('315 MB → 305 MB');
  });

  it('a plan-only dry run marks its size as an estimate and says what would happen', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'dry_run',
          dryRun: true,
          testEncode: false,
          reason: null,
          result: {
            ...DONE,
            outcome: 'dry_run',
            beforeBytes: 315_000_000,
            afterBytes: null,
            estimatedBytes: 200_000_000,
            replacedTo: null,
          },
        }}
      />,
    );
    expect(head(container)).toBe('315 MB → 200 MB (est.)−37%');
    expect(container.querySelector('.job-result-meta')?.textContent).toBe('Would replace');
  });
});
