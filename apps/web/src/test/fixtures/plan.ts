import type { JobProbe, JobResult } from '@transcoda/contract';
import type { JobPlan, ProbeStream } from '@transcoda/shared';

// Screen 06 as data: "Bluey S01E03.mp4" through TV cleanup. 20 audio tracks (eng a:2 becomes the
// default, ger a:5, jpn a:11 is the original, tur a:0 was the default and is dropped, 16 more
// dropped in 14 languages), 21 subtitles with 4 kept, HEVC video copied, cover.png kept,
// MP4 → MKV.

type PlanStream = JobPlan['streams'][number];

const AUDIO: Array<[lang: string, keep: boolean, defaultBefore: boolean, defaultAfter: boolean]> = [
  ['tur', false, true, false],
  ['fra', false, false, false],
  ['eng', true, false, true],
  ['spa', false, false, false],
  ['ita', false, false, false],
  ['deu', true, false, false],
  ['por', false, false, false],
  ['pol', false, false, false],
  ['nld', false, false, false],
  ['swe', false, false, false],
  ['dan', false, false, false],
  ['jpn', true, false, false],
  ['nor', false, false, false],
  ['fin', false, false, false],
  ['kor', false, false, false],
  ['zho', false, false, false],
  ['ces', false, false, false],
  ['hun', false, false, false],
  ['spa', false, false, false],
  ['fra', false, false, false],
];
/** Five-channel tracks; the rest are stereo. */
const SURROUND = new Set([0, 2]);

/** Languages of the dropped subtitles: none of the kept ones. */
const DROPPED_SUBS = ['tur', 'fra', 'spa', 'ita', 'por', 'pol', 'nld', 'swe', 'dan', 'nor'];

const SUBS: Array<[lang: string, keep: boolean, forced: boolean]> = Array.from(
  { length: 21 },
  (_, i): [string, boolean, boolean] => {
    if (i === 1) return ['eng', true, false];
    if (i === 2) return ['eng', true, true];
    if (i === 6) return ['deu', true, false];
    if (i === 14) return ['jpn', true, false];
    return [DROPPED_SUBS[i % DROPPED_SUBS.length] ?? 'tur', false, false];
  },
);

const AUDIO_BASE = 1;
const SUB_BASE = AUDIO_BASE + AUDIO.length;
const ATTACHMENT_INDEX = SUB_BASE + SUBS.length;

function probeStream(over: Partial<ProbeStream> & Pick<ProbeStream, 'index' | 'type' | 'codec'>) {
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
    tagBitrateKbps: null,
    ...over,
  } satisfies JobProbe['streams'][number];
}

export function blueyProbe(): JobProbe {
  return {
    container: 'mp4',
    durationSeconds: 1440,
    sizeBytes: 2_410_000_000,
    bitrateKbps: 13_000,
    streams: [
      probeStream({
        index: 0,
        type: 'video',
        codec: 'hevc',
        width: 1920,
        height: 1080,
        bitrateKbps: 6100,
        default: true,
      }),
      ...AUDIO.map(([language, , def], i) =>
        probeStream({
          index: AUDIO_BASE + i,
          type: 'audio',
          codec: 'aac',
          language,
          default: def,
          channels: SURROUND.has(i) ? 6 : 2,
        }),
      ),
      ...SUBS.map(([language, , forced], i) =>
        probeStream({ index: SUB_BASE + i, type: 'subtitle', codec: 'mov_text', language, forced }),
      ),
      probeStream({
        index: ATTACHMENT_INDEX,
        type: 'attachment',
        codec: 'png',
        title: 'cover.png',
      }),
    ],
  };
}

function planStream(over: Partial<PlanStream> & Pick<PlanStream, 'index' | 'type' | 'codec'>) {
  return {
    language: null,
    title: null,
    isOriginalLanguage: false,
    default: { before: false, after: false },
    forced: false,
    action: 'keep',
    note: '',
    ...over,
  } satisfies PlanStream;
}

export function blueyPlan(): JobPlan {
  return {
    container: { from: 'mp4', to: 'mkv' },
    rewrite: true,
    streams: [
      planStream({
        index: 0,
        type: 'video',
        codec: 'hevc',
        default: { before: true, after: true },
        note: 'copied, already under 8 Mb/s',
      }),
      ...AUDIO.map(([language, keep, before, after], i) =>
        planStream({
          index: AUDIO_BASE + i,
          type: 'audio',
          codec: 'aac',
          language,
          isOriginalLanguage: language === 'jpn',
          default: { before, after },
          action: keep ? 'keep' : 'drop',
        }),
      ),
      ...SUBS.map(([language, keep, forced], i) =>
        planStream({
          index: SUB_BASE + i,
          type: 'subtitle',
          codec: 'mov_text',
          language,
          isOriginalLanguage: language === 'jpn',
          forced,
          action: keep ? 'keep' : 'drop',
        }),
      ),
      planStream({
        index: ATTACHMENT_INDEX,
        type: 'attachment',
        codec: 'png',
        title: 'cover.png',
        note: 'kept, no rule applies',
      }),
    ],
  };
}

/** The same file when the workflow changes nothing: every stream kept as it is, MKV in and out. */
export function identityPlan(): JobPlan {
  const plan = blueyPlan();
  return {
    container: { from: 'mkv', to: 'mkv' },
    rewrite: false,
    streams: plan.streams.map((s) => ({
      ...s,
      action: 'keep' as const,
      default: { before: s.default.before, after: s.default.before },
      note: '',
    })),
  };
}

export function blueyResult(over: Partial<JobResult> = {}): JobResult {
  return {
    outcome: 'dry_run',
    beforeBytes: 2_410_000_000,
    afterBytes: null,
    estimatedBytes: 1_620_000_000,
    command:
      'ffmpeg -i "Bluey S01E03.mp4" -map 0:v:0 -map 0:a:2 -map 0:a:5 -map 0:a:11 -c copy "Bluey S01E03.mkv.tmp"',
    replacedTo: null,
    sourceDamaged: false,
    warnings: [],
    problems: [],
    ...over,
  };
}
