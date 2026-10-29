import { JOB_STATES } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { fmtDate } from '../lib/time.ts';
import { fx, job } from '../test/fixtures/jobs.ts';
import {
  activityLine,
  dependsOnSizeText,
  detailLine,
  estimateTag,
  FILTERS,
  isWaitingForLane,
  phoneLine,
  phoneRunningLine,
  reasonOf,
  stateWord,
  testEncodeLine,
  testEncodeOutcome,
  VERDICT_WORD,
  verdictOf,
  whereLine,
  wouldText,
} from './jobText.ts';

describe('reason wording is one on every page (polish review)', () => {
  it('nothing to do reads the same whether the engine said "already as planned" or nothing', () => {
    expect(reasonOf({ state: 'nothing_to_do', reason: 'already as planned' })).toBe(
      'Already complies with every rule',
    );
    expect(reasonOf({ state: 'nothing_to_do', reason: null })).toBe(
      'Already complies with every rule',
    );
  });

  it('a file still being written says what happens next, not "still growing"', () => {
    expect(reasonOf({ state: 'skipped', reason: 'still growing' })).toBe(
      'Changed in the last few minutes: it is picked up once it stops changing',
    );
  });
});

describe('jobText', () => {
  it('detailLine reproduces the screen rows', () => {
    expect(detailLine(fx.replaced)).toBe(
      '2.41 GB → 1.62 GB, saved 790 MB · original in recycle folder',
    );
    expect(detailLine(fx.kept)).toBe('Only 6% smaller, size gate needs 20%');
    expect(detailLine(fx.failed)).toBe(
      'Verification failed: output 4 s shorter · original untouched',
    );
    expect(detailLine(fx.noop)).toBe('Already complies with every rule');
    expect(detailLine(fx.dry)).toBe('Would drop 9 tracks');
    expect(detailLine(fx.running)).toBe('42% · 118 fps · ETA 3 min');
    expect(detailLine(fx.verifying)).toBe('Checking duration, streams and decode');
    expect(detailLine(fx.skipped)).toBe('Hardlinked by the torrent client');
    expect(detailLine(fx.queued)).toBe('Waiting for a lane');
    // While the whole queue is paused nothing starts: the line says so instead.
    expect(detailLine(fx.queued, { queuePaused: true })).toBe('Queue paused');
    expect(detailLine({ ...fx.queued, paused: true }, { queuePaused: true })).toBe('Paused');
  });

  it("detailLine says when a job held by its library's run hours can start", () => {
    // Thursday 2026-10-22 14:32 in Berlin.
    const now = new Date('2026-10-22T12:32:00Z');
    const held = (opensAt: string | null) => ({
      ...fx.queued,
      heldByRunHours: { opensAt, timeZone: 'Europe/Berlin' },
    });
    expect(detailLine(held('2026-10-22T20:00:00Z'), { now })).toBe(
      'Waiting for run hours · starts at 22:00',
    );
    expect(detailLine(held('2026-10-24T07:00:00Z'), { now })).toBe(
      'Waiting for run hours · starts Sat 09:00',
    );
    expect(detailLine(held(null), { now })).toBe(
      'Waiting for run hours · none are chosen for this library',
    );
    const ready = {
      ...held('2026-10-22T20:00:00Z'),
      state: 'building' as const,
      lane: 'encode' as const,
    };
    expect(detailLine(ready, { now })).toBe('Planned · waiting for run hours · starts at 22:00');
    expect(detailLine(held('2026-10-22T20:00:00Z'), { now, queuePaused: true })).toBe(
      'Queue paused',
    );
  });

  it('a replaced job with replacedTo "deleted" never says recycle folder', () => {
    const deleted = job({
      ...fx.replaced,
      result: {
        ...(fx.replaced.result as NonNullable<typeof fx.replaced.result>),
        replacedTo: 'deleted',
      },
    });
    expect(detailLine(deleted)).toBe('2.41 GB → 1.62 GB, saved 790 MB');
    expect(detailLine(deleted)).not.toMatch(/recycle/);
  });

  it('covers the other phases, paused, missing numbers and engine-cased reasons', () => {
    expect(detailLine(job({ state: 'probing' }))).toBe('Reading the file');
    expect(detailLine(job({ state: 'deciding' }))).toBe('Deciding');
    expect(detailLine(job({ state: 'building' }))).toBe('Building the plan');
    expect(detailLine(job({ state: 'replacing' }))).toBe('Replacing the original');
    // C4: a replace waiting for free space says what it waits for.
    expect(
      detailLine(
        job({ state: 'replacing', reason: 'waiting for 5.4 GB free on /media (5.1 GB free)' }),
      ),
    ).toBe('Waiting for 5.4 GB free on /media (5.1 GB free)');
    expect(detailLine(job({ state: 'queued', paused: true }))).toBe('Paused');
    expect(detailLine(job({ state: 'encoding', progress: null }))).toBe('Encoding');
    const p = fx.running.progress as NonNullable<typeof fx.running.progress>;
    expect(
      detailLine(job({ state: 'encoding', progress: { ...p, fps: null, etaSeconds: null } })),
    ).toBe('42%');
    expect(detailLine(job({ state: 'encoding', progress: { ...p, etaSeconds: 40 } }))).toBe(
      '42% · 118 fps · ETA 40 s',
    );
    expect(detailLine(job({ state: 'encoding', progress: { ...p, etaSeconds: 4980 } }))).toBe(
      '42% · 118 fps · ETA 1 h 23 min',
    );
    expect(detailLine(job({ state: 'failed', reason: 'probe failed: no streams' }))).toBe(
      'Probe failed: no streams · original untouched',
    );
    expect(detailLine(job({ state: 'failed', reason: null }))).toBe('Original untouched');
    expect(detailLine(job({ state: 'kept_original', reason: null }))).toBe('');
    expect(detailLine(job({ state: 'dry_run', reason: null }))).toBe('Plan ready');
    expect(detailLine(job({ state: 'cancelled' }))).toBe('Cancelled · original untouched');
    expect(detailLine(job({ state: 'already_processed', reason: 'already processed by v7' }))).toBe(
      'Already processed by v7',
    );
    expect(detailLine(job({ state: 'done', result: null }))).toBe('Replaced');
  });

  it("reasonOf words the engine's already-processed reason and a missing nothing-to-do reason", () => {
    const at = '2026-10-17T04:18:10.386Z';
    const day = fmtDate(at);
    expect(reasonOf({ state: 'already_processed', reason: `already nothing_to_do on ${at}` })).toBe(
      `Processed on ${day}: nothing to do`,
    );
    expect(reasonOf({ state: 'already_processed', reason: `already done on ${at}` })).toBe(
      `Processed on ${day}: replaced`,
    );
    // C5: a restored original says so, with the force hint after the date.
    expect(
      reasonOf({
        state: 'already_processed',
        reason: `already done on ${at}; this file is the original from before then (moved back from the recycle folder?); run with force to process it again`,
      }),
    ).toBe(
      `Processed on ${day}: replaced; this file is the original from before then (moved back from the recycle folder?); run with force to process it again`,
    );
    // Anything else is the engine's own words.
    expect(reasonOf({ state: 'already_processed', reason: 'already processed by v7' })).toBe(
      'already processed by v7',
    );
    expect(reasonOf({ state: 'nothing_to_do', reason: null })).toBe(
      'Already complies with every rule',
    );
    // The engine's "already as planned" reads like every other nothing-to-do job.
    expect(reasonOf({ state: 'nothing_to_do', reason: 'already as planned' })).toBe(
      'Already complies with every rule',
    );
    expect(reasonOf({ state: 'failed', reason: null })).toBeNull();
    expect(
      detailLine(job({ state: 'already_processed', reason: `already kept_original on ${at}` })),
    ).toBe(`Processed on ${day}: kept original`);
    // The phone line keeps the first clause and never shows the raw state and ISO time.
    expect(
      phoneLine(job({ state: 'already_processed', reason: `already done on ${at}` })),
    ).not.toMatch(/done on|T04:/);
  });

  it('verdicts, words and the place line', () => {
    expect(JOB_STATES.map((state) => verdictOf({ state }))).toEqual([
      'queued',
      'running',
      'running',
      'running',
      'running',
      'running',
      'running',
      'replaced',
      'noop',
      'kept',
      'failed',
      'cancelled',
      'dry',
      'skipped',
      'already',
    ]);
    expect(stateWord(fx.running)).toBe('Encoding');
    expect(stateWord(fx.verifying)).toBe('Verifying');
    expect(stateWord(fx.kept)).toBe(VERDICT_WORD.kept);
    // A dry run is a tag, not an outcome: its chip says what would have happened.
    expect(stateWord(fx.dry)).toBe('Would replace');
    expect(stateWord(job({ ...fx.kept, dryRun: true }))).toBe('Would keep original');
    expect(stateWord(job({ ...fx.noop, dryRun: true }))).toBe('Nothing to do');
    expect(stateWord(job({ ...fx.kept, dryRun: false }))).toBe('Kept original');
    expect(whereLine(fx.running)).toBe('Shows · TV cleanup v7');
    expect(whereLine(fx.kept)).toBe('Movies · Movie shrink v3');
  });

  it('phoneLine is the verdict word and a short reason (screen 08)', () => {
    expect(phoneLine(fx.replaced)).toBe('Replaced · saved 790 MB');
    expect(phoneLine(fx.kept)).toBe('Kept original · only 6% smaller');
    expect(phoneLine(fx.failed)).toBe('Failed · original untouched');
    expect(phoneLine(fx.skipped)).toBe('Skipped · hardlinked by the torrent client');
    expect(phoneLine(fx.noop)).toBe('Nothing to do');
    expect(phoneLine(fx.dry)).toBe('Dry run · Would replace · would drop 9 tracks');
  });

  it('FILTERS: the chip set in order, Paused by flag', () => {
    expect(FILTERS.map((f) => f.label)).toEqual([
      'All',
      'Running',
      'Queued',
      'Replaced',
      'Kept original',
      'Nothing to do',
      'Skipped',
      'Failed',
      'Would replace',
      'Depends on size',
      'Cancelled',
      'Needs attention',
      'Paused',
    ]);
    expect(FILTERS.find((f) => f.label === 'Depends on size')).toEqual({
      label: 'Depends on size',
      states: ['dry_run'],
      dependsOnSize: true,
    });
    expect(FILTERS[0]?.states).toEqual([]);
    expect(FILTERS.find((f) => f.label === 'Replaced')?.states).toEqual(['done']);
    expect(FILTERS.at(-1)?.paused).toBe(true);
    expect(FILTERS.find((f) => f.label === 'Needs attention')).toEqual({
      label: 'Needs attention',
      states: [],
      problems: true,
    });
  });

  it('a done job with problems needs attention; the other states keep their verdicts', () => {
    const problems = ['sonarr:rescan failed: Sonarr did not list the new path'];
    const flagged = job({ state: 'done', problems });
    expect(verdictOf(flagged)).toBe('attention');
    expect(verdictOf(job({ state: 'done' }))).toBe('replaced');
    // Problems only exist after the write; any other state is read by its own verdict.
    expect(verdictOf(job({ state: 'failed', problems }))).toBe('failed');
    expect(VERDICT_WORD.attention).toBe('Needs attention');
    expect(stateWord(flagged)).toBe('Needs attention');
    expect(detailLine(flagged)).toBe(`done · needs attention: ${problems[0]}`);
    expect(phoneLine(flagged)).toBe(
      'Needs attention · sonarr:rescan failed: Sonarr did not list the new path',
    );
  });

  it('a kept_original job with sourceDamaged reads "Damaged source" with its reason; a dry run too', () => {
    const reason = 'source is damaged: audio #1 (DTS): Invalid LFE scale factor index';
    const damaged = job({
      ...fx.kept,
      reason,
      result: {
        outcome: 'kept_original',
        beforeBytes: 1000,
        afterBytes: 1000,
        replacedTo: null,
        sourceDamaged: true,
      },
    });
    expect(verdictOf(damaged)).toBe('damaged');
    expect(stateWord(damaged)).toBe('Damaged source');
    expect(detailLine(damaged)).toBe(
      'Source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
    );
    expect(phoneLine(damaged)).toBe(
      'Damaged source · source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
    );
    const dry = { ...damaged, dryRun: true };
    expect(verdictOf(dry)).toBe('damaged');
    expect(stateWord(dry)).toBe('Damaged source');
    // Without the flag a kept original stays one, and a failure is never damaged.
    expect(verdictOf(fx.kept)).toBe('kept');
    expect(verdictOf({ state: 'failed', result: { sourceDamaged: true } })).toBe('failed');
  });

  describe('a planned job waiting for a lane (state building, lane set)', () => {
    const waiting = job({ state: 'building', lane: 'encode' });

    it('is told apart from one still building', () => {
      expect(isWaitingForLane(waiting)).toBe(true);
      expect(isWaitingForLane(job({ state: 'building', lane: null }))).toBe(false);
      expect(isWaitingForLane(job({ state: 'encoding', lane: 'encode' }))).toBe(false);
      expect(isWaitingForLane(job({ state: 'queued', lane: null }))).toBe(false);
    });

    it('says it is planned and waiting, in the detail line, the chip and on a phone', () => {
      expect(detailLine(waiting)).toBe('Planned · waiting for the encoder');
      expect(detailLine(job({ state: 'building', lane: 'quick' }))).toBe(
        'Planned · waiting for the quick lane',
      );
      expect(phoneRunningLine(waiting)).toBe('Planned · waiting for the encoder');
      expect(stateWord(waiting)).toBe('Planned');
      expect(detailLine(job({ state: 'building', lane: null }))).toBe('Building the plan');
      expect(stateWord(job({ state: 'building', lane: null }))).toBe('Building');
      // Still a running job for the filters and the verdict.
      expect(verdictOf(waiting)).toBe('running');
    });
  });

  it('phoneLine says "Dry run" first for a dry run that did not end as one, and not for real jobs', () => {
    expect(phoneLine(job({ ...fx.failed, dryRun: true }))).toMatch(/^Dry run · Failed/);
    expect(phoneLine(job({ ...fx.failed, dryRun: false }))).toMatch(/^Failed/);
    expect(phoneLine(fx.dry)).toMatch(/^Dry run · Would replace/);
  });

  describe('wouldText: write steps of a dry run read as what would happen', () => {
    it('turns the write reasons into "would …"', () => {
      expect(wouldText('replace the original (recycle folder: library default)')).toBe(
        'would replace the original (recycle folder: library default)',
      );
      expect(wouldText('copy the result to /out')).toBe('would copy the result to /out');
      expect(wouldText('move the result to /out')).toBe('would move the result to /out');
    });

    it('leaves other reasons and already-conditional ones alone', () => {
      expect(wouldText('kept en, de, ja')).toBe('kept en, de, ja');
      expect(wouldText('would replace the original')).toBe('would replace the original');
      expect(wouldText('size gate: at least 10% smaller')).toBe('size gate: at least 10% smaller');
    });
  });
});

