import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATES,
  DEVICE_PROFILE_IDS,
  DEVICE_PROFILES,
  DeviceProfileIdSchema,
  FINAL_JOB_STATES,
  isFinalState,
  JOB_STATES,
  JobPlanSchema,
  JobStateSchema,
  LANGUAGES,
  normalizeLanguage,
  normalizeProfile,
  ProbeSummarySchema,
  planSummary,
  RUNNING_JOB_STATES,
  sameLanguage,
  TraceEntrySchema,
} from '../index.ts';

describe('job states', () => {
  it('states split into 7 active and 8 final, in order', () => {
    expect(ACTIVE_JOB_STATES).toEqual([
      'queued',
      'probing',
      'deciding',
      'building',
      'encoding',
      'verifying',
      'replacing',
    ]);
    expect(FINAL_JOB_STATES).toHaveLength(8);
    expect([...ACTIVE_JOB_STATES, ...FINAL_JOB_STATES]).toEqual([...JOB_STATES]);
    expect(RUNNING_JOB_STATES).toEqual(ACTIVE_JOB_STATES.slice(1));
    expect(isFinalState('dry_run')).toBe(true);
    expect(isFinalState('encoding')).toBe(false);
    expect(JobStateSchema.safeParse('paused').success).toBe(false);
  });
});

describe('trace entries', () => {
  const entry = {
    seq: 1,
    attempt: 1,
    nodeId: 'lang',
    workflowPath: [],
    phase: 'data',
    port: null,
    reason: 'original language from metadata',
    findings: { language: 'jpn' },
    startedAt: '2026-10-16T18:00:00.000Z',
    endedAt: '2026-10-16T18:00:00.010Z',
  };
  it('TraceEntrySchema accepts top-level, nested and pass entries and rejects an unknown phase or seq 0', () => {
    expect(TraceEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      TraceEntrySchema.safeParse({
        ...entry,
        nodeId: 'drop-commentary',
        workflowPath: ['cleanup', 'inner'],
        phase: 'decide',
        port: 'yes',
        findings: {},
      }).success,
    ).toBe(true);
    expect(
      TraceEntrySchema.safeParse({ ...entry, nodeId: 'in', phase: 'pass', port: 'file' }).success,
    ).toBe(true);
    expect(TraceEntrySchema.safeParse({ ...entry, phase: 'encode' }).success).toBe(false);
    expect(TraceEntrySchema.safeParse({ ...entry, seq: 0 }).success).toBe(false);
    expect(TraceEntrySchema.safeParse({ ...entry, attempt: 0 }).success).toBe(false);
  });
});

describe('probe summary and plan', () => {
  const stream = {
    index: 0,
    type: 'video',
    codec: 'hevc',
    language: null,
    title: null,
    default: true,
    forced: false,
    attachedPic: false,
    dispositions: [],
    width: 1920,
    height: 1080,
    profile: 'main10',
    level: 120,
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    hdr: 'hdr10',
    channels: null,
    sampleRate: null,
    bitrateKbps: null,
    frameRate: 23.976,
  };
  it('ProbeSummarySchema accepts a summary and rejects an unknown stream type', () => {
    const summary = {
      container: 'matroska',
      durationSeconds: 60,
      sizeBytes: 1000,
      bitrateKbps: null,
      streams: [stream],
    };
    expect(ProbeSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      ProbeSummarySchema.safeParse({ ...summary, streams: [{ ...stream, type: 'image' }] }).success,
    ).toBe(false);
  });
  it('JobPlanSchema accepts a per-stream plan', () => {
    const plan = {
      container: { from: 'mkv', to: 'mkv' },
      streams: [
        {
          index: 0,
          type: 'video',
          codec: 'hevc',
          language: null,
          title: null,
          isOriginalLanguage: false,
          default: { before: true, after: true },
          forced: false,
          action: 'convert',
          note: 'hevc → hevc (libx265 crf 24)',
        },
      ],
      rewrite: true,
    };
    expect(JobPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      JobPlanSchema.safeParse({ ...plan, streams: [{ ...plan.streams[0], action: 'copy' }] })
        .success,
    ).toBe(false);
  });
});

describe('device profiles', () => {
  it('every device profile has at least one video codec, one audio codec, one container and a source', () => {
    expect(Object.keys(DEVICE_PROFILES).sort()).toEqual([...DEVICE_PROFILE_IDS].sort());
    for (const [id, p] of Object.entries(DEVICE_PROFILES)) {
      expect(p.id).toBe(id);
      expect(DeviceProfileIdSchema.safeParse(p.id).success).toBe(true);
      expect(Object.keys(p.video).length).toBeGreaterThan(0);
      expect(Object.keys(p.audio).length).toBeGreaterThan(0);
      expect(p.containers.length).toBeGreaterThan(0);
      expect(p.sources.length).toBeGreaterThan(0);
      for (const v of Object.values(p.video)) {
        for (const profile of v.profiles) expect(normalizeProfile(profile)).toBe(profile);
      }
    }
  });
  it('chrome does not list hevc; android-tv does', () => {
    expect(DEVICE_PROFILES.chrome.video.hevc).toBeUndefined();
    expect(DEVICE_PROFILES['android-tv'].video.hevc?.profiles).toEqual(['main', 'main10']);
  });
});

