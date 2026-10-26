// Renders a BuildModel to an ffmpeg argv. Version-specific encoder flags live in ENCODER_ARGS.
import { isAbsolute } from 'node:path';
import type { BuildModel, StreamPlan } from '@transcoda/sdk';
import { containerCanHold, coverFile, isExtraStream, isMkvCover, kept } from './build-model.ts';

/** A model that cannot be rendered safely; the pipeline fails the job with `render: <message>`. */
export class RenderError extends Error {
  override name = 'RenderError';
}

/**
 * Per-stream encoder flags (rate control, speed, profile). `profile` is the encoder's own name for
 * the stream's profile, already checked against its pixel format.
 */
type EncoderArgs = (i: number, s: StreamPlan, profile: string | null) => string[];

function opt(name: string, i: number, value: string | number | null): string[] {
  return value === null ? [] : [`-${name}:${i}`, String(value)];
}

/** Normalised profile (see normalizeProfile) → the encoder's own name and its bit depth. */
type Profiles = Record<string, { name: string; bitDepth: number }>;

const BASELINE = { name: 'baseline', bitDepth: 8 };
const MAIN = { name: 'main', bitDepth: 8 };
const HIGH = { name: 'high', bitDepth: 8 };
const MAIN10 = { name: 'main10', bitDepth: 10 };

/** The profiles each encoder can be asked for; a profile on any other encoder is a RenderError. */
const PROFILES: Record<string, Profiles> = {
  libx264: {
    baseline: BASELINE,
    'constrained-baseline': BASELINE,
    main: MAIN,
    high: HIGH,
    high10: { name: 'high10', bitDepth: 10 },
  },
  libx265: { main: MAIN, main10: MAIN10, main12: { name: 'main12', bitDepth: 12 } },
  hevc_nvenc: { main: MAIN, main10: MAIN10 },
  h264_nvenc: { baseline: BASELINE, 'constrained-baseline': BASELINE, main: MAIN, high: HIGH },
  hevc_qsv: { main: MAIN, main10: MAIN10 },
  h264_qsv: { baseline: BASELINE, main: MAIN, high: HIGH },
};

/**
 * Bit depth of a 4:2:0 pixel format; null for anything else (no supported profile fits it).
 * Target checks use it too, so a converted stream's bit depth means the same in both places.
 */
export function yuv420Depth(pixelFormat: string): number | null {
  if (/^(yuv420p|yuvj420p|nv12)$/.test(pixelFormat)) return 8;
  if (/^(yuv420p10|p010)(le|be)$/.test(pixelFormat)) return 10;
  if (/^(yuv420p12|p012)(le|be)$/.test(pixelFormat)) return 12;
  return null;
}

/**
 * The encoder's name for the stream's profile, checked against its pixel format: libx265
 * silently downgrades and libx264 refuses a profile whose bit depth does not match.
 */
function profileName(s: StreamPlan, encoder: string): string | null {
  if (s.profile === null) return null;
  const profile = PROFILES[encoder]?.[s.profile];
  if (!profile) throw new RenderError(`profile ${s.profile} is not supported by ${encoder}`);
  if (s.pixelFormat === null) throw new RenderError(`profile ${s.profile} needs a pixel format`);
  if (yuv420Depth(s.pixelFormat) !== profile.bitDepth) {
    throw new RenderError(
      `profile ${s.profile} (${profile.bitDepth}-bit 4:2:0) does not fit pixel format ${s.pixelFormat}`,
    );
  }
  return profile.name;
}

const kbps = (n: number) => `${n}k`;

/**
 * A video stream's rate control: `quality` alone is constant quality, `bitrateKbps` alone a target
 * bitrate, and both are capped quality (the bitrate is the most the encoder may spend).
 */
type Rate =
  | { kind: 'quality'; quality: number }
  | { kind: 'bitrate'; kbps: number }
  | { kind: 'capped'; quality: number; kbps: number }
  | null;