const dryWith = (extra: Parameters<typeof job>[0]) =>
  job({
    ...fx.dry,
    reason: null,
    result: {
      outcome: 'dry_run',
      beforeBytes: 1000,
      afterBytes: null,
      replacedTo: null,
      sourceDamaged: false,
    },
    ...extra,
  });

describe('dry-run estimate', () => {
  it('estimateTag is the size change a dry run would make, signed like the real-run percent', () => {
    expect(estimateTag(dryWith({ estimatedBytes: 660 }))).toBe('−34%');
    expect(estimateTag(dryWith({ estimatedBytes: 1040 }))).toBe('+4%');
    expect(estimateTag(dryWith({ estimatedBytes: 1000 }))).toBe('0%');
  });

  it('estimateTag is null without an estimate, without a before size, outside a dry run, and for a dry run that would not rewrite', () => {
    expect(estimateTag(dryWith({ estimatedBytes: null }))).toBeNull();
    expect(estimateTag(dryWith({ estimatedBytes: 600, result: null }))).toBeNull();
    expect(
      estimateTag(
        dryWith({
          estimatedBytes: 600,
          result: {
            outcome: 'dry_run',
            beforeBytes: 0,
            afterBytes: null,
            replacedTo: null,
            sourceDamaged: false,
          },
        }),
      ),
    ).toBeNull();
    expect(estimateTag(job({ ...fx.replaced, estimatedBytes: 600 }))).toBeNull();
    expect(estimateTag(dryWith({ ...fx.kept, dryRun: true, estimatedBytes: 600 }))).toBeNull();
  });

  it('detailLine words the plan summary instead of a bare "Plan ready"; an engine reason still shows without one', () => {
    expect(
      detailLine(dryWith({ planSummary: 'convert 1 video track; drop 1 subtitle track' })),
    ).toBe('Convert 1 video track; drop 1 subtitle track');
    expect(detailLine(dryWith({ planSummary: null }))).toBe('Plan ready');
    expect(detailLine(fx.dry)).toBe('Would drop 9 tracks');
  });
});

