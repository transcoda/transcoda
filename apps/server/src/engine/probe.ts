import type { ProbeResult } from '@transcoda/sdk';
import {
  type JsonValue,
  normalizeLanguage,
  normalizeProfile,
  type ProbeStream,
  STREAM_TYPES,
} from '@transcoda/shared';
import { type Exec, makeExec } from '../capabilities/ffmpeg.ts';

/**
 * ffprobe gets more room than the capability probe: a file on a sleeping disk or a network share
 * can take a while to open, and a file with many streams and chapters prints a lot of JSON.
 */
const probeExec: Exec = makeExec({ timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

/** ffprobe `format_name` → our container name; anything else maps to its first token. */
const CONTAINERS: ReadonlyMap<string, string> = new Map([
  ['matroska,webm', 'mkv'],
  ['mov,mp4,m4a,3gp,3g2,mj2', 'mp4'],
  ['mpegts', 'ts'],
  ['avi', 'avi'],
  ['asf', 'wmv'],
  ['flv', 'flv'],
  ['webm', 'webm'],
]);

/** Disposition flags with their own field on ProbeStream; every other flag set to 1 is listed. */
const OWN_FIELD_DISPOSITIONS = new Set(['default', 'forced', 'attached_pic']);

type Obj = Record<string, unknown>;

function fail(): never {
  throw new Error('unrecognised ffprobe output');
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ffprobe prints most numbers as strings; returns a finite number or null. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

function positiveInt(v: unknown): number | null {
  const n = int(v);
  return n !== null && n > 0 ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function kbps(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n / 1000;
}

/**
 * mkv streams rarely carry `bit_rate`; mkvmerge writes the measured rate as a `BPS` statistics tag
 * (older versions as `BPS-<language>`).
 */
function statisticsKbps(tags: Record<string, string> | undefined): number | null {
  const key = Object.keys(tags ?? {}).find((k) => k === 'BPS' || k.startsWith('BPS-'));
  return key === undefined ? null : kbps(tags?.[key]);
}

/** `24000/1001` → 23.976…; `0/0` and missing → null. */
function fraction(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const [a, b] = v.split('/').map(Number);
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a <= 0 || b <= 0) return null;
  return a / b;
}

function stringTags(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined;
  const tags: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) if (typeof value === 'string') tags[k] = value;
  return tags;
}

/** The stream's language tag as ISO 639-2/T: 'und' and missing → null; 'ger' → 'deu'. */
export function languageOf(tags: Record<string, string> | undefined): string | null {
  return normalizeLanguage(tags?.language);
}

function streamType(v: unknown): ProbeStream['type'] {
  // ffprobe prints `unknown` for a media type it cannot name; treat it (and anything new) as data.
  return (STREAM_TYPES as readonly unknown[]).includes(v) ? (v as ProbeStream['type']) : 'data';
}

/** 8 for `yuv420p`, 10 for `yuv420p10le` / `p010le`; null when the format is unknown. */
function bitDepthOfPixFmt(pixFmt: string | null): number | null {
  if (pixFmt === null) return null;
  const m = /p0?(\d+)(le|be)$/.exec(pixFmt);
  if (m?.[1]) return Number(m[1]);
  return /^(yuvj?\d{3}p|nv12|nv21|gray|rgb24|bgr24|rgba|bgra|argb|abgr|gbrp)$/.test(pixFmt)
    ? 8
    : null;
}

function hdrOf(s: Obj): ProbeStream['hdr'] {
  const sideData = Array.isArray(s.side_data_list) ? s.side_data_list : [];
  if (sideData.some((d) => isObj(d) && d.side_data_type === 'DOVI configuration record')) {
    return 'dolby-vision';
  }
  if (s.color_transfer === 'smpte2084') return 'hdr10';
  if (s.color_transfer === 'arib-std-b67') return 'hlg';
  return 'none';
}

/** File extensions of image formats, for a stream's `FILENAME` tag. */
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'png',
  'gif',
  'bmp',
  'webp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'heif',
  'jxl',
]);

/** The tag `name`, whatever its case (Matroska writes `MIMETYPE`, other muxers `mimetype`). */
function tagOf(tags: Record<string, string> | undefined, name: string): string | undefined {
  const key = Object.keys(tags ?? {}).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : tags?.[key];
}

