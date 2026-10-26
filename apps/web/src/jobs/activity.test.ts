import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../test/fixtures/catalog.ts';
import { fx, job } from '../test/fixtures/jobs.ts';
import { ELSE_PATH, ELSE_TRACE, PATH, RUNNING_TRACE, traceMain } from '../test/fixtures/trace.ts';
import { activitySummary, progressLine, ringState, stepLine } from './activity.ts';

const encoding = (over: Parameters<typeof job>[0] = {}) =>
  job({ ...fx.running, progress, ...over });
const progress = {
  percent: 42.3,
  outTimeSeconds: 290,
  speed: 4.9,
  fps: 118.4,
  sizeBytes: 300_000_000,
  etaSeconds: 170,
};
const planned = job({ id: 'j-planned', state: 'building', lane: 'encode' });
const building = job({ id: 'j-building', state: 'building', lane: null });

describe('activitySummary', () => {
  it('counts running jobs like the Jobs nav badge and chip (the server count), not the rows it has', () => {
    const s = activitySummary({ running: [encoding()], runningCount: 4, queued: 0, paused: false });
    expect(s?.text).toBe('Running 4');
    expect(s?.count).toBe(4);
  });

  it.each([
    ['idle', { running: [], queued: 0, paused: false }],
    ['paused with nothing queued or running', { running: [], queued: 0, paused: true }],
  ])('is null when %s', (_, input) => {
    expect(activitySummary(input)).toBeNull();
  });

  it.each([
    ['only queued', { running: [], queued: 3, paused: false }, '3 queued', 3],
    [
      'one encoding, three queued',
      { running: [encoding()], queued: 3, paused: false },
      'Encoding 1 · 3 queued',
      4,
    ],
    [
      'one planned job waiting for its lane',
      { running: [planned], queued: 0, paused: false },
      'Running 1',
      1,
    ],
    [
      'encoding and verifying',
      { running: [encoding(), fx.verifying], queued: 0, paused: false },
      'Running 2',
      2,
    ],
    ['paused with work queued', { running: [], queued: 3, paused: true }, 'Paused · 3 queued', 3],
    [
      'paused with a frozen running job',
      { running: [encoding()], queued: 3, paused: true },
      'Paused · 1 running · 3 queued',
      4,
    ],
    [
      'paused with only a running job',
      { running: [encoding()], queued: 0, paused: true },
      'Paused · 1 running',
      1,
    ],
  ])('words %s', (_, input, text, count) => {
    const s = activitySummary(input);
    expect(s?.text).toBe(text);
    expect(s?.count).toBe(count);
  });

  it('gives the button a full accessible name with the percent of a single encode', () => {
    expect(activitySummary({ running: [encoding()], queued: 3, paused: false })?.label).toBe(
      'Activity: encoding 1 job at 42%, 3 queued. Show details',
    );
    expect(activitySummary({ running: [], queued: 1, paused: false })?.label).toBe(
      'Activity: 1 queued. Show details',
    );
    expect(
      activitySummary({ running: [encoding(), fx.verifying], queued: 0, paused: true })?.label,
    ).toBe('Activity: queue paused, 2 jobs running. Show details');
  });

  it('flags a dry run only when every running job is one', () => {
    const dry = encoding({ dryRun: true });
    expect(activitySummary({ running: [dry], queued: 0, paused: false })?.allDryRun).toBe(true);
    expect(activitySummary({ running: [encoding()], queued: 0, paused: false })?.allDryRun).toBe(
      false,
    );
    expect(
      activitySummary({ running: [dry, fx.verifying], queued: 0, paused: false })?.allDryRun,
    ).toBe(false);
    expect(activitySummary({ running: [], queued: 2, paused: false })?.allDryRun).toBe(false);
  });
});

describe('ringState', () => {
  it('is determinate for one encoding job with a percent', () => {
    const one = encoding({ progress: { ...progress, percent: 41.6 } });
    expect(ringState([one])).toEqual({ kind: 'determinate', percent: 42 });
  });

  it('is neutral for several jobs, a job without a percent, or a job not encoding', () => {
    expect(ringState([encoding(), fx.verifying])).toEqual({ kind: 'neutral' });
    expect(ringState([encoding({ progress: null })])).toEqual({ kind: 'neutral' });
    expect(ringState([planned])).toEqual({ kind: 'neutral' });
    expect(ringState([])).toEqual({ kind: 'neutral' });
  });
});

describe('stepLine', () => {
  const elseDetail = { graph: traceMain(), path: ELSE_PATH, trace: ELSE_TRACE };

  it('names the encode node while ffmpeg runs, whatever node the engine reports', () => {
    const at = { workflowPath: ['run-b'], nodeId: 'rt' };
    expect(stepLine(encoding(), elseDetail, at, catalogFixture)).toBe('Encode video');
    expect(stepLine(fx.verifying, elseDetail, null, catalogFixture)).toBe('Encode video');
  });

  it('says a planned job waits for its lane', () => {
    expect(stepLine(planned, elseDetail, undefined, catalogFixture)).toBe(
      'Planned · waiting for the encoder',
    );
  });

  it('names a top-level node by its type title', () => {
    const detail = { graph: traceMain(), path: PATH, trace: RUNNING_TRACE };
    const at = { workflowPath: [], nodeId: 'ca' };
    expect(stepLine(building, detail, at, catalogFixture)).toBe('Cover and attachments');
    // No event yet: the last traced node stands in.
    expect(stepLine(building, detail, undefined, catalogFixture)).toBe('Cover and attachments');
  });

  it('names the top-level Run node for a node inside a sub-workflow', () => {
    const graph = traceMain();
    for (const n of graph.nodes) if (n.id === 'run-a') n.label = 'Language cleanup';
    const at = { workflowPath: ['run-a'], nodeId: 'keep' };
    expect(
      stepLine(building, { graph, path: PATH, trace: RUNNING_TRACE }, at, catalogFixture),
    ).toBe('Language cleanup');
  });

  it('falls back to the phase words without details', () => {
    expect(stepLine(encoding(), null, undefined, catalogFixture)).toBe('Encoding');
    expect(stepLine(fx.verifying, null, undefined, null)).toBe(
      'Checking duration, streams and decode',
    );
    expect(stepLine(building, { graph: null, path: [], trace: [] }, null, null)).toBe(
      'Building the plan',
    );
  });
});

describe('progressLine', () => {
  it('gives the percent and a rough time left', () => {
    expect(progressLine(encoding())).toBe('42% · about 3 min left');
  });

  it('gives the percent alone without an estimate, and nothing without a percent', () => {
    const noEta = encoding({ progress: { ...progress, etaSeconds: null } });
    expect(progressLine(noEta)).toBe('42%');
    expect(progressLine(encoding({ progress: null }))).toBeNull();
    expect(progressLine(planned)).toBeNull();
  });
});