function rateOf(s: StreamPlan): Rate {
  if (s.quality !== null && s.bitrateKbps !== null) {
    return { kind: 'capped', quality: s.quality, kbps: s.bitrateKbps };
  }
  if (s.quality !== null) return { kind: 'quality', quality: s.quality };
  if (s.bitrateKbps !== null) return { kind: 'bitrate', kbps: s.bitrateKbps };
  return null;
}

/** A VBV ceiling: maxrate with a two-second-ish buffer (x264 ignores a maxrate without one). */
const ceiling = (i: number, max: number) => [
  `-maxrate:${i}`,
  kbps(max),
  `-bufsize:${i}`,
  kbps(max * 2),
];

/** crf for quality; a VBV ceiling caps it (x264, x265 and SVT-AV1 all honour one with crf). */
function crfRate(i: number, s: StreamPlan): string[] {
  const rate = rateOf(s);
  if (rate === null) return [];
  if (rate.kind === 'bitrate') return [`-b:${i}`, kbps(rate.kbps)];
  return [
    `-crf:${i}`,
    String(rate.quality),
    ...(rate.kind === 'capped' ? ceiling(i, rate.kbps) : []),
  ];
}

const crfPreset: EncoderArgs = (i, s) => [...crfRate(i, s), ...opt('preset', i, s.preset)];
// NVENC's constqp ignores a maxrate, so capped quality is VBR with a constant-quality target.
const nvenc: EncoderArgs = (i, s, profile) => {
  const rate = rateOf(s);
  const args =
    rate === null
      ? []
      : rate.kind === 'quality'
        ? [`-rc:${i}`, 'constqp', `-qp:${i}`, String(rate.quality)]
        : rate.kind === 'bitrate'
          ? [`-rc:${i}`, 'vbr', `-b:${i}`, kbps(rate.kbps)]
          : [
              `-rc:${i}`,
              'vbr',
              `-cq:${i}`,
              String(rate.quality),
              `-b:${i}`,
              '0',
              ...ceiling(i, rate.kbps),
            ];
  return [...args, ...opt('preset', i, s.preset), ...opt('profile', i, profile)];
};
// QSV: global_quality alone is ICQ, a bitrate alone VBR. A quality with a bitrate below the maxrate
// is QVBR (a bitrate equal to the maxrate would pick CBR), so the target sits 1k under the cap.
const qsv: EncoderArgs = (i, s, profile) => {
  const rate = rateOf(s);
  const args =
    rate === null
      ? []
      : rate.kind === 'quality'
        ? [`-global_quality:${i}`, String(rate.quality)]
        : rate.kind === 'bitrate'
          ? [`-b:${i}`, kbps(rate.kbps)]
          : [
              `-global_quality:${i}`,
              String(rate.quality),
              `-b:${i}`,
              kbps(Math.max(1, rate.kbps - 1)),
              ...ceiling(i, rate.kbps),
            ];
  return [...args, ...opt('preset', i, s.preset), ...opt('profile', i, profile)];
};
// VAAPI has no presets; constant QP via rc_mode CQP. Without an rc_mode ffmpeg picks the best mode
// the driver has: a bitrate tries AVBR, VBR, CBR; a quality with a bitrate tries QVBR, then ICQ
// and CQP (a driver without QVBR encodes at the quality, uncapped).
const vaapi: EncoderArgs = (i, s) => {
  const rate = rateOf(s);
  if (rate === null) return [];
  if (rate.kind === 'quality') return [`-rc_mode:${i}`, 'CQP', `-qp:${i}`, String(rate.quality)];
  if (rate.kind === 'bitrate') return [`-b:${i}`, kbps(rate.kbps)];
  return [
    `-global_quality:${i}`,
    String(rate.quality),
    `-b:${i}`,
    kbps(rate.kbps),
    `-maxrate:${i}`,
    kbps(rate.kbps),
  ];
};

