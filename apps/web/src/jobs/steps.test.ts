import type { ProbeStream, ProbeSummary, TraceChanges } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../editor/trace/traceOverlay.ts';
import { type StepContext, steps, stepsHeading, stepsSummary } from './steps.ts';

const d = (over: Partial<Decision> & Pick<Decision, 'key' | 'nodeId' | 'title'>): Decision => ({
  attempt: 1,
  depth: 0,
  reason: '',
  findings: {},
  workflowPath: [],
  kind: 'action',
  type: null,
  settings: {},
  phase: 'build',
  changes: null,
  within: null,
  plugin: false,
  port: 'file',
  untaken: false,
  branch: null,
  ...over,
});

const none: TraceChanges = {
  dropped: [],
  added: [],
  converted: [],
  defaults: [],
  reordered: false,
  other: false,
};
const changes = (over: Partial<TraceChanges>): TraceChanges => ({ ...none, ...over });

function stream(over: Partial<ProbeStream> & Pick<ProbeStream, 'index' | 'type' | 'codec'>) {
  return {
    language: null,
    title: null,
    default: false,
    forced: false,
    attachedPic: false,
    dispositions: [],
    width: null,
    height: null,
    profile: null,
    level: null,
    pixelFormat: null,
    bitDepth: null,
    hdr: null,
    channels: null,
    sampleRate: null,
    bitrateKbps: null,
    frameRate: null,
    ...over,
  } satisfies ProbeStream;
}

const probe: ProbeSummary = {
  container: 'mkv',
  durationSeconds: 1440,
  sizeBytes: 2_410_000_000,
  bitrateKbps: 13_000,
  streams: [
    stream({
      index: 0,
      type: 'video',
      codec: 'hevc',
      height: 1080,
      bitDepth: 10,
      pixelFormat: 'yuv420p10le',
    }),
    stream({ index: 1, type: 'audio', codec: 'ac3', language: 'eng', channels: 6 }),
    stream({ index: 2, type: 'subtitle', codec: 'subrip', language: 'eng', forced: true }),
    stream({ index: 3, type: 'subtitle', codec: 'subrip', language: 'eng' }),
  ],
};

const DRY: StepContext = {
  dryRun: true,
  state: 'dry_run',
  probe,
  libraryName: 'Shows',
  workflowId: 'w1',
  dependsOnSize: false,
  replacedTo: null,
};
const DONE: StepContext = { ...DRY, dryRun: false, state: 'done', replacedTo: 'recycle' };

const one = (decision: Decision, ctx: StepContext = DRY) => {
  const [step] = steps([decision], ctx);
  if (!step) throw new Error('no step');
  return step;
};

const ref = { forced: false, language: 'eng' } as const;

