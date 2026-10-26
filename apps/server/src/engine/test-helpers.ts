// Hand-built engine inputs for unit tests (no ffprobe, no files on disk).
import type {
  BuildModel,
  FileStats,
  HookContextBase,
  ProbeResult,
  StreamPlan,
} from '@transcoda/sdk';
import type { ProbeStream } from '@transcoda/shared';

const DEFAULT_CODEC: Record<ProbeStream['type'], string> = {
  video: 'hevc',
  audio: 'aac',
  subtitle: 'subrip',
  attachment: 'ttf',
  data: 'bin_data',
};

/**
 * A ProbeResult around the given streams. Each stream defaults to a plain untagged stream of its
 * type (`video` when no type is given) with `index` = its position; the format defaults to a
 * 60-second mkv.
 */
export function probeOf(
  streams: Partial<ProbeStream>[],
  format: Partial<Omit<ProbeResult, 'streams'>> = {},
): ProbeResult {
  return {
    container: 'mkv',
    formatName: 'matroska,webm',
    durationSeconds: 60,
    sizeBytes: 100_000_000,
    bitrateKbps: 13_333,
    chapters: 0,
    raw: {},
    ...format,
    streams: streams.map((s, position) => {
      const type = s.type ?? 'video';
      return {
        index: position,
        type,
        codec: DEFAULT_CODEC[type],
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
        hdr: type === 'video' ? 'none' : null,
        channels: null,
        sampleRate: null,
        bitrateKbps: null,
        frameRate: null,
        ...s,
      };
    }),
  };
}

export function fileOf(path: string, size: number): FileStats {
  return { path, sizeBytes: size, mtime: '2026-01-01T00:00:00.000Z', nlink: 1 };
}

export function capsOf(
  encoders: string[],
  hwaccels: string[] = [],
  filters: string[] = ['pan'],
): HookContextBase['capabilities'] {
  return { encoders, filters, hwaccels };
}

/** The model with the stream for `sourceIndex` changed. */
export function withStream(
  model: BuildModel,
  sourceIndex: number,
  change: Partial<StreamPlan>,
): BuildModel {
  return {
    ...model,
    streams: model.streams.map((s) => (s.sourceIndex === sourceIndex ? { ...s, ...change } : s)),
  };
}

/** A sidecar subtitle input and the stream it contributes (`sourceIndex = -n`), for extra-input tests. */
export function withSidecar(
  model: BuildModel,
  n: number,
  file: string,
  opts: Partial<StreamPlan> & {
    language?: string | null;
    forced?: boolean;
    sdh?: boolean;
    afterReplace?: 'keep' | 'recycle';
    add?: boolean;
  } = {},
): BuildModel {
  const { afterReplace = 'recycle', sdh = false, add = true, ...plan } = opts;
  const language = opts.language === undefined ? 'deu' : opts.language;
  const forced = opts.forced ?? false;
  const extraInputs = [...(model.extraInputs ?? [])];
  extraInputs[n - 1] = {
    path: `/lib/${file}`,
    kind: 'subtitle',
    afterReplace,
    codec: opts.codec ?? 'subrip',
    label: { file, language, forced, sdh },
  };
  const stream: StreamPlan = {
    sourceIndex: -n,
    input: n,
    type: 'subtitle',
    keep: true,
    mode: 'copy',
    codec: 'subrip',
    encoder: null,
    quality: null,
    preset: null,
    bitrateKbps: null,
    channels: null,
    profile: null,
    pixelFormat: null,
    language,
    title: null,
    default: false,
    forced,
    attachedPic: false,
    dispositions: sdh ? ['hearing_impaired'] : [],
    order: model.streams.length,
    ...plan,
  };
  return { ...model, extraInputs, streams: add ? [...model.streams, stream] : model.streams };
}