/** Rate-control, speed and profile flags per video encoder: the part that changes with ffmpeg versions. */
const ENCODER_ARGS: Record<string, EncoderArgs> = {
  libx264: (i, s, profile) => [...crfPreset(i, s, profile), ...opt('profile', i, profile)],
  // x265 takes its profile through x265-params.
  libx265: (i, s, profile) => [
    ...crfPreset(i, s, profile),
    ...opt('x265-params', i, profile === null ? null : `profile=${profile}`),
  ],
  libsvtav1: crfPreset,
  // libaom: crf with a zero bitrate is constant quality, with a nonzero one constrained quality
  // (that bitrate is the ceiling); its speed knob is cpu-used.
  'libaom-av1': (i, s) => [
    ...opt('crf', i, s.quality),
    ...opt(
      'b',
      i,
      s.bitrateKbps === null ? (s.quality === null ? null : '0') : kbps(s.bitrateKbps),
    ),
    ...opt('cpu-used', i, s.preset),
  ],
  hevc_nvenc: nvenc,
  h264_nvenc: nvenc,
  hevc_qsv: qsv,
  h264_qsv: qsv,
  hevc_vaapi: vaapi,
  h264_vaapi: vaapi,
};

/** Subtitle codec → the ffmpeg encoder that writes it. */
const SUBTITLE_ENCODERS: Record<string, string> = { subrip: 'srt' };

/** NVENC's own option naming the CUDA device it encodes on. */
function deviceArgs(encoder: string, i: number, device: RenderDevice | undefined): string[] {
  return device?.kind === 'cuda' && encoder.endsWith('_nvenc') ? opt('gpu', i, device.index) : [];
}

function codecArgs(s: StreamPlan, i: number, device?: RenderDevice, vpp?: string): string[] {
  // Data streams (timecode, metadata tracks) are always copied; nothing can encode them.
  if (s.mode === 'copy' || s.type === 'data') return [`-c:${i}`, 'copy'];
  if (s.type === 'subtitle') {
    return [`-c:${i}`, s.encoder ?? SUBTITLE_ENCODERS[s.codec] ?? s.codec];
  }
  const encoder = s.encoder ?? s.codec;
  const profile = profileName(s, encoder);
  const args = [`-c:${i}`, encoder];
  if (s.type === 'video') {
    args.push(...(ENCODER_ARGS[encoder]?.(i, s, profile) ?? []), ...deviceArgs(encoder, i, device));
  }
  if (s.type === 'audio') {
    args.push(...opt('b', i, s.bitrateKbps === null ? null : `${s.bitrateKbps}k`));
    args.push(...opt('ac', i, s.channels));
  }
  if (vpp) args.push(`-filter:${i}`, `vpp_qsv=format=${vpp}`);
  else args.push(...opt('pix_fmt', i, s.pixelFormat));
  return args;
}

function metadataArgs(s: StreamPlan, i: number): string[] {
  const args: string[] = [];
  // Always written: ffmpeg copies the source stream's tags, so a cleared language must be `und`.
  args.push(`-metadata:s:${i}`, `language=${s.language ?? 'und'}`);
  args.push(`-metadata:s:${i}`, `title=${s.title ?? ''}`);
  const flags = [
    ...(s.default ? ['default'] : []),
    ...(s.forced ? ['forced'] : []),
    ...(s.attachedPic ? ['attached_pic'] : []),
    ...s.dispositions,
  ];
  args.push(`-disposition:${i}`, flags.length > 0 ? flags.join('+') : '0');
  return args;
}

/**
 * The GPU a job decodes and encodes on: CUDA's index (ffmpeg runs with PCI bus order) or an Intel
 * GPU's DRM render node (QSV).
 */
export type RenderDevice = { kind: 'cuda'; index: number } | { kind: 'qsv'; renderNode: string };