describe('a dry run its size gate decides (#41)', () => {
  const depends = (extra: Parameters<typeof job>[0] = {}) =>
    job({
      ...fx.dry,
      estimatedBytes: 600,
      result: {
        outcome: 'dry_run',
        beforeBytes: 1000,
        afterBytes: null,
        replacedTo: null,
        sourceDamaged: false,
      },
      dependsOnSize: { minSavingPercent: 25 },
      ...extra,
    });

  it('the chip says it would replace only if it saves enough, with no estimate', () => {
    expect(stateWord(depends())).toBe('Would replace if it saves ≥ 25%');
    expect(estimateTag(depends())).toBeNull();
    expect(stateWord(depends({ dependsOnSize: null }))).toBe('Would replace');
    expect(estimateTag(depends({ dependsOnSize: null }))).toBe('−40%');
  });

  it('the Replace original step is conditional; other steps read as before', () => {
    expect(dependsOnSizeText('replace the original (recycle folder: library default)')).toBe(
      'would replace the original if the size gate passes; otherwise keeps it',
    );
    expect(dependsOnSizeText('move the result to /out')).toBe(
      'would move the result to /out if the size gate passes; otherwise keeps it',
    );
    expect(dependsOnSizeText('copy the result to /out')).toBe(
      'would copy the result to /out if the size gate passes; otherwise keeps it',
    );
    expect(dependsOnSizeText('notify https://hooks.example/…')).toBe(
      'notify https://hooks.example/…',
    );
    expect(
      dependsOnSizeText('Size gate: decides after encoding: keep if it saves less than 25%'),
    ).toBe('Size gate: decides after encoding: keep if it saves less than 25%');
  });
});