describe('languages', () => {
  it('the table covers at least the 184 ISO 639-1 languages with unique codes', () => {
    const ones = LANGUAGES.flatMap((l) => (l.one === null ? [] : [l.one]));
    expect(ones.length).toBeGreaterThanOrEqual(184);
    expect(new Set(ones).size).toBe(ones.length);
    const ts = LANGUAGES.map((l) => l.t);
    expect(new Set(ts).size).toBe(ts.length);
  });
  it('normalizeLanguage: en→eng, de/ger→deu, fre→fra, und→null, EN→eng, unknown→unknown, xyz→xyz; sameLanguage(en, eng)', () => {
    expect(normalizeLanguage('en')).toBe('eng');
    expect(normalizeLanguage('de')).toBe('deu');
    expect(normalizeLanguage('ger')).toBe('deu');
    expect(normalizeLanguage('fre')).toBe('fra');
    expect(normalizeLanguage('und')).toBeNull();
    expect(normalizeLanguage('zxx')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    expect(normalizeLanguage('EN')).toBe('eng');
    expect(normalizeLanguage('unknown')).toBe('unknown');
    expect(normalizeLanguage('xyz')).toBe('xyz');
    expect(normalizeLanguage('JPN')).toBe('jpn');
    expect(sameLanguage('en', 'eng')).toBe(true);
    expect(sameLanguage('ger', 'de')).toBe(true);
    expect(sameLanguage('en', 'fra')).toBe(false);
    expect(sameLanguage(null, null)).toBe(false);
    expect(sameLanguage('und', null)).toBe(false);
  });
});

describe('normalizeProfile', () => {
  it('normalizeProfile: "Main 10"→main10, "Constrained Baseline"→constrained-baseline, null→null', () => {
    expect(normalizeProfile('Main 10')).toBe('main10');
    expect(normalizeProfile('Constrained Baseline')).toBe('constrained-baseline');
    expect(normalizeProfile('High 4:4:4 Predictive')).toBe('high444predictive');
    expect(normalizeProfile('High')).toBe('high');
    expect(normalizeProfile('Main Still Picture')).toBe('main-still-picture');
    expect(normalizeProfile('Profile 0')).toBe('profile0');
    expect(normalizeProfile(null)).toBeNull();
  });
});

describe('planSummary', () => {
  const stream = (
    index: number,
    type: 'video' | 'audio' | 'subtitle' | 'attachment' | 'data',
    action: 'keep' | 'drop' | 'convert',
  ) => ({
    index,
    type,
    codec: 'x',
    language: null,
    title: null,
    isOriginalLanguage: false,
    default: { before: false, after: false },
    forced: false,
    action,
    note: '',
  });
  const plan = (rewrite: boolean, streams: ReturnType<typeof stream>[], to = 'mkv') => ({
    container: { from: 'mkv', to },
    streams,
    rewrite,
  });

  it('names conversions and drops per track type, then a container change', () => {
    expect(
      planSummary(
        plan(
          true,
          [
            stream(0, 'video', 'convert'),
            stream(1, 'audio', 'keep'),
            stream(2, 'subtitle', 'drop'),
            stream(3, 'subtitle', 'drop'),
            stream(4, 'attachment', 'drop'),
          ],
          'mp4',
        ),
      ),
    ).toBe('convert 1 video track; drop 2 subtitle tracks; drop 1 attachment; remux MKV → MP4');
  });

  it('counts the sidecar files that will be embedded, not the dropped ones', () => {
    const sidecar = (file: string, action: 'embed' | 'drop') => ({
      file,
      language: 'deu',
      forced: false,
      sdh: false,
      codec: 'subrip',
      action,
      note: '',
    });
    const base = plan(true, [stream(0, 'video', 'keep')]);
    expect(
      planSummary({
        ...base,
        sidecars: [sidecar('a.srt', 'embed'), sidecar('b.srt', 'embed'), sidecar('c.sup', 'drop')],
      }),
    ).toBe('embed 2 subtitle files');
    expect(planSummary({ ...base, sidecars: [sidecar('a.srt', 'embed')] })).toBe(
      'embed 1 subtitle file',
    );
    expect(planSummary({ ...base, sidecars: [sidecar('c.sup', 'drop')] })).toBe('rewrite the file');
  });

  it('a stored plan without sidecars still parses', () => {
    const parsed = JobPlanSchema.safeParse(plan(false, [stream(0, 'video', 'keep')]));
    expect(parsed.success).toBe(true);
    const withSidecars = JobPlanSchema.safeParse({
      ...plan(true, []),
      sidecars: [
        {
          file: 'a.srt',
          language: null,
          forced: false,
          sdh: true,
          codec: 'subrip',
          action: 'embed',
          note: '',
        },
      ],
    });
    expect(withSidecars.success).toBe(true);
    expect(
      JobPlanSchema.safeParse({
        ...plan(true, []),
        sidecars: [{ file: 'a.srt', action: 'keep' }],
      }).success,
    ).toBe(false);
  });

  it('an identity plan changes nothing; a flags-only rewrite still says it rewrites', () => {
    expect(planSummary(plan(false, [stream(0, 'video', 'keep')]))).toBe('nothing to change');
    expect(planSummary(plan(true, [stream(0, 'video', 'keep')]))).toBe('rewrite the file');
  });
});