/** The vendor of a device; null for none (ffmpeg's default). */
export function deviceVendor(d: RenderDevice | null): 'nvidia' | 'intel' | null {
  if (!d) return null;
  return d.kind === 'cuda' ? 'nvidia' : 'intel';
}

export interface RenderInput {
  model: BuildModel;
  input: string;
  output: string;
  /**
   * For an mkv output: source index → absolute path of each kept cover's image, extracted
   * beforehand with `coverExtractArgs` (ffmpeg can only attach files, not input streams).
   */
  coverFiles?: ReadonlyMap<number, string>;
  /**
   * Extra input number (1-based) → absolute path of the private copy ffmpeg reads. The original
   * sidecar path is never given to ffmpeg; every extra input needs an entry.
   */
  extraInputFiles?: ReadonlyMap<number, string>;
  /** Absent: ffmpeg's default device (the only GPU, or CUDA device 0). */
  device?: RenderDevice;
}

/** ffmpeg demuxer for a sidecar subtitle codec (`ssa` is read by the ass demuxer). */
const SIDECAR_DEMUXERS: Record<string, string> = {
  subrip: 'srt',
  ass: 'ass',
  ssa: 'ass',
  webvtt: 'webvtt',
  hdmv_pgs_subtitle: 'sup',
};

/** The ffmpeg argv that copies stream `sourceIndex` (a cover) of `input` into an image file. */
export function coverExtractArgs(input: string, sourceIndex: number, output: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-v',
    'error',
    '-i',
    input,
    '-map',
    `0:${sourceIndex}`,
    '-c',
    'copy',
    '-frames:v',
    '1',
    '-f',
    'image2',
    output,
  ];
}

/** `-attach` plus filename/mimetype for each mkv cover, at the output indices after `first`. */
function coverArgs(
  covers: StreamPlan[],
  first: number,
  files: RenderInput['coverFiles'],
): string[] {
  return covers.flatMap((s, n) => {
    const path = files?.get(s.sourceIndex);
    if (path === undefined) {
      throw new RenderError(`cover video #${s.sourceIndex} needs its extracted image file`);
    }
    if (!isAbsolute(path)) throw new RenderError(`cover path is not absolute: ${path}`);
    const { ext, mimetype } = coverFile(s.codec);
    const i = first + n;
    const name = n === 0 ? `cover.${ext}` : `cover-${s.sourceIndex}.${ext}`;
    return [
      '-attach',
      path,
      `-metadata:s:${i}`,
      `mimetype=${mimetype}`,
      `-metadata:s:${i}`,
      `filename=${name}`,
    ];
  });
}

/** Per QSV-encoded stream, the `vpp_qsv` format that replaces its `-pix_fmt`. */
type QsvFrames = Map<StreamPlan, 'nv12' | 'p010'>;

/**
 * When the source can decode on the Intel GPU and stay there: a QSV device, no device or hwaccel
 * of the model's own, and every converted video stream encoded with QSV from the source at a known
 * 8- or 10-bit 4:2:0 format. GPU frames reach no CPU filter, so the format conversion is
 * `vpp_qsv=format=nv12|p010` on the GPU. Null keeps the CPU decode (measured on an Arc A310: the CPU
 * decode starved a parallel NVENC job on a 4-core box). A source the GPU cannot decode (4:2:2, say)
 * fails as a GPU failure, which tries another GPU, then software.
 */
function qsvFrames(
  model: BuildModel,
  streams: StreamPlan[],
  device?: RenderDevice,
): QsvFrames | null {
  if (device?.kind !== 'qsv') return null;
  const own = [...model.globalArgs, ...model.inputArgs];
  if (own.includes('-hwaccel') || own.includes('-init_hw_device')) return null;
  const videos = streams.filter((s) => s.type === 'video' && s.mode === 'convert');
  const frames: QsvFrames = new Map();
  for (const s of videos) {
    if (!s.encoder?.endsWith('_qsv') || (s.input ?? 0) !== 0 || s.pixelFormat === null) return null;
    const depth = yuv420Depth(s.pixelFormat);
    if (depth !== 8 && depth !== 10) return null;
    frames.set(s, depth === 8 ? 'nv12' : 'p010');
  }
  return frames.size > 0 ? frames : null;
}

