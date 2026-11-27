import type { ProbeStream, ProbeSummary, TraceChanges, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../../editor/trace/trace-overlay.ts';
import {
  badgeWord,
  damagedSideOf,
  didText,
  type StepContext,
  steps,
  stepsHeading,
  stepsSummary,
  videoConversionOf,
} from './steps.ts';

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
    expect(target.sentence).toBe('Video is re-encoded to HEVC in software (libx265, 3.0 Mb/s)');
    expect(target.detail).toMatchObject({ after: 'HEVC 8-bit, libx265, 3.0 Mb/s, medium' });
    const capped = encode('libx265', 24, 5000);
    expect(capped.sentence).toBe(
      'Video is re-encoded to HEVC in software (libx265, CRF 24, at most 5.0 Mb/s)',
    );
    expect(capped.detail).toMatchObject({
      after: 'HEVC 8-bit, libx265, CRF 24, at most 5.0 Mb/s, medium',
    });
    // Capped, NVENC encodes VBR with a constant-quality target (CQ), not constant QP.
    expect(encode('hevc_nvenc', 24, 5000).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (NVENC, CQ 24, at most 5.0 Mb/s)',
    );
    expect(encode('hevc_vaapi', 24, 5000).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (VA-API, Q 24, at most 5.0 Mb/s)',
    );
    expect(encode('hevc_qsv', null, 3000).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (Quick Sync, 3.0 Mb/s)',
    );
  });

  it('Encode video says the encoder that ran: a GPU encode that fell back to software', () => {
    const decision = d({
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
            from: 'h264',
            encoder: 'hevc_nvenc',
            quality: 23,
            preset: null,
            bitrateKbps: 3300,
            channels: null,
            pixelFormat: 'yuv420p',
          },
        ],
      }),
    });
    // The plan after the fallback: what the job's page reads into `videoConversion`.
    const plan = {
      streams: [
        {
          type: 'video',
          action: 'convert',
          note: 'convert h264→hevc (libx265 crf 23 medium max 3300k)',
        },
        { type: 'audio', action: 'keep', note: 'keep' },
      ],
    };
    const ran = videoConversionOf(plan);
    expect(ran).toMatchObject({ encoder: 'libx265', quality: 'CRF 23' });
    const s = one(decision, { ...DRY, videoConversion: ran });
    expect(s.sentence).toBe(
      'Video is re-encoded to HEVC in software (libx265, CRF 23, at most 3.3 Mb/s)',
    );
    expect(s.detail).toMatchObject({ after: 'HEVC 8-bit, libx265, CRF 23, at most 3.3 Mb/s' });
    // The same encoder in the plan, or no plan: the trace's words.
    expect(one(decision, { ...DRY, videoConversion: null }).sentence).toBe(
      'Video is re-encoded to HEVC on the GPU (NVENC, CQ 23, at most 3.3 Mb/s)',
    );
    expect(videoConversionOf(null)).toBeNull();
    // An earlier attempt (the GPU one that failed) keeps its own encoder; the last one says what ran.
    const [first, second] = steps(
      [
        { ...decision, key: 'a1', attempt: 1 },
        { ...decision, key: 'a2', attempt: 2 },
      ],
      { ...DRY, videoConversion: ran },
    );
    expect(first?.sentence).toContain('on the GPU (NVENC');
    expect(second?.sentence).toContain('in software (libx265');
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
      'Failed: /out is not writable',
      "Didn't run: the job failed first",
    ]);
  });

  it('an encode killed partway: Render (planned, then failed) reads Failed with the reason; the steps after it did not run', () => {
    const fin = (key: string, nodeId: string, title: string, type: string, reason = '') =>
      d({ key, nodeId, title, kind: 'finish', type, phase: 'finish', reason, port: null });
    const list = steps(
      [
        fin('3', 'render-1', 'Render', 'core:render', 'render'),
        fin('4', 'ro', 'Replace original', 'core:replace-original'),
        fin('5', 'render-1', 'Render', 'core:render', 'failed: encode: ffmpeg was killed'),
      ],
      { ...DONE, state: 'failed' },
    );
    expect(list.map((s) => [s.decision.nodeId, s.badge, s.sentence])).toEqual([
      ['render-1', 'failed', 'Failed: encode: ffmpeg was killed'],
      ['ro', 'not-run', "Didn't run: the job failed first"],
    ]);
    // A plugin step after it never ran either (its planned entry is all it has).
    const plugin = d({
      key: '6',
      nodeId: 'note',
      title: 'Note',
      kind: 'finish',
      phase: 'finish',
      reason: 'queued',
      plugin: true,
      port: null,
    });
    const withPlugin = steps(
      [fin('3', 'render-1', 'Render', 'core:render', 'failed: encode: ffmpeg was killed'), plugin],
      { ...DONE, state: 'failed' },
    );
    expect(withPlugin[1]?.sentence).toBe("Didn't run: the job failed first");
  });

  it('canceled during the encode: Render reads Canceled, the steps after it did not run', () => {
    const fin = (key: string, nodeId: string, title: string, type: string, reason = '') =>
      d({ key, nodeId, title, kind: 'finish', type, phase: 'finish', reason, port: null });
    const list = steps(
      [
        fin('3', 'render-1', 'Render', 'core:render', 'render'),
        fin('4', 'ro', 'Replace original', 'core:replace-original'),
        fin(
          '5',
          'render-1',
          'Render',
          'core:render',
          'canceled: the job was canceled during this step',
        ),
      ],
      { ...DONE, state: 'cancelled' },
    );
    expect(list.map((s) => [s.badge, s.sentence])).toEqual([
      ['canceled', 'The job was canceled during this step'],
      ['not-run', "Didn't run: the job was canceled first"],
    ]);
    expect(badgeWord('canceled', true)).toBe('Canceled');
  });

  it("a cancel says only the canceled attempt's steps did not run: an earlier attempt's plugin step ran", () => {
    const note = (attempt: number, key: string, reason: string) =>
      d({
        key,
        attempt,
        nodeId: 'note',
        title: 'Note',
        kind: 'finish',
        phase: 'finish',
        reason,
        plugin: true,
        port: null,
      });
    const list = steps([note(1, '1', 'noted'), note(2, '2', 'queued')], {
      ...DONE,
      state: 'cancelled',
    });
    expect(list.map((s) => [s.decision.attempt, s.badge === 'not-run'])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(list[1]?.sentence).toBe("Didn't run: the job was canceled first");
  });

  it("lists the job's problems and warnings on their node's step (last attempt only)", () => {
    const nw = (attempt: number, key: string) =>
      d({
        key,
        attempt,
        nodeId: 'nw',
        title: 'Notify webhook',
        kind: 'finish',
        type: 'core:notify-webhook',
        phase: 'finish',
        settings: { method: 'POST' },
      });
    const message = 'notify https://hooks.example/… failed: fetch failed';
    const list = steps([nw(1, '1'), nw(2, '2')], {
      ...DONE,
      nodeProblems: [{ workflowPath: [], nodeId: 'nw', severity: 'warning', message }],
    });
    expect(list.map((s) => s.notes.map((n) => n.text))).toEqual([[], [`Warning: ${message}`]]);
  });

  it('a notify that could not send says it did not send; one the webhook refused says what it answered', () => {
    const nw = d({
      key: '1',
      nodeId: 'nw',
      title: 'Notify webhook',
      kind: 'finish',
      type: 'core:notify-webhook',
      phase: 'finish',
      settings: { method: 'POST' },
    });
    const said = (message: string | null) =>
      one(nw, {
        ...DONE,
        nodeProblems:
          message === null
            ? []
            : [{ workflowPath: [], nodeId: 'nw', severity: 'warning', message }],
      }).sentence;
    expect(said('notify https://hooks.example/… failed: fetch failed')).toBe(
      "Didn't send the POST request to the webhook: fetch failed",
    );
    expect(said('notify https://hooks.example/… answered 500')).toBe(
      'Sent a POST request to the webhook, but it answered 500',
    );
    expect(said(null)).toBe('Sent a POST request to the webhook');
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
      "Would replace the original and move it to this library's recycle folder",
    );
    expect(one(ro).badge).toBe('finish');
    expect(one(ro, { ...DRY, dependsOnSize: true }).sentence).toBe(
      "Would replace the original and move it to this library's recycle folder if the size gate passes; otherwise keeps it",
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

  it('Move or copy: a dry run says what a real run would do, a real run what it did', () => {
    const mc = d({
      key: '8',
      nodeId: 'mc',
      title: 'Move or copy',
      kind: 'finish',
      type: 'core:move-copy',
      phase: 'finish',
      settings: { mode: 'move', outputRoot: '/out' },
      reason: 'move the result to /out',
    });
    expect(one(mc).sentence).toBe('Would move the result to /out');
    expect(one(mc, DONE).sentence).toBe('Moved the result to /out');
    expect(one(mc, { ...DRY, dependsOnSize: true }).sentence).toBe(
      'Would move the result to /out if the size gate passes; otherwise keeps the original',
    );
    expect(
      one(
        { ...mc, settings: { mode: 'copy', outputRoot: '/out' } },
        { ...DRY, dependsOnSize: true },
      ).sentence,
    ).toBe('Would copy the result to /out if the size gate passes; otherwise keeps the original');
  });

  it('a real run that wrote words its write steps on the flow in the past tense', () => {
    expect(didText('replace the original (recycle folder: library default)')).toBe(
      'replaced the original (recycle folder: library default)',
    );
    expect(didText('move the result to /out')).toBe('moved the result to /out');
    expect(didText('copy the result to /out')).toBe('copied the result to /out');
    expect(didText('size gate: at least 10% smaller')).toBe('size gate: at least 10% smaller');
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
    expect(failed.sentence).toBe('Failed: no hevc encoder is available');
    // Raw error text keeps its case.
    const killed = one(
      d({
        key: '9',
        nodeId: 'ev',
        title: 'Encode video',
        reason: 'failed: ffmpeg killed by SIGKILL',
      }),
    );
    expect(killed.sentence).toBe('Failed: ffmpeg killed by SIGKILL');
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

describe('steps: the Damaged side', () => {
  const graph: WorkflowGraph = {
    formatVersion: 2,
    kind: 'workflow',
    nodes: ['in', 'r', 'ro', 'nw', 'rd', 'cs', 'nw2'].map((id) => ({
      id,
      type: id === 'r' ? 'core:render' : id === 'cs' ? 'core:check-source' : `core:${id}`,
      typeVersion: 1,
      settings: {},
      position: { x: 0, y: 0 },
    })),
    edges: [
      { id: 'e1', from: { node: 'in', port: 'file' }, to: { node: 'r', port: 'file' } },
      { id: 'e2', from: { node: 'r', port: 'done' }, to: { node: 'ro', port: 'file' } },
      { id: 'e3', from: { node: 'r', port: 'damaged' }, to: { node: 'nw', port: 'file' } },
      { id: 'e4', from: { node: 'nw', port: 'file' }, to: { node: 'rd', port: 'file' } },
      { id: 'e5', from: { node: 'cs', port: 'damaged' }, to: { node: 'nw2', port: 'file' } },
    ],
    groups: [],
  };
  const side = damagedSideOf(graph);
  const render = (reason: string, port: string | null) =>
    d({
      key: 'r',
      nodeId: 'r',
      title: 'Render',
      kind: 'finish',
      type: 'core:render',
      phase: 'finish',
      reason,
      port,
    });
  const notify = d({
    key: 'nw',
    nodeId: 'nw',
    title: 'Notify webhook',
    kind: 'finish',
    type: 'core:notify-webhook',
    phase: 'finish',
    reason: 'notify https://hooks.example.com',
    settings: { method: 'POST' },
  });
  const plugin = d({
    key: 'rd',
    nodeId: 'rd',
    title: 'Replace damaged file',
    kind: 'finish',
    type: 'example:replace-damaged',
    phase: 'finish',
    plugin: true,
    reason: 'Radarr: blocklisted the release and started a search',
  });

  it('damagedSideOf lists the nodes below a Damaged output', () => {
    expect([...side].sort()).toEqual(['nw', 'nw2', 'rd']);
  });

  it('damagedSideOf leaves out a node also reached without a Damaged output; one reached from two Damaged outputs stays', () => {
    const edge = (id: string, from: string, port: string, to: string) => ({
      id,
      from: { node: from, port },
      to: { node: to, port: 'file' },
    });
    // ro → nw too: nw runs after a good render as well, and so does rd behind it
    const mixed = { ...graph, edges: [...graph.edges, edge('e6', 'ro', 'file', 'nw')] };
    expect([...damagedSideOf(mixed)].sort()).toEqual(['nw2']);
    // cs.damaged → rd as well: both ways in are Damaged sides
    const both = { ...graph, edges: [...graph.edges, edge('e7', 'cs', 'damaged', 'rd')] };
    expect([...damagedSideOf(both)].sort()).toEqual(['nw', 'nw2', 'rd']);
    // a data node feeding nw is not a way in for the file
    const withData: WorkflowGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...(graph.nodes[0] as WorkflowGraph['nodes'][number]), id: 'd', type: 'test:data' },
      ],
      edges: [
        ...graph.edges,
        { id: 'e8', from: { node: 'd', port: 'v' }, to: { node: 'nw', port: 'v' } },
      ],
    };
    const kindOf = (type: string) => (type === 'test:data' ? 'data' : undefined);
    expect([...damagedSideOf(withData, kindOf)].sort()).toEqual(['nw', 'nw2', 'rd']);
  });

  it('a plan shows "if the source is damaged: …" on Render and on the Damaged steps', () => {
    const ctx = { ...DRY, damagedSide: side };
    expect(
      one(
        render('Render: decides while encoding; if the source is damaged: Notify webhook', null),
        ctx,
      ).sentence,
    ).toBe('Decides while encoding; if the source is damaged: Notify webhook');
    expect(one(notify, ctx).sentence).toBe(
      'If the source is damaged: Would send a POST request to the webhook',
    );
  });

  it('a damaged real run: Render says why, the Damaged steps ran with their answers', () => {
    const ctx: StepContext = {
      ...DONE,
      state: 'kept_original',
      replacedTo: null,
      sourceDamaged: true,
      damagedSide: side,
    };
    expect(
      one(
        render('Render: source is damaged (Invalid LFE scale factor index) → Damaged', 'damaged'),
        ctx,
      ).sentence,
    ).toBe('Source is damaged (Invalid LFE scale factor index)');
    expect(one(notify, ctx)).toMatchObject({
      badge: 'finish',
      sentence: 'Sent a POST request to the webhook',
    });
    expect(one(plugin, ctx).sentence).toBe('Radarr: blocklisted the release and started a search');
  });

  it('a real run whose source was fine: the Damaged steps did not run', () => {
    const ctx = { ...DONE, damagedSide: side };
    expect(one(render('Render: encoded and verified → Done', 'done'), ctx).sentence).toBe(
      'Encoded and verified',
    );
    expect(one(notify, ctx)).toMatchObject({
      badge: 'not-run',
      sentence: "Didn't run: the source was not damaged",
    });
    expect(one(plugin, ctx).sentence).toBe("Didn't run: the source was not damaged");
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