describe('test-encode outcome', () => {
  const measured = (extra: Parameters<typeof job>[0] = {}) =>
    job({
      ...fx.dry,
      testEncode: true,
      reason: null,
      estimatedBytes: null,
      result: {
        outcome: 'dry_run',
        beforeBytes: 315_000_000,
        afterBytes: 190_000_000,
        replacedTo: null,
        sourceDamaged: false,
      },
      ...extra,
    });
  const keptWith = (reason: string) =>
    measured({
      state: 'kept_original',
      reason,
      result: {
        outcome: 'kept_original',
        beforeBytes: 315_000_000,
        afterBytes: 305_000_000,
        replacedTo: null,
        sourceDamaged: false,
      },
    });

  it('testEncodeOutcome parts the outcome word from what it rests on', () => {
    expect(testEncodeOutcome(measured())).toEqual({
      word: 'Would replace',
      detail: '315 MB → 190 MB (−40%)',
    });
    expect(testEncodeOutcome(keptWith('saved only 3.0%, below 10%'))).toEqual({
      word: 'Would keep the original',
      detail: 'saved only 3% (gate ≥ 10%)',
    });
    expect(testEncodeOutcome(measured({ testEncode: false }))).toBeNull();
  });

  it('a test-encode that would replace says the measured sizes and percent', () => {
    expect(testEncodeLine(measured())).toBe('Would replace · 315 MB → 190 MB (−40%)');
  });

  it('a test-encode the gate kept says the saving and the gate, without a trailing .0', () => {
    expect(testEncodeLine(keptWith('saved only 3.0%, below 10%'))).toBe(
      'Would keep the original · saved only 3% (gate ≥ 10%)',
    );
    expect(testEncodeLine(keptWith('saved only 9.6%, below 12.5%'))).toBe(
      'Would keep the original · saved only 9.6% (gate ≥ 12.5%)',
    );
    expect(testEncodeLine(keptWith('saved only -2.0%, below 10.0%'))).toBe(
      'Would keep the original · saved only -2% (gate ≥ 10%)',
    );
  });

  it('is null for a plan-only dry run, a failed test-encode, a kept one without a gate reason and missing sizes', () => {
    expect(testEncodeLine(measured({ testEncode: false }))).toBeNull();
    expect(testEncodeLine(measured({ state: 'failed', reason: 'encode failed' }))).toBeNull();
    expect(testEncodeLine(keptWith('path never writes the result'))).toBeNull();
    expect(
      testEncodeLine(
        measured({
          result: {
            outcome: 'dry_run',
            beforeBytes: 315_000_000,
            afterBytes: null,
            replacedTo: null,
            sourceDamaged: false,
          },
        }),
      ),
    ).toBeNull();
    expect(testEncodeLine(measured({ result: null }))).toBeNull();
  });

  it('detailLine of a measured test-encode is its outcome, never "Plan ready"', () => {
    const withPlan = measured({ planSummary: 'convert 1 video track' });
    expect(detailLine(withPlan)).toBe('Would replace · 315 MB → 190 MB (−40%)');
    expect(
      detailLine(
        measured({
          planSummary: 'convert 1 video track',
          result: {
            outcome: 'dry_run',
            beforeBytes: null,
            afterBytes: null,
            replacedTo: null,
            sourceDamaged: false,
          },
        }),
      ),
    ).toBe('Would replace');
  });

  it('estimateTag of a test-encode is the measured change, not the estimate', () => {
    expect(estimateTag(measured())).toBe('−40%');
    expect(estimateTag(measured({ estimatedBytes: 300_000_000 }))).toBe('−40%');
  });
});