/**
 * `-hwaccel cuda` for the source when a video stream is encoded with NVENC, so the GPU decodes it
 * as well as encoding it (on a 4-core box the CPU decode, not NVENC, set the pace). Frames come back
 * to system memory, so pixel formats and filters work as before, and ffmpeg decodes on the CPU
 * where the GPU has no decoder for the codec. A model that already picks a `-hwaccel` keeps its own.
 * With a device, the decode runs on the GPU that encodes (`-hwaccel_device`).
 * A QSV device with a QSV encode opens that Intel GPU for the encoders instead. With `frames`
 * (see `qsvFrames`) the source also decodes on it into GPU frames (`-hwaccel_output_format qsv`;
 * ffmpeg decodes on the CPU where the GPU cannot); otherwise it decodes on the CPU. A model that
 * opens its own device keeps it.
 */
function gpuDeviceArgs(
  model: BuildModel,
  streams: StreamPlan[],
  device: RenderDevice | undefined,
  frames: QsvFrames | null,
): string[] {
  const own = [...model.globalArgs, ...model.inputArgs];
  const encodes = (suffix: string) =>
    streams.some((s) => s.type === 'video' && s.mode === 'convert' && s.encoder?.endsWith(suffix));
  if (device?.kind === 'qsv' && encodes('_qsv') && !own.includes('-init_hw_device')) {
    return [
      '-init_hw_device',
      `qsv=qsv:hw,child_device=${device.renderNode}`,
      '-filter_hw_device',
      'qsv',
      ...(frames ? ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'] : []),
    ];
  }
  if (own.includes('-hwaccel')) return [];
  if (!encodes('_nvenc')) return [];
  const index = device?.kind === 'cuda' ? ['-hwaccel_device', String(device.index)] : [];
  return ['-hwaccel', 'cuda', ...index];
}

/** ffmpeg global/input options that take no value; a token after one cannot be its value. */
const BOOLEAN_FLAGS = new Set([
  '-y',
  '-n',
  '-re',
  '-stdin',
  '-nostdin',
  '-hide_banner',
  '-stats',
  '-nostats',
  '-benchmark',
  '-benchmark_all',
  '-dump',
  '-hex',
  '-xerror',
  '-ignore_unknown',
  '-copy_unknown',
  '-copyts',
  '-start_at_zero',
  '-debug_ts',
  '-accurate_seek',
  '-noaccurate_seek',
  '-autorotate',
  '-noautorotate',
  '-vn',
  '-an',
  '-sn',
  '-dn',
]);

/**
 * Model `globalArgs`/`inputArgs` hold options and their values only: each token is an option
 * (`-name`) or the single value right after an option that takes one (any option not in
 * BOOLEAN_FLAGS). A positional token would become an extra input or output, and `-i` would add
 * an input.
 */
function checkOptionArgs(field: string, args: string[]): void {
  let valueAllowed = false;
  for (const a of args) {
    if (a === '-i') throw new RenderError(`${field} must not add an input (-i)`);
    if (a.startsWith('-') && a.length > 1) valueAllowed = !BOOLEAN_FLAGS.has(a);
    else if (valueAllowed) valueAllowed = false;
    else throw new RenderError(`${field} has a stray argument ${JSON.stringify(a)}`);
  }
}

/**
 * The ffmpeg argv (after the binary) that writes `model` from `input` to `output`. Throws a
 * RenderError for relative paths, a NUL byte in any argument, malformed model args, or a profile
 * that does not fit the encoder or pixel format.
 */
export function renderArgs(r: RenderInput): string[] {
  const { model } = r;
  if (!isAbsolute(r.input)) throw new RenderError(`input path is not absolute: ${r.input}`);
  if (!isAbsolute(r.output)) throw new RenderError(`output path is not absolute: ${r.output}`);
  checkOptionArgs('globalArgs', model.globalArgs);
  checkOptionArgs('inputArgs', model.inputArgs);
  const all = kept(model);
  for (const s of all) {
    if (!containerCanHold(model.container, s)) {
      throw new RenderError(
        `${model.container} can't hold ${s.type} #${s.sourceIndex} (${s.codec}); drop it from the model`,
      );
    }
  }
  const extras = model.extraInputs ?? [];
  extras.forEach((e, n) => {
    if (e.kind !== 'subtitle') {
      throw new RenderError(`extra input ${n + 1} has an unsupported kind: ${String(e.kind)}`);
    }
    if (!isAbsolute(e.path)) throw new RenderError(`extra input path is not absolute: ${e.path}`);
    if (!Object.hasOwn(SIDECAR_DEMUXERS, e.codec)) {
      throw new RenderError(`extra input ${n + 1} has an unsupported subtitle codec: ${e.codec}`);
    }
    const copy = r.extraInputFiles?.get(n + 1);
    if (copy === undefined) throw new RenderError(`extra input ${n + 1} needs its copied file`);
    if (!isAbsolute(copy)) throw new RenderError(`extra input copy is not absolute: ${copy}`);
  });
  for (const s of all) {
    if (isExtraStream(s) && extras[(s.input as number) - 1] === undefined) {
      throw new RenderError(
        `stream #${s.sourceIndex} reads extra input ${s.input}, which the model does not list`,
      );
    }
  }
  // Covers in mkv become attachments after every mapped stream (see outputOrder).
  const streams = all.filter((s) => !isMkvCover(model, s));
  const covers = all.filter((s) => isMkvCover(model, s));
  const frames = qsvFrames(model, streams, r.device);
  const args = [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-nostats',
    '-progress',
    'pipe:1',
    ...model.globalArgs,
    ...model.inputArgs,
    ...gpuDeviceArgs(model, streams, r.device, frames),
    '-i',
    r.input,
    // Every extra input is listed, used or not, so input numbers match `StreamPlan.input`.
    // Each is read from its private copy, with the demuxer named so the extension cannot decide.
    ...extras.flatMap((e, n) => [
      '-f',
      SIDECAR_DEMUXERS[e.codec] as string,
      '-i',
      r.extraInputFiles?.get(n + 1) as string,
    ]),
    '-map_metadata',
    '0',
    '-map_chapters',
    '0',
    // An extra stream is stream 0 of its own input.
    ...streams.flatMap((s) => ['-map', isExtraStream(s) ? `${s.input}:0` : `0:${s.sourceIndex}`]),
    ...streams.flatMap((s, i) => [
      ...codecArgs(s, i, r.device, frames?.get(s)),
      ...metadataArgs(s, i),
    ]),
    ...coverArgs(covers, streams.length, r.coverFiles),
    '-f',
    model.container === 'mp4' ? 'mp4' : 'matroska',
    r.output,
  ];
  // An argv string cannot carry NUL; spawn would fail late with an unclear error.
  const bad = args.find((a) => a.includes('\0'));
  if (bad !== undefined)
    throw new RenderError(`argument contains a NUL byte: ${JSON.stringify(bad)}`);
  return args;
}

const SAFE_ARG = /^[A-Za-z0-9_\-+=:,./@%]+$/;

/** A copy-pasteable POSIX shell command line for display and storage. */
export function renderCommandLine(ffmpegPath: string, args: string[]): string {
  return [ffmpegPath, ...args]
    .map((a) => (SAFE_ARG.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`))
    .join(' ');
}

export function outputExtension(container: 'mkv' | 'mp4'): '.mkv' | '.mp4' {
  return container === 'mp4' ? '.mp4' : '.mkv';
}
