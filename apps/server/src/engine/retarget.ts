import type { BuildModel, StreamPlan } from '@transcoda/sdk';

/** A video stream an Encode video node set to `auto` put on `encoder` (main path only). */
export interface AutoPick {
  sourceIndex: number;
  /** The stream's input file: `StreamPlan.input ?? 0`. */
  input: number;
  encoder: string;
}

type GpuVendor = 'nvidia' | 'intel';

/** Each vendor's encoder for the other vendor's encoder of the same codec. */
const SWAP: Record<GpuVendor, Record<string, string>> = {
  nvidia: { hevc_qsv: 'hevc_nvenc', h264_qsv: 'h264_nvenc' },
  intel: { hevc_nvenc: 'hevc_qsv', h264_nvenc: 'h264_qsv' },
};

/** The preset each vendor's encoder takes for the other's; anything else becomes `medium`. */
const PRESET: Record<GpuVendor, Record<string, string>> = {
  nvidia: {
    veryfast: 'fast',
    faster: 'fast',
    fast: 'fast',
    medium: 'medium',
    slow: 'slow',
    slower: 'slow',
    veryslow: 'slow',
  },
  intel: {
    p1: 'veryfast',
    p2: 'veryfast',
    p3: 'faster',
    p4: 'medium',
    p5: 'slow',
    p6: 'slower',
    p7: 'veryslow',
    fast: 'fast',
    medium: 'medium',
    slow: 'slow',
  },
};

/** A software pixel format as QSV wants it (the same depth); NVENC takes either. */
const QSV_PIXEL_FORMAT: Record<string, string> = { yuv420p: 'nv12', yuv420p10le: 'p010le' };

/**
 * The indexes into `model.streams` of kept video streams in convert mode that an auto pick
 * names and that still have the picked encoder: a later hook that chose another encoder made
 * the stream no longer auto.
 */
export function autoStreams(model: BuildModel, picks: AutoPick[]): Set<number> {
  const auto = new Set<number>();
  for (const [i, s] of model.streams.entries()) {
    if (!(s.keep && s.type === 'video' && s.mode === 'convert')) continue;
    const input = s.input ?? 0;
    if (
      picks.some(
        (p) => p.sourceIndex === s.sourceIndex && p.input === input && p.encoder === s.encoder,
      )
    ) {
      auto.add(i);
    }
  }
  return auto;
}

/**
 * The model with each auto stream moved to `vendor`'s encoder for its codec (NVENC ↔ QSV), its
 * preset and pixel format mapped; quality and bitrate stay. The same model when nothing changes;
 * null when this ffmpeg lacks the target encoder.
 */
export function retarget(
  model: BuildModel,
  auto: Set<number>,
  vendor: GpuVendor,
  encoders: readonly string[],
): BuildModel | null {
  let changed = false;
  const streams: StreamPlan[] = [];
  for (const [i, s] of model.streams.entries()) {
    const target = auto.has(i) ? SWAP[vendor][s.encoder ?? ''] : undefined;
    if (target === undefined) {
      streams.push(s);
      continue;
    }
    if (!encoders.includes(target)) return null;
    changed = true;
    const pixelFormat =
      vendor === 'intel' && s.pixelFormat !== null
        ? (QSV_PIXEL_FORMAT[s.pixelFormat] ?? s.pixelFormat)
        : s.pixelFormat;
    streams.push({
      ...s,
      encoder: target,
      preset: s.preset === null ? null : (PRESET[vendor][s.preset] ?? 'medium'),
      pixelFormat,
    });
  }
  return changed ? { ...model, streams } : model;
}
