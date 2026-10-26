import type { JobDetail } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import {
  failingNodeOf,
  jobBrief,
  jobLine,
  jobReport,
  jobReportText,
  type Titles,
} from './job-report.ts';

const NAMES: Record<string, string> = { in: 'Manual input', vi: 'Video is', ev: 'Encode video' };
const titles: Titles = (id, wp) => (wp.length === 0 ? (NAMES[id] ?? id) : id);

type Entry = JobDetail['trace'][number];
const entry = (over: Partial<Entry>): Entry => ({
  seq: 1,
  attempt: 1,
  nodeId: 'in',
  workflowPath: [],
  phase: 'decide',
  port: null,
  reason: '',
  findings: {},
  startedAt: '2026-10-17T10:00:00.000Z',
  endedAt: '2026-10-17T10:00:01.000Z',
  ...over,
});

const detail: JobDetail = {
  id: 'j1',
  runId: 'r1',
  state: 'failed',
  paused: false,
  lane: null,
  attempt: 2,
  priority: 0,
  heldByRunHours: null,
  dryRun: false,
  testEncode: false,
  testOutput: null,
  testOutputNote: null,
  fileName: 'a.mkv',
  filePath: '/lib/a.mkv',
  libraryId: 'l1',
  libraryName: 'TV',
  workflowId: 'w1',
  workflowVersion: 3,
  workflowName: 'Encode',
  progress: null,
  queuedAt: '2026-10-17T10:00:00.000Z',
  startedAt: '2026-10-17T10:00:01.000Z',
  finishedAt: '2026-10-17T10:00:05.000Z',
  reason: 'bad settings',
  result: null,
  problems: [],
  estimatedBytes: null,
  planSummary: null,
  dependsOnSize: null,
  trace: [
    entry({ seq: 1, attempt: 1, nodeId: 'in', reason: 'start' }),
    entry({ seq: 3, attempt: 2, nodeId: 'ev', reason: 'failed: bad settings' }),
    entry({ seq: 2, attempt: 2, nodeId: 'in', reason: 'start' }),
  ],
  probe: {
    container: 'matroska',
    durationSeconds: 60,
    sizeBytes: 1000,
    bitrateKbps: null,
    streams: [
      {
        index: 0,
        type: 'video',
        codec: 'hevc',
        language: null,
        title: null,
        default: true,
        forced: false,
        attachedPic: false,
        dispositions: ['comment'],
        width: 1920,
        height: 1080,
        profile: null,
        level: null,
        pixelFormat: null,
        bitDepth: null,
        hdr: null,
        channels: null,
        sampleRate: null,
        bitrateKbps: null,
        frameRate: null,
        tagBitrateKbps: null,
      },
    ],
  },
  outputProbe: null,
  graph: null,
  plan: null,
  path: [
    { workflowPath: [], nodeId: 'in', port: 'file' },
    { workflowPath: ['run-a'], nodeId: 'in', port: 'file' },
    { workflowPath: [], nodeId: 'vi', port: 'else' },
    { workflowPath: [], nodeId: 'ev', port: null },
  ],
};