describe('steps: one sentence and a badge per node', () => {
  it('the trigger starts from its library', () => {
    const s = one(
      d({
        key: '1',
        nodeId: 'in',
        title: 'Library input',
        kind: 'trigger',
        type: 'core:input-library',
        phase: 'pass',
      }),
    );
    expect(s.sentence).toBe('Picked up from the Shows library');
    expect(s.badge).toBe('start');
    expect(s.detail).toBeNull();
  });

  it('Keep languages that drops nothing says so, dimmed, with the setting and the file in its details', () => {
    const s = one(
      d({
        key: '2',
        nodeId: 'keep',
        title: 'Keep languages',
        type: 'core:keep-languages',
        settings: { languages: ['en', 'de'] },
        findings: { originalLanguage: 'unknown' },
        changes: none,
        reason: 'audio: en → kept en; subtitles: en, en → kept en, en',
      }),
    );
    expect(s.sentence).toBe('All tracks are already English, so nothing is dropped');
    expect(s.badge).toBe('same');
    expect(s.quiet).toBe(true);
    expect(s.detail).toEqual({
      kind: 'languages',
      keep: 'Keep: the original language, English, German, untagged tracks',
      has: ['Audio in this file: English', 'Subtitles in this file: English (2)'],
      drops: null,
    });
  });

  it('Keep languages that drops tracks names them, past tense in a real run', () => {
    const dropped = changes({
      dropped: [
        { index: 4, type: 'audio', codec: 'aac', language: 'ger', forced: false },
        { index: 5, type: 'audio', codec: 'aac', language: 'fra', forced: false },
        { index: 6, type: 'subtitle', codec: 'subrip', language: 'tur', forced: false },
      ],
    });
    const keep = d({
      key: '2',
      nodeId: 'keep',
      title: 'Keep languages',
      type: 'core:keep-languages',
      changes: dropped,
    });
    expect(one(keep).sentence).toBe(
      'Drops 2 audio tracks (German, French) and 1 subtitle (Turkish)',
    );
    expect(one(keep, DONE).sentence).toBe(
      'Dropped 2 audio tracks (German, French) and 1 subtitle (Turkish)',
    );
    expect(one(keep).badge).toBe('change');
    expect(one(keep).detail).toMatchObject({
      drops: 'Drops: German and French audio, Turkish subtitle',
    });
  });

  it('Keep languages cuts a long list short and hands on the defaults it dropped', () => {
    const langs = ['fra', 'spa', 'ita', 'tur', 'por', 'nld'];
    const s = one(
      d({
        key: '2',
        nodeId: 'keep',
        title: 'Keep languages',
        type: 'core:keep-languages',
        changes: changes({
          dropped: langs.map((language, i) => ({
            index: 10 + i,
            type: 'audio' as const,
            codec: 'aac',
            language,
            forced: false,
          })),
          defaults: [
            { index: 1, type: 'audio', codec: 'ac3', ...ref, before: false, after: true },
            { index: 3, type: 'subtitle', codec: 'subrip', ...ref, before: false, after: true },
          ],
        }),
      }),
    );
    expect(s.sentence).toBe(
      'Drops 6 audio tracks (French, Spanish, Italian, Turkish and 2 more languages); English audio #1 and English subtitle #2 become the defaults',
    );
  });

  it('Set default track names the new defaults and shows before and after', () => {
    const s = one(
      d({
        key: '3',
        nodeId: 'sdt',
        title: 'Set default track',
        type: 'core:set-default-track',
        changes: changes({
          defaults: [
            { index: 1, type: 'audio', codec: 'ac3', ...ref, before: false, after: true },
            {
              index: 2,
              type: 'subtitle',
              codec: 'subrip',
              language: 'eng',
              forced: true,
              before: true,
              after: false,
            },
            { index: 3, type: 'subtitle', codec: 'subrip', ...ref, before: false, after: true },
          ],
        }),
      }),
    );
    expect(s.sentence).toBe('English audio #1 and English subtitle #2 become the defaults');
    expect(s.badge).toBe('change');
    expect(s.detail).toEqual({
      kind: 'defaults',
      rows: [
        { track: 'audio #1', language: 'English', before: false, after: true },
        { track: 'subtitle #1', language: 'English, forced', before: true, after: false },
        { track: 'subtitle #2', language: 'English', before: false, after: true },
      ],
    });
  });

  it('Set default track with nothing to change has no details', () => {
    const s = one(
      d({
        key: '3',
        nodeId: 'sdt',
        title: 'Set default track',
        type: 'core:set-default-track',
        changes: none,
      }),
    );
    expect(s.sentence).toBe('The default tracks already match the preference');
    expect(s.detail).toBeNull();
  });

  it('Encode video says how it encodes, with before, after and pixel format behind the row', () => {
    const s = one(
      d({
        key: '4',
        nodeId: 'ev',
        title: 'Encode video',
        type: 'core:encode-video',
        changes: changes({
          converted: [
            {
              index: 0,
              type: 'video',
              codec: 'hevc',
              language: null,
              forced: false,
              from: 'hevc',
              encoder: 'hevc_nvenc',
              quality: 24,
              preset: 'medium',
              bitrateKbps: null,
              channels: null,
              pixelFormat: 'yuv420p10le',
            },
          ],
        }),
      }),
    );
    expect(s.sentence).toBe('Video is re-encoded to HEVC on the GPU (NVENC, QP 24)');
    expect(s.detail).toEqual({
      kind: 'video',
      before: 'HEVC 10-bit, 1080p',
      after: 'HEVC 10-bit, hevc_nvenc, QP 24, medium',
      pixelFormat: 'yuv420p10le, passed to NVENC as p010le (its 10-bit format)',
    });
    expect(s.notes).toEqual([]);
  });

  it('Encode video names a target bitrate, and the ceiling of a capped quality', () => {
    const encode = (encoder: string, quality: number | null, bitrateKbps: number | null) =>
      one(
        d({
          key: '4',
          nodeId: 'ev',
          title: 'Encode video',
          type: 'core:encode-video',
          changes: changes({
            converted: [
              {
                index: 0,
                type: 'video',
                codec: 'hevc',
                language: null,
                forced: false,
                from: 'hevc',
                encoder,
                quality,
                preset: 'medium',
                bitrateKbps,
                channels: null,
                pixelFormat: 'yuv420p',
              },
            ],
          }),
        }),
      );
    const target = encode('libx265', null, 3000);
    expect(target.sentence).toBe('Video is re-encoded to HEVC in software (libx265, 3000 kb/s)');
    expect(target.detail).toMatchObject({ after: 'HEVC 8-bit, libx265, 3000 kb/s, medium' });
    const capped = encode('libx265', 24, 5000);
    expect(capped.sentence).toBe(
      'Video is re-encoded to HEVC in software (libx265, CRF 24, at most 5000 kb/s)',
    );
    expect(capped.detail).toMatchObject({
      after: 'HEVC 8-bit, libx265, CRF 24, at most 5000 kb/s, medium',
    });
    // Capped, NVENC encodes VBR with a constant-quality target (CQ), not constant QP.
    expect(encode('hevc_nvenc', 24, 5000).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (NVENC, CQ 24, at most 5000 kb/s)',
    );
    expect(encode('hevc_vaapi', 24, 5000).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (VA-API, Q 24, at most 5000 kb/s)',
    );
    expect(encode('hevc_qsv', null, 3000).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (Quick Sync, 3000 kb/s)',
    );
  });

  it('Encode video that copies says why; with a targets check and no targets it adds an action note', () => {
    const copy = d({
      key: '4',
      nodeId: 'ev',
      title: 'Encode video',
      type: 'core:encode-video',
      changes: none,
    });
    expect(one(copy).sentence).toBe("Video is already HEVC, so it's copied");
    expect(one(copy, DONE).sentence).toBe('Video was already HEVC, so it was copied');
    const unchecked = one({ ...copy, settings: { skipIf: 'plays-on-all-targets', targets: [] } });
    expect(unchecked.notes).toEqual([
      {
        text: "Playback compatibility wasn't checked: no playback targets are set.",
        link: { href: '/workflows/w1', label: 'Add targets in the workflow' },
      },
    ]);
  });

  it('Encode audio: a conversion and an added copy', () => {
    const converted = one(
      d({
        key: '5',
        nodeId: 'ea',
        title: 'Encode audio',
        type: 'core:encode-audio',
        changes: changes({
          converted: [
            {
              index: 1,
              type: 'audio',
              codec: 'aac',
              ...ref,
              from: 'ac3',
              encoder: 'aac',
              quality: null,
              preset: null,
              bitrateKbps: 160,
              channels: 2,
              pixelFormat: null,
            },
          ],
        }),
      }),
    );
    expect(converted.sentence).toBe('English audio #1 is re-encoded to AAC 160 kb/s stereo');
    const added = one(
      d({
        key: '5',
        nodeId: 'ea',
        title: 'Encode audio',
        type: 'core:encode-audio',
        findings: { warnings: ['audio #4 (dts) does not play on chrome'] },
        changes: changes({
          added: [
            {
              index: 1,
              type: 'audio',
              codec: 'aac',
              ...ref,
              from: 'ac3',
              encoder: 'aac',
              quality: null,
              preset: null,
              bitrateKbps: 160,
              channels: 2,
              pixelFormat: null,
            },
          ],
        }),
      }),
      DONE,
    );
    expect(added.sentence).toBe(
      'Added a stereo AAC copy of English audio #1 so every target can play it',
    );
    expect(added.notes).toEqual([{ text: 'Audio #4 (dts) does not play on chrome' }]);
  });

  it('Remove duplicate audio names each dropped track, what it was and what it was the same as', () => {
    const film: StepContext = {
      ...DRY,
      probe: {
        ...probe,
        streams: [
          stream({ index: 0, type: 'video', codec: 'hevc' }),
          stream({ index: 1, type: 'audio', codec: 'truehd', language: 'eng', channels: 6 }),
          stream({ index: 2, type: 'audio', codec: 'ac3', language: 'eng', channels: 6 }),
          stream({ index: 3, type: 'audio', codec: 'eac3', language: 'eng', channels: 6 }),
          stream({ index: 4, type: 'audio', codec: 'aac', language: 'deu', channels: 2 }),
          stream({ index: 5, type: 'audio', codec: 'aac', language: 'deu', channels: 2 }),
        ],
      },
    };
    const dedupe = (over: Partial<Decision>) =>
      d({
        key: '6',
        nodeId: 'dd',
        title: 'Remove duplicate audio',
        type: 'core:remove-duplicate-audio',
        changes: none,
        ...over,
      });
    const drop = (index: number, language: string) =>
      ({ index, type: 'audio', codec: 'aac', forced: false, language }) as const;
    const single = one(
      dedupe({
        findings: { dropped: [{ index: 2, sameAs: 1, codec: 'aac', channels: 2 }] },
        changes: changes({ dropped: [drop(2, 'eng')] }),
      }),
      film,
    );
    expect(single.sentence).toBe('Drops audio #2 (AC-3 5.1 → AAC 2.0): same as audio #1');
    expect(single.badge).toBe('change');

    const many = one(
      dedupe({
        findings: {
          dropped: [
            { index: 2, sameAs: 1, codec: 'aac', channels: 2 },
            { index: 3, sameAs: 1, codec: 'aac', channels: 2 },
            { index: 5, sameAs: 4, codec: 'aac', channels: 2 },
          ],
        },
        changes: changes({
          dropped: [drop(2, 'eng'), drop(3, 'eng'), drop(5, 'deu')],
          defaults: [{ ...drop(1, 'eng'), before: false, after: true }],
        }),
      }),
      { ...film, dryRun: false, state: 'done' },
    );
    expect(many.sentence).toBe(
      'Dropped audio #2 (AC-3 5.1 → AAC 2.0) and audio #3 (E-AC-3 5.1 → AAC 2.0): same as audio #1; dropped audio #5 (AAC 2.0): same as audio #4; English audio #1 became the default',
    );

    const nothing = one(dedupe({ reason: 'no duplicate audio' }), film);
    expect(nothing.sentence).toBe('No duplicate audio tracks');
    expect([nothing.badge, nothing.quiet]).toEqual(['same', true]);
  });

  it('a condition says its answer as the badge', () => {
    const s = one(
      d({
        key: '6',
        nodeId: 'vi',
        title: 'Video is',
        kind: 'condition',
        phase: 'decide',
        port: 'else',
        reason: 'video is h264 360p, wanted hevc → no',
      }),
    );
    expect(s.sentence).toBe('H264 360p, wanted hevc');
    expect(s.badge).toBe('no');
  });

  it('the size gate: plan-only, depends on size, measured', () => {
    const gate = d({
      key: '7',
      nodeId: 'sg',
      title: 'Size gate',
      kind: 'finish',
      type: 'core:size-gate',
      phase: 'finish',
      settings: { minSavingPercent: 20 },
      reason: 'size gate: at least 20% smaller',
    });
    expect(one(gate).sentence).toBe('Keeps the result only if it is at least 20% smaller');
    expect(one(gate).badge).toBe('check');
    const passed = {
      ...gate,
      branch: 'pass' as const,
      findings: { minSavingPercent: 20, savedPercent: 33.2 },
    };
    expect(one(passed, DONE).sentence).toBe(
      'The result was 33.2% smaller (at least 20% needed), so the finish steps went ahead',
    );
    const failed = {
      ...gate,
      branch: 'else' as const,
      findings: { minSavingPercent: 20, savedPercent: 3 },
    };
    expect(one(failed, { ...DONE, state: 'kept_original' }).sentence).toBe(
      'The result was only 3% smaller (at least 20% needed), so the original was kept',
    );
    const bigger = { ...failed, findings: { minSavingPercent: 20, savedPercent: -20.6 } };
    expect(one(bigger).sentence).toBe(
      'The test encode came out 20.6% bigger (at least 20% smaller needed), so a real run would keep the original',
    );
  });

  it('a test encode words its measurement as what a real run would do', () => {
    const gate = d({
      key: '7',
      nodeId: 'sg',
      title: 'Size gate',
      kind: 'finish',
      type: 'core:size-gate',
      phase: 'finish',
      branch: 'pass',
      findings: { minSavingPercent: 20, savedPercent: 33.2 },
    });
    const ro = d({
      key: '8',
      nodeId: 'ro',
      title: 'Replace original',
      kind: 'finish',
      type: 'core:replace-original',
      phase: 'finish',
    });
    expect(steps([gate, ro], DRY)[0]?.sentence).toBe(
      'The test encode came out 33.2% smaller (at least 20% needed), so a real run would replace the original',
    );
    const kept = {
      ...gate,
      branch: 'else' as const,
      findings: { minSavingPercent: 20, savedPercent: -4 },
    };
    expect(
      steps([kept, { ...ro, untaken: true }], { ...DRY, state: 'kept_original' })[0]?.sentence,
    ).toBe(
      'The test encode came out 4% bigger (at least 20% smaller needed), so a real run would keep the original',
    );
    expect(one(gate).sentence).toBe(
      'The test encode came out 33.2% smaller (at least 20% needed), so a real run would go on to the finish steps',
    );
  });

  it('a real run that settled without the gate deciding says it never measured', () => {
    const gate = d({
      key: '7',
      nodeId: 'sg',
      title: 'Size gate',
      kind: 'finish',
      type: 'core:size-gate',
      phase: 'finish',
    });
    const s = one(gate, { ...DONE, state: 'kept_original' });
    expect(s.badge).toBe('not-run');
    expect(s.sentence).toBe("Didn't decide: the job ended without measuring the result");
  });

  it('a failed job: finish steps before the failing one ran, those after did not', () => {
    const fin = (key: string, nodeId: string, title: string, type: string, reason = '') =>
      d({ key, nodeId, title, kind: 'finish', type, phase: 'finish', reason });
    const list = steps(
      [
        fin('1', 'ro', 'Replace original', 'core:replace-original'),
        fin('2', 'mc', 'Move or copy', 'core:move-copy', 'failed: /out is not writable'),
        fin('3', 'nw', 'Notify webhook', 'core:notify-webhook'),
      ],
      { ...DONE, state: 'failed' },
    );
    expect(list.map((s) => s.sentence)).toEqual([
      "Replaced the original, which is now in this library's recycle folder",
      '/out is not writable',
      "Didn't run: the job failed first",
    ]);
  });

  it('Encode video after an earlier step converted the video says so', () => {
    const s = one(
      d({
        key: '4',
        nodeId: 'ev2',
        title: 'Encode video',
        type: 'core:encode-video',
        changes: none,
        reason: 'video already converted to hevc → unchanged',
      }),
    );
    expect(s.sentence).toBe(
      'Video is already being re-encoded by an earlier step, so this step leaves it',
    );
  });

  it('one row per node: the gate decision replaces its build entry', () => {
    const build = d({
      key: '7',
      nodeId: 'sg',
      title: 'Size gate',
      kind: 'finish',
      type: 'core:size-gate',
      phase: 'finish',
      reason: 'size gate: at least 20% smaller',
    });
    const decided = {
      ...build,
      key: '9',
      branch: 'pass' as const,
      findings: { minSavingPercent: 20, savedPercent: 40 },
    };
    const list = steps([build, decided], DONE);
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe('9');
  });

  it('Replace original: dry, depends on size (#41), done, and not run', () => {
    const ro = d({
      key: '8',
      nodeId: 'ro',
      title: 'Replace original',
      kind: 'finish',
      type: 'core:replace-original',
      phase: 'finish',
      reason: 'replace the original (recycle folder: library default)',
    });
    expect(one(ro).sentence).toBe(
      "Replaces the original, which moves to this library's recycle folder",
    );
    expect(one(ro).badge).toBe('finish');
    expect(one(ro, { ...DRY, dependsOnSize: true }).sentence).toBe(
      "If the size gate passes, replaces the original and moves it to this library's recycle folder; otherwise keeps it",
    );
    expect(one(ro, DONE).sentence).toBe(
      "Replaced the original, which is now in this library's recycle folder",
    );
    const failed = one(ro, { ...DONE, state: 'failed' });
    expect(failed.sentence).toBe("Didn't run: the job failed first");
    expect(failed.badge).toBe('not-run');
    expect(one(ro, { ...DRY, state: 'failed' }).sentence).toBe("Didn't run: the job failed first");
    expect(one({ ...ro, untaken: true }, DONE).sentence).toBe(
      "Didn't run: the file took the size gate's other branch",
    );
  });

  it('a failed step says what went wrong; a bypassed one that it was skipped', () => {
    const failed = one(
      d({
        key: '9',
        nodeId: 'ev',
        title: 'Encode video',
        type: 'core:encode-video',
        reason: 'failed: no hevc encoder is available',
      }),
    );
    expect(failed.sentence).toBe('No hevc encoder is available');
    expect(failed.badge).toBe('failed');
    const bypassed = one(
      d({ key: '9', nodeId: 'ev', title: 'Encode video', reason: 'bypassed' }),
      DONE,
    );
    expect(bypassed.sentence).toBe('Bypassed, so this step was skipped');
    expect(bypassed.badge).toBe('same');
  });

  it('an action from before the trace said what changed keeps its reason and has no badge', () => {
    const s = one(
      d({ key: '10', nodeId: 'ca', title: 'Cover and attachments', reason: 'cover kept' }),
    );
    expect(s.sentence).toBe('Cover kept');
    expect(s.badge).toBeNull();
  });
});

describe('stepsSummary / stepsHeading', () => {
  it('counts changing, unchanged and notes', () => {
    const list = steps(
      [
        d({
          key: '1',
          nodeId: 'a',
          title: 'A',
          type: 'core:reorder-tracks',
          changes: changes({ reordered: true }),
        }),
        d({ key: '2', nodeId: 'b', title: 'B', type: 'core:reorder-tracks', changes: none }),
        d({
          key: '3',
          nodeId: 'c',
          title: 'C',
          type: 'core:encode-video',
          changes: none,
          settings: { skipIf: 'plays-on-all-targets' },
        }),
      ],
      DRY,
    );
    expect(stepsSummary(list)).toEqual({ changing: 1, unchanged: 2, notes: 1 });
  });

  it('words the heading by what the job is', () => {
    expect(stepsHeading(DRY)).toBe('What the workflow would do');
    expect(stepsHeading(DONE)).toBe('What the workflow did');
    expect(stepsHeading({ ...DONE, state: 'encoding' })).toBe('What the workflow is doing');
    expect(stepsHeading({ ...DONE, state: 'failed' })).toBe('What the workflow planned');
  });
});
