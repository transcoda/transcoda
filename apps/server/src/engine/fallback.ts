import type { BuildModel, StreamPlan } from '@transcoda/sdk';
import { kept } from './build-model.ts';

/** Hardware encoder families: the suffix ffmpeg gives each one. */
const HARDWARE = /_(nvenc|qsv|vaapi|videotoolbox|amf|v4l2m2m)$/;

/** The software encoder of each codec, best first. */
const SOFTWARE: Record<string, string[]> = {
  hevc: ['libx265'],
  h264: ['libx264'],
  av1: ['libsvtav1', 'libaom-av1'],
};

/** A hardware surface format as the software encoders want it (the same depth). */
const SOFTWARE_PIXEL_FORMAT: Record<string, string> = {
  nv12: 'yuv420p',
  p010le: 'yuv420p10le',
  p012le: 'yuv420p12le',
};

/** Does any kept video stream encode on a hardware encoder? */
export function usesHardwareEncoder(model: BuildModel): boolean {
  return kept(model).some(
    (s) => s.type === 'video' && s.mode === 'convert' && HARDWARE.test(s.encoder ?? ''),
  );
}

/**
 * The same plan with each hardware video encode moved to the codec's software encoder that this
 * ffmpeg has (libx265, libx264, SVT-AV1): same quality number or bitrate, no hardware preset, a
 * software pixel format of the same depth. Null when a stream has no software encoder here or
 * nothing runs on hardware: the job then fails as before.
 */
export function softwareFallback(
  model: BuildModel,
  encoders: readonly string[],
): BuildModel | null {
  if (!usesHardwareEncoder(model)) return null;
  const streams: StreamPlan[] = [];
  for (const s of model.streams) {
    if (!(s.type === 'video' && s.mode === 'convert' && HARDWARE.test(s.encoder ?? ''))) {
      streams.push(s);
      continue;
    }
    const software = (SOFTWARE[s.codec] ?? []).find((e) => encoders.includes(e));
    if (!software) return null;
    streams.push({
      ...s,
      encoder: software,
      preset: null,
      pixelFormat:
        s.pixelFormat === null ? null : (SOFTWARE_PIXEL_FORMAT[s.pixelFormat] ?? s.pixelFormat),
    });
  }
  return { ...model, streams };
}

/** Does this failure text look like the GPU (encoder, decoder or its driver) gave up? */
export function looksLikeGpuFailure(text: string): boolean {
  return /nvenc|cuda|cuvid|nvdec|hwaccel|hw_frames|qsv|vaapi|videotoolbox|InitializeEncoder|OpenEncodeSession/i.test(
    text,
  );
}

/** ffmpeg's lines that only follow the real error ("Nothing was written", thread shutdown, …). */
const CONSEQUENCE = [
  /Nothing was written into output file/,
  /Task finished with error code/,
  /Terminating thread with return code/,
  /Error sending frames to consumers/,
  /Could not open encoder before EOF/,
  /Error while opening encoder - maybe incorrect parameters/,
  /Conversion failed/,
  /Error submitting packet to decoder/,
  /Decode error rate .* exceeds maximum/,
  /No filtered frames for output stream/,
];

/** Plain-language hints for causes ffmpeg words for developers. */
const HINTS: [RegExp, string][] = [
  [/Frame dimensions are less than the minimum/, 'a video stream is too small for the GPU encoder'],
  [/CUDA_ERROR|cuvid|NVDEC/i, 'the GPU could not decode a stream'],
  [/No space left on device/, 'the transcode folder is full'],
  [/Permission denied/, 'Transcoda may not read or write a file it needs'],
  [/Invalid data found when processing input/, 'part of the file is damaged or not media'],
];

/**
 * Why ffmpeg failed, in one line: the first error-level line in the log tail that is a cause, not
 * a consequence, without its `[context @ 0x…]` address, plus a hint for a known cause. Falls back
 * to the tail's last line. "hevc_nvenc: InitializeEncoder failed: … (a video stream is too small
 * for the GPU encoder)".
 */
export function ffmpegFailure(tail: string): string | null {
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const errors = lines.filter((l) => /\[(error|fatal|panic)\]/.test(l));
  const cause = errors.find((l) => !CONSEQUENCE.some((re) => re.test(l))) ?? lines.at(-1);
  if (!cause) return null;
  const tidy = tidyLine(cause);
  const hint = HINTS.find(([re]) => re.test(cause))?.[1];
  return hint ? `${tidy} (${hint})` : tidy;
}

/** "[vost#0:3/hevc_nvenc @ 0x1] [enc:hevc_nvenc @ 0x2] [error] msg" → "hevc_nvenc: msg". */
function tidyLine(line: string): string {
  const contexts = [...line.matchAll(/\[([^\]]+?)(?: @ 0x[0-9a-f]+)?\]\s*/gi)].map(
    (m) => m[1] ?? '',
  );
  const text = line.replace(/^(\[[^\]]+\]\s*)+/, '').trim();
  const named = contexts
    .filter((c) => !/^(error|fatal|panic|warning|info)$/i.test(c))
    .map((c) => c.split(/[/:]/).at(-1) ?? c)
    .at(-1);
  return named && !/^\d|#/.test(named) ? `${named}: ${text}` : text;
}