describe('verify progress', () => {
  const idle = { outTimeSeconds: 0, speed: null, fps: null, sizeBytes: null, etaSeconds: null };
  const checks = {
    ...fx.verifying,
    progress: { ...idle, percent: 21.4, verify: { stage: 'checks' as const, done: 3, total: 14 } },
  };
  const whole = {
    ...fx.verifying,
    progress: {
      percent: 43.2,
      outTimeSeconds: 3100,
      speed: 17,
      fps: 412,
      sizeBytes: null,
      etaSeconds: 240,
      verify: { stage: 'full-decode' as const, done: null, total: null },
    },
  };
  const source = {
    ...fx.verifying,
    progress: {
      ...idle,
      percent: null,
      verify: { stage: 'source' as const, done: null, total: null },
    },
  };

  it('the checks are counted, never given as a percent', () => {
    expect(activityLine(checks)).toBe('Verifying · 3 of 14 checks');
    expect(detailLine(checks)).toBe('Checking duration, streams and decode · 3 of 14 done');
  });

  it('the whole-file decode reads as its own percent, with speed and ETA', () => {
    expect(activityLine(whole)).toBe('Verifying · whole file 43%');
    expect(detailLine(whole)).toBe('Decoding the whole file · 43% · 412 fps · ETA 4 min');
  });

  it('re-checking the source has words only', () => {
    expect(activityLine(source)).toBe('Verifying · checking the source');
    expect(detailLine(source)).toBe('Decoding the same spots of the source');
  });

  it('before the first check, and for other phases, the line is as before', () => {
    expect(activityLine(fx.verifying)).toBe('Verifying');
    expect(detailLine(fx.verifying)).toBe('Checking duration, streams and decode');
    expect(activityLine(fx.running)).toBe('Encoding · 42%');
    expect(activityLine({ ...fx.running, progress: null })).toBe('Encoding');
    expect(activityLine({ ...fx.running, paused: true })).toBe('Paused');
    expect(activityLine(fx.replaced)).toBeUndefined();
  });
});
