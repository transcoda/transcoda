import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fmtDate } from '../lib/time.ts';
import { JobResult } from './JobResult.tsx';
import { VERDICT_WORD } from './jobText.ts';

afterEach(cleanup);

describe('JobResult', () => {
  it('colours a kept original blue (the kept chip colour), never the replaced green', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'kept_original',
          dryRun: false,
          reason: 'saved only 2.9%, below 20%',
          result: null,
        }}
      />,
    );
    expect(container.querySelector('.job-result')?.classList.contains('v-kept')).toBe(true);
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const rule = css.match(/\.job-result\.v-kept\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--st-kept\)/);
    expect(rule).not.toMatch(/--accent/);
  });

  it('prints an engine reason as a sentence ("probe failed" → "Probe failed")', () => {
    render(
      <JobResult
        job={{
          state: 'failed',
          dryRun: false,
          reason: 'probe failed: Invalid data found when processing input',
          result: null,
        }}
      />,
    );
    expect(screen.getByText('Probe failed: Invalid data found when processing input')).toBeTruthy();
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

  it('labels the cells in sentence case (uppercase is the label class), and the notes start with a capital (L6, L16)', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'done',
          dryRun: false,
          reason: null,
          result: {
            outcome: 'done',
            beforeBytes: 100,
            afterBytes: 50,
            estimatedBytes: null,
            command: null,
            replacedTo: 'recycle',
            sourceDamaged: false,
            warnings: [],
            problems: [],
          },
        }}
      />,
    );
    const labels = [...container.querySelectorAll('.job-result-label')].map((l) => l.textContent);
    expect(labels).toEqual(['Result', 'Size']);
    expect(screen.getByText('Original in recycle folder')).toBeTruthy();
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css.match(/\n\.job-result-label\s*\{([^}]*)\}/)?.[1]).toMatch(
      /text-transform:\s*uppercase/,
    );
  });

  it('lists the problems of a done job, and its word is Needs attention', () => {
    render(
      <JobResult
        job={{
          state: 'done',
          dryRun: false,
          reason: null,
          problems: ['ntfy:notify failed: 503'],
          result: {
            outcome: 'done',
            beforeBytes: 100,
            afterBytes: 50,
            estimatedBytes: null,
            command: null,
            replacedTo: 'recycle',
            sourceDamaged: false,
            warnings: ['a warning'],
            problems: ['ntfy:notify failed: 503'],
          },
        }}
      />,
    );
    expect(screen.getByText('Needs attention')).toBeTruthy();
    const problems = screen.getByRole('list', { name: 'Problems' });
    const warnings = screen.getByRole('list', { name: 'Warnings' });
    expect(problems.textContent).toContain('ntfy:notify failed: 503');
    // Problems come before warnings.
    expect(
      problems.compareDocumentPosition(warnings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

  describe('every outcome has a deliberate colour', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const ruleOf = (v: string) => {
      const sel = '\\.job-result\\.v-[a-z]+';
      const re = new RegExp(
        `(?:${sel},\\s*)*\\.job-result\\.v-${v}(?:,\\s*${sel})*\\s*\\{([^}]*)\\}`,
      );
      return css.match(re)?.[1] ?? '';
    };

    it.each(Object.keys(VERDICT_WORD))(
      'v-%s has a background and ink from the --st-* tokens',
      (v) => {
        const rule = ruleOf(v);
        if (v === 'replaced') {
          expect(rule).toMatch(/background:\s*var\(--accent\)/); // the success green
          return;
        }
        expect(rule).toMatch(/background:\s*(var\(--st-[a-z-]+\)|transparent)/);
        expect(rule).toMatch(/color:\s*var\(--(st-[a-z-]+|muted)\)/);
        expect(rule).not.toMatch(/--accent/);
      },
    );

    it('maps the outcomes to the right chip tokens', () => {
      expect(ruleOf('failed')).toMatch(/background:\s*var\(--st-failed\)/);
      expect(ruleOf('attention')).toMatch(/background:\s*var\(--st-dry\)/);
      for (const v of ['noop', 'already', 'cancelled'])
        expect(ruleOf(v)).toMatch(/background:\s*var\(--st-noop\)/);
      // A dry run is dashed and never green; a needs-attention result is solid.
      expect(ruleOf('dry')).toMatch(/background:\s*var\(--st-dry-bg\)/);
      expect(ruleOf('dry')).toMatch(/border:\s*[\d.]+px dashed var\(--st-dry\)/);
      expect(ruleOf('attention')).not.toMatch(/dashed/);
    });

    it('keeps the problem list readable on the solid warning background', () => {
      expect(css).toMatch(
        /\.job-result\.v-attention \.job-result-problems\s*\{[^}]*color:\s*inherit/,
      );
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
            outcome: 'dry_run',
            beforeBytes: 315_000_000,
            afterBytes: null,
            estimatedBytes: 190_000_000,
            command: null,
            replacedTo: null,
            sourceDamaged: false,
            warnings: [],
            problems: [],
          },
        }}
        testEncodeAction={<button type="button">Test-encode this file</button>}
      />,
    );
    // The dry-run tone and its eye icon, never the replaced (success) check.
    expect(container.querySelector('.job-result')?.classList.contains('v-dry')).toBe(true);
    expect(screen.getByText('Would replace if it saves ≥ 25%')).toBeTruthy();
    expect(screen.getByText('315 MB → ? · decided after encoding')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test-encode this file' })).toBeTruthy();
    // No estimate, no percent.
    expect(container.querySelector('.job-result-pct')).toBeNull();
    expect(screen.queryByText('Size (est.)')).toBeNull();
  });

  it('a test-encode: the result says only the outcome, the measured sizes and percent are only in the size cell, labelled Size (not an estimate)', () => {
    const { container } = render(
      <JobResult
        job={{
          state: 'dry_run',
          dryRun: true,
          testEncode: true,
          reason: null,
          result: {
            outcome: 'dry_run',
            beforeBytes: 315_000_000,
            afterBytes: 190_000_000,
            estimatedBytes: 400_000_000,
            command: null,
            replacedTo: null,
            sourceDamaged: false,
            problems: [],
            warnings: [],
          },
        }}
      />,
    );
    expect(container.querySelector('.job-result-word')?.textContent).toBe('Would replace');
    expect(screen.getByText('Size')).toBeTruthy();
    expect(screen.queryByText('Size (est.)')).toBeNull();
    expect(container.querySelector('.job-result-size')?.textContent).toBe('315 MB → 190 MB');
    // The sizes and the percent are said once.
    expect(container.textContent?.match(/315 MB/g)).toHaveLength(1);
    expect(container.textContent?.match(/−40%/g)).toHaveLength(1);
    cleanup();

    render(
      <JobResult
        job={{
          state: 'kept_original',
          dryRun: true,
          testEncode: true,
          reason: 'saved only 3.0%, below 10%',
          result: {
            outcome: 'kept_original',
            beforeBytes: 315_000_000,
            afterBytes: 305_000_000,
            estimatedBytes: null,
            command: null,
            replacedTo: null,
            sourceDamaged: false,
            problems: [],
            warnings: [],
          },
        }}
      />,
    );
    const kept = document.querySelector('.job-result');
    expect(kept?.querySelector('.job-result-word')?.textContent).toBe('Would keep the original');
    // The gate's saving is a note, worded once (never the engine's raw reason).
    expect(screen.getByText('Saved only 3% (gate ≥ 10%)')).toBeTruthy();
    expect(screen.queryByText('saved only 3.0%, below 10%')).toBeNull();
    expect(screen.getByText('Size')).toBeTruthy();
    expect(kept?.querySelector('.job-result-size')?.textContent).toBe('315 MB → 305 MB');
    expect(kept?.textContent?.match(/315 MB/g)).toHaveLength(1);
  });

  it('a real run and a plan-only dry run keep their words; the size stays in the size cell', () => {
    const done = {
      outcome: 'done' as const,
      beforeBytes: 315_000_000,
      afterBytes: 190_000_000,
      estimatedBytes: null,
      command: null,
      replacedTo: 'recycle' as const,
      sourceDamaged: false,
      problems: [],
      warnings: [],
    };
    const { container } = render(
      <JobResult job={{ state: 'done', dryRun: false, reason: null, result: done }} />,
    );
    expect(container.querySelector('.job-result-word')?.textContent).toBe('Replaced');
    expect(container.querySelector('.job-result-size')?.textContent).toBe('315 MB → 190 MB');
    cleanup();

    const dry = render(
      <JobResult
        job={{
          state: 'dry_run',
          dryRun: true,
          testEncode: false,
          reason: null,
          result: {
            ...done,
            outcome: 'dry_run',
            afterBytes: null,
            estimatedBytes: 200_000_000,
            replacedTo: null,
            sourceDamaged: false,
          },
        }}
      />,
    );
    expect(dry.container.querySelector('.job-result-word')?.textContent).toBe('Would replace');
    expect(screen.getByText('Size (est.)')).toBeTruthy();
    expect(dry.container.querySelector('.job-result-size')?.textContent).toBe('315 MB → 200 MB');
  });
});