describe('job report', () => {
  it('failingNodeOf picks the highest seq of the highest attempt for a failed job (trace given out of order), null otherwise', () => {
    const { trace } = detail;
    expect(failingNodeOf({ state: 'failed', trace }, titles)).toEqual({
      nodeId: 'ev',
      title: 'Encode video',
      reason: 'bad settings',
    });
    // The last entry of the last attempt is an ordinary node: nothing recorded a failure.
    const walked = [
      ...trace,
      entry({ seq: 4, attempt: 2, nodeId: 'ro', port: 'file', reason: 'replace' }),
    ];
    expect(failingNodeOf({ state: 'failed', trace: walked }, titles)).toBeNull();
    expect(failingNodeOf({ state: 'done', trace }, titles)).toBeNull();
    expect(failingNodeOf({ state: 'failed', trace: [] }, titles)).toBeNull();
  });

  it('jobReport maps path steps with titles and ports and keeps only summary probe fields; text names the failing node and the next steps', () => {
    const r = jobReport(detail, titles);
    expect(r.path).toEqual([
      { nodeId: 'in', title: 'Manual input', port: 'file', workflowPath: [] },
      { nodeId: 'in', title: 'in', port: 'file', workflowPath: ['run-a'] },
      { nodeId: 'vi', title: 'Video is', port: 'else', workflowPath: [] },
      { nodeId: 'ev', title: 'Encode video', port: null, workflowPath: [] },
    ]);
    expect(r.probe?.streams[0]).toEqual({
      index: 0,
      type: 'video',
      codec: 'hevc',
      language: null,
      default: true,
    });
    const text = jobReportText(r);
    expect(text).toMatch(/^Job j1: failed — bad settings\n/);
    expect(text).toContain('Failing node: Encode video (ev) — bad settings');
    // The sentence says No; the structured step above keeps the stored port id.
    expect(text).toContain('Path: Manual input[file] → Video is[No] → Encode video');
    expect(text).toMatch(
      /Next: get_job_log for the ffmpeg log; get_workflow w1 version 3 for the graph\.$/,
    );
  });

  it("lists each finish step's last word, a plugin step's own answer over its plan (C2, #37)", () => {
    const done: JobDetail = {
      ...detail,
      state: 'done',
      attempt: 1,
      reason: null,
      trace: [
        entry({ seq: 1, nodeId: 'in', reason: 'start' }),
        entry({
          seq: 2,
          nodeId: 'ro',
          phase: 'finish',
          port: 'file',
          reason: 'replace the original',
        }),
        entry({
          seq: 3,
          nodeId: 'rs',
          phase: 'finish',
          source: 'plugin',
          reason: 'rescan after the write',
        }),
        entry({
          seq: 4,
          nodeId: 'rs',
          phase: 'finish',
          source: 'plugin',
          reason: 'Radarr lists /m/a.mkv',
        }),
      ],
    };
    const r = jobReport(done, titles);
    expect(r.decisions.map((d) => d.reason)).toContain('Radarr lists /m/a.mkv');
    expect(jobReportText(r)).toContain(
      'Finish steps: ro — replace the original; rs — Radarr lists /m/a.mkv',
    );
  });

  it('a failed job without a failing node says it failed outside the nodes (ffmpeg named, others not guessed)', () => {
    const walked = detail.trace.filter((e) => e.seq !== 3);
    const ff = jobReportText(
      jobReport({ ...detail, trace: walked, reason: 'ffmpeg exited 1: boom' }, titles),
    );
    expect(ff).not.toContain('Failing node');
    expect(ff).toContain(
      'Failed during the ffmpeg encode, not at a workflow node: ffmpeg exited 1: boom',
    );
    const other = jobReportText(
      jobReport({ ...detail, trace: walked, reason: 'probe failed: x' }, titles),
    );
    expect(other).toContain(
      'Failed outside the workflow nodes (no node recorded the failure): probe failed: x',
    );
  });

  it('text shows result, plan and warnings when present', () => {
    const r = jobReport(
      {
        ...detail,
        state: 'done',
        paused: true,
        dryRun: true,
        reason: null,
        result: {
          outcome: 'done',
          beforeBytes: 1000,
          afterBytes: 400,
          estimatedBytes: null,
          command: null,
          replacedTo: 'recycle',
          warnings: ['w1', 'w2'],
          problems: [],
        },
        plan: {
          container: { from: 'mkv', to: 'mp4' },
          rewrite: true,
          streams: [
            {
              index: 0,
              type: 'video',
              codec: 'hevc',
              language: null,
              title: null,
              isOriginalLanguage: true,
              default: { before: true, after: true },
              forced: false,
              action: 'convert',
              note: '',
            },
            {
              index: 1,
              type: 'audio',
              codec: 'aac',
              language: 'eng',
              title: null,
              isOriginalLanguage: true,
              default: { before: true, after: true },
              forced: false,
              action: 'drop',
              note: '',
            },
          ],
        },
      },
      titles,
    );
    const text = jobReportText(r);
    expect(text).toMatch(/^Job j1: done, paused, dry run — no reason yet\n/);
    expect(text).toContain('Result: done, 1000 → 400 bytes, recycle');
    expect(text).toContain('Plan: mkv → mp4, 2 streams (1 convert, 1 drop)');
    expect(text).toContain('Warnings: w1; w2');
    expect(text).not.toContain('Problems:');
    expect(text).not.toContain('Failing node');
  });

  it('shows the problems after the write on a Problems line', () => {
    const r = jobReport(
      {
        ...detail,
        state: 'done',
        reason: null,
        result: {
          outcome: 'done',
          beforeBytes: 1000,
          afterBytes: 400,
          estimatedBytes: null,
          command: null,
          replacedTo: 'recycle',
          warnings: [],
          problems: [
            'notify failed: 503',
            'the server stopped before the remaining finish actions',
          ],
        },
      },
      titles,
    );
    expect(jobReportText(r)).toContain(
      'Problems: notify failed: 503; the server stopped before the remaining finish actions',
    );
  });

  it('a test-encode dry run is tagged [test encode] and shows its measured size instead of an estimate', () => {
    const measured: JobDetail = {
      ...detail,
      state: 'dry_run',
      dryRun: true,
      testEncode: true,
      reason: null,
      estimatedBytes: 700,
      result: {
        outcome: 'dry_run',
        beforeBytes: 1000,
        afterBytes: 600,
        estimatedBytes: 700,
        command: null,
        replacedTo: null,
        warnings: [],
        problems: [],
      },
    };
    const brief = jobBrief(measured);
    expect(brief.testEncode).toBe(true);
    const line = jobLine(brief);
    expect(line).toMatch(/^dry_run \[dry run\] \[test encode\] j1 — /);
    expect(line).toContain(' — measured 600 bytes');
    expect(line).not.toContain('estimated');
    const report = jobReport(measured, titles);
    expect(report.testEncode).toBe(true);
    expect(jobReportText(report)).toMatch(/^Job j1: dry_run, dry run, test encode — /);

    // A plan-only dry run keeps its estimate and has no tag.
    const plain = jobBrief({ ...measured, testEncode: false });
    expect(plain.testEncode).toBe(false);
    expect(jobLine(plain)).not.toContain('[test encode]');
    expect(jobLine(plain)).toContain(' — estimated 700 bytes');
    expect(jobLine(plain)).not.toContain('measured');
  });

  it('a plan-only dry run whose size gate decides says it would replace only if it saves enough (#41)', () => {
    const depends: JobDetail = {
      ...detail,
      state: 'dry_run',
      dryRun: true,
      reason: null,
      estimatedBytes: 700,
      dependsOnSize: { minSavingPercent: 25 },
    };
    const brief = jobBrief(depends);
    expect(brief.dependsOnSize).toEqual({ minSavingPercent: 25 });
    expect(jobLine(brief)).toContain(' — would replace if it saves ≥ 25% (decided after encoding)');
    // No estimate claims what the gate will decide.
    expect(jobLine(brief)).not.toContain('estimated');
    expect(jobReportText(jobReport(depends, titles))).toContain(
      'Depends on size: would replace if it saves ≥ 25%, decided after encoding (test-encode it to know)',
    );
    expect(jobLine(jobBrief({ ...depends, dependsOnSize: null }))).not.toContain('saves ≥');
    expect(jobLine(jobBrief({ ...depends, dependsOnSize: null }))).toContain(
      ' — estimated 700 bytes',
    );
  });
});