/**
 * The video stream's tags say it is an image file: a `MIMETYPE` of `image/…` or a `FILENAME` with
 * an image extension. An attachment (`cover.jpg`) that an earlier ffmpeg pass mapped as a video
 * track keeps these tags, whatever codec it was re-encoded to.
 */
export function hasImageTags(tags: Record<string, string> | undefined): boolean {
  const mime = tagOf(tags, 'mimetype')?.trim().toLowerCase();
  if (mime?.startsWith('image/')) return true;
  const ext = /\.([A-Za-z0-9]+)$/.exec(tagOf(tags, 'filename')?.trim() ?? '')?.[1];
  return ext !== undefined && IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Marks video tracks that hold one picture (see ProbeStream.imageTrack): image tags (parseStream;
 * not when `nb_frames` counts more than one frame), or a frame
 * count of exactly 1 from the container's index (`nb_frames`) while another video stream is not a
 * picture and has more frames (or an unknown count). Only `nb_frames` counts: durations are not
 * used, since ffprobe reports a Matroska track's duration as the file's (a 1 ms cover track
 * reads as the whole film) and `DURATION`/`NUMBER_OF_FRAMES` tags may be copied from an older
 * file. A file whose only video has one frame keeps it as video.
 */
function markImageTracks(streams: ProbeStream[], raw: unknown[]): void {
  const frames = new Map<number, number | null>();
  for (const r of raw) {
    if (isObj(r) && int(r.index) !== null) frames.set(int(r.index) as number, int(r.nb_frames));
  }
  const singleFrame = streams.filter(
    (s) => s.type === 'video' && !s.attachedPic && !s.imageTrack && frames.get(s.index) === 1,
  );
  if (singleFrame.length === 0) return;
  const motion = streams.some(
    (o) =>
      o.type === 'video' && !o.attachedPic && !o.imageTrack && (frames.get(o.index) ?? null) !== 1,
  );
  if (motion) for (const s of singleFrame) s.imageTrack = true;
}

function parseStream(s: unknown): ProbeStream {
  if (!isObj(s)) fail();
  const index = int(s.index);
  if (index === null) fail();
  const type = streamType(s.codec_type);
  const tags = stringTags(s.tags);
  const disposition = isObj(s.disposition) ? s.disposition : {};
  const flag = (key: string) => disposition[key] === 1;
  const pixelFormat = str(s.pix_fmt);
  const attachedPic = type === 'video' && flag('attached_pic');
  return {
    index,
    type,
    codec: str(s.codec_name) ?? 'unknown',
    language: languageOf(tags),
    title: tags?.title || null,
    default: flag('default'),
    forced: flag('forced'),
    attachedPic,
    // Image tags mark a track, unless the container counts more than one frame (an animated GIF,
    // WebP or APNG is motion and is encoded like video).
    ...(type === 'video' && !attachedPic && hasImageTags(tags) && !((int(s.nb_frames) ?? 0) > 1)
      ? { imageTrack: true }
      : {}),
    dispositions: Object.keys(disposition).filter(
      (k) => !OWN_FIELD_DISPOSITIONS.has(k) && disposition[k] === 1,
    ),
    width: positiveInt(s.width),
    height: positiveInt(s.height),
    profile: normalizeProfile(str(s.profile)),
    // ffprobe reports -99 for an unknown level.
    level: positiveInt(s.level),
    pixelFormat,
    bitDepth:
      positiveInt(s.bits_per_raw_sample) ??
      (type === 'video' ? bitDepthOfPixFmt(pixelFormat) : null),
    hdr: type === 'video' ? hdrOf(s) : null,
    channels: positiveInt(s.channels),
    sampleRate: positiveInt(s.sample_rate),
    bitrateKbps: kbps(s.bit_rate) ?? statisticsKbps(tags),
    frameRate: fraction(s.avg_frame_rate),
  };
}

/** Maps `ffprobe -show_format -show_streams -show_chapters -of json` output to a ProbeResult. */
export function parseProbe(json: unknown): ProbeResult {
  if (!isObj(json) || !isObj(json.format) || !Array.isArray(json.streams)) fail();
  const format = json.format;
  const formatName = str(format.format_name);
  if (formatName === null) fail();
  const streams = json.streams.map(parseStream);
  markImageTracks(streams, json.streams);
  return {
    container: CONTAINERS.get(formatName) ?? formatName.split(',')[0] ?? formatName,
    formatName,
    durationSeconds: num(format.duration) ?? 0,
    sizeBytes: int(format.size) ?? 0,
    bitrateKbps: kbps(format.bit_rate),
    streams,
    chapters: Array.isArray(json.chapters) ? json.chapters.length : 0,
    raw: json as JsonValue,
  };
}

/** A probe as the job page gets it: no raw JSON; each stream with its statistics tag bitrate. */
export type JobProbe = Omit<ProbeResult, 'raw' | 'streams'> & {
  streams: (ProbeStream & { tagBitrateKbps: number | null })[];
};

/** The tag `name` or its language-suffixed form (`BPS-eng`, older mkvmerge). */
function statTag(tags: Record<string, string> | undefined, name: string): string | undefined {
  if (!tags) return undefined;
  const key = Object.keys(tags).find((k) => k === name || k.startsWith(`${name}-`));
  return key === undefined ? undefined : tags[key];
}

/**
 * A stream's Matroska statistics bitrate in kb/s: the `BPS` tag, else `NUMBER_OF_BYTES` over the
 * `DURATION` tag; null without them. Unchecked: a muxer that copies stream tags (ffmpeg does) keeps
 * the statistics of an older file, so the screens decide whether to trust it.
 */
function tagBitrateKbps(raw: unknown): number | null {
  const tags = isObj(raw) ? stringTags(raw.tags) : undefined;
  const bps = num(statTag(tags, 'BPS'));
  if (bps !== null && bps > 0) return bps / 1000;
  const bytes = num(statTag(tags, 'NUMBER_OF_BYTES'));
  const duration = tagSeconds(statTag(tags, 'DURATION'));
  return bytes !== null && bytes > 0 && duration !== null && duration > 0
    ? (bytes * 8) / duration / 1000
    : null;
}

/** Matroska's `HH:MM:SS.fffffffff` duration tag in seconds; null when absent or unreadable. */
function tagSeconds(v: string | undefined): number | null {
  const m = v === undefined ? null : /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** The job page's view of a stored probe (the job's source, or the output verify read). */
export function jobProbeOf(probe: ProbeResult): JobProbe {
  const { raw, ...summary } = probe;
  const rawStreams = isObj(raw) && Array.isArray(raw.streams) ? raw.streams : [];
  return {
    ...summary,
    streams: probe.streams.map((s) => ({
      ...s,
      tagBitrateKbps: tagBitrateKbps(rawStreams.find((r) => isObj(r) && int(r.index) === s.index)),
    })),
  };
}

/**
 * Why a probe failed, in one short line for a job's reason: ffprobe's last error line, without
 * node's "Command failed: <command line>", the file's path or the `[demuxer @ 0x…]` prefix; a
 * timeout or a missing ffprobe in plain words. The whole error belongs in the server log.
 */
export function probeFailure(err: unknown, path: string): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    message?: unknown;
    stderr?: unknown;
    code?: unknown;
    killed?: unknown;
  };
  if (e.killed === true) return 'ffprobe took too long and was stopped';
  if (e.code === 'ENOENT') return 'ffprobe was not found';
  const raw = typeof e.message === 'string' ? e.message : String(err);
  const stderr =
    typeof e.stderr === 'string' && e.stderr.trim() !== ''
      ? e.stderr
      : raw.startsWith('Command failed:')
        ? raw.split('\n').slice(1).join('\n')
        : raw;
  const lines = stderr
    .split('\n')
    .map((l) =>
      l
        .replaceAll(`${path}: `, '')
        .replaceAll(path, 'the file')
        .replace(/^\[[^\]]* @ 0x[0-9a-f]+\]\s*/i, '')
        .trim(),
    )
    .filter((l) => l !== '');
  const last = lines.at(-1) ?? 'ffprobe failed';
  return last.length > 200 ? `${last.slice(0, 199)}…` : last;
}

export async function probeFile(
  path: string,
  opts: { ffprobePath: string; exec?: Exec; signal?: AbortSignal },
): Promise<ProbeResult> {
  const exec = opts.exec ?? probeExec;
  const { stdout } = await exec(
    opts.ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', path],
    opts.signal ? { signal: opts.signal } : undefined,
  );
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    fail();
  }
  return parseProbe(json);
}
