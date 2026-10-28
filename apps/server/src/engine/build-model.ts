// The per-stream build model: the identity model of a probed file, identity checks, a readable
// diff against the probe, and encoder resolution.
import type { BuildModel, ExtraInput, ProbeResult, StreamPlan } from '@transcoda/sdk';
import { isPicture, type ProbeStream } from '@transcoda/shared';

/**
 * The model that rewrites nothing: every stream kept in copy mode, in probe order, with its
 * metadata and dispositions. Only mkv and mp4 are written; any other container maps to mkv, so a
 * ts/avi/mov/… input is never an identity model (a remux is a real change).
 */
export function modelFromProbe(probe: ProbeResult): BuildModel {
  const model: BuildModel = {
    container: probe.container === 'mp4' ? 'mp4' : 'mkv',
    streams: probe.streams.map((s, order) => ({
      sourceIndex: s.index,
      type: s.type,
      keep: true,
      mode: 'copy',
      codec: s.codec,
      encoder: null,
      quality: null,
      preset: null,
      bitrateKbps: null,
      channels: null,
      profile: null,
      pixelFormat: null,
      language: s.language,
      title: s.title,
      default: s.default,
      forced: s.forced,
      attachedPic: s.attachedPic,
      dispositions: [...s.dispositions],
      order,
    })),
    targets: [],
    inputArgs: [],
    globalArgs: [],
  };
  // mkv and mp4 inputs always fit; a ts/avi/mov input written as mkv may carry streams that do not.
  if (probe.container !== model.container) fitToContainer(model);
  return model;
}

/** The stream comes from an extra input file (a sidecar), not from the source. */
export function isExtraStream(s: StreamPlan): boolean {
  return (s.input ?? 0) > 0;
}

/** The extra input file an extra stream reads from; null for a source stream or a missing entry. */
export function extraInputOf(model: BuildModel, s: StreamPlan): ExtraInput | null {
  return isExtraStream(s) ? (model.extraInputs?.[(s.input as number) - 1] ?? null) : null;
}

/** Text subtitle codecs ffmpeg converts to `mov_text` (mp4) or `subrip` (mkv). */
export const TEXT_SUBTITLES: ReadonlySet<string> = new Set([
  'subrip',
  'ass',
  'ssa',
  'webvtt',
  'text',
  'mov_text',
]);

/**
 * Whether the container's muxer accepts the stream as planned (checked against ffmpeg 9.0.2):
 * matroska takes no data streams (tmcd) and no mov_text; mp4 takes no attachments (fonts) and no
 * subtitles other than mov_text (PGS, VobSub, subrip, ass).
 */
export function containerCanHold(
  container: BuildModel['container'],
  s: { type: StreamPlan['type']; codec: string },
): boolean {
  if (container === 'mkv') {
    return s.type !== 'data' && !(s.type === 'subtitle' && s.codec === 'mov_text');
  }
  return s.type !== 'attachment' && (s.type !== 'subtitle' || s.codec === 'mov_text');
}

/**
 * Makes the kept streams fit the model's container, in place: text subtitles convert to the
 * container's text format; anything else the container cannot hold is dropped (the diff says
 * `container can't hold it`), so a muxer never refuses the output.
 */
export function fitToContainer(model: BuildModel): {
  converted: StreamPlan[];
  dropped: StreamPlan[];
} {
  const textCodec = model.container === 'mp4' ? 'mov_text' : 'subrip';
  const converted: StreamPlan[] = [];
  const dropped: StreamPlan[] = [];
  for (const s of kept(model)) {
    if (containerCanHold(model.container, s)) continue;
    if (s.type === 'subtitle' && TEXT_SUBTITLES.has(s.codec)) {
      Object.assign(s, { mode: 'convert', codec: textCodec, encoder: null });
      converted.push(s);
    } else {
      s.keep = false;
      dropped.push(s);
    }
  }
  return { converted, dropped };
}

/**
 * Puts every kept picture (isPicture: a cover, a poster, an image stored as a video track) that a
 * node set to convert back to copy, in place, and returns a plan note per stream it changed. An
 * encoder holds a picture's single frame until the input ends, and the muxer then keeps every
 * packet of the other streams in memory and writes nothing (a 12 hour job grew to gigabytes
 * with an empty output), so a picture is never encoded, whatever a node or plugin asked for.
 */
export function copyPictures(model: BuildModel, probe: ProbeResult): Map<StreamPlan, string> {
  const notes = new Map<StreamPlan, string>();
  for (const s of kept(model)) {
    if (s.type !== 'video' || s.mode !== 'convert' || isExtraStream(s)) continue;
    const src = probe.streams.find((p) => p.index === s.sourceIndex);
    if (!src || !isPicture(src, probe.streams)) continue;
    Object.assign(s, {
      mode: 'copy',
      codec: src.codec,
      encoder: null,
      quality: null,
      preset: null,
      bitrateKbps: null,
      channels: null,
      profile: null,
      pixelFormat: null,
    });
    notes.set(s, 'a picture, copied: pictures are never encoded');
  }
  return notes;
}

const COVER_FILES: Record<string, { ext: string; mimetype: string }> = {
  png: { ext: 'png', mimetype: 'image/png' },
  mjpeg: { ext: 'jpg', mimetype: 'image/jpeg' },
  bmp: { ext: 'bmp', mimetype: 'image/bmp' },
  gif: { ext: 'gif', mimetype: 'image/gif' },
  webp: { ext: 'webp', mimetype: 'image/webp' },
};

/** The attachment file extension and mimetype for a cover's image codec. */
export function coverFile(codec: string): { ext: string; mimetype: string } {
  return Object.hasOwn(COVER_FILES, codec)
    ? (COVER_FILES[codec] as { ext: string; mimetype: string })
    : { ext: codec, mimetype: `image/${codec}` };
}

/**
 * True for a kept cover that an mkv output carries as an attachment (`cover.<ext>`): ffmpeg
 * writes an attached_pic stream into matroska as a plain one-frame video track otherwise.
 */
export function isMkvCover(model: BuildModel, s: StreamPlan): boolean {
  return model.container === 'mkv' && s.type === 'video' && s.attachedPic;
}

/**
 * Kept streams in the order the output file has them: `kept` order, except that mkv covers come
 * last (attachments follow every mapped stream). Verify compares the output against this order.
 */
export function outputOrder(model: BuildModel): StreamPlan[] {
  const out = kept(model);
  return [...out.filter((s) => !isMkvCover(model, s)), ...out.filter((s) => isMkvCover(model, s))];
}

/** Kept streams in output order (ties by source index); the order renderArgs maps them in. */
export function kept(model: BuildModel): StreamPlan[] {
  return model.streams
    .filter((s) => s.keep)
    .sort((a, b) => a.order - b.order || a.sourceIndex - b.sourceIndex);
}

export function streamsOf(model: BuildModel, type: StreamPlan['type']): StreamPlan[] {
  return kept(model).filter((s) => s.type === type);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/**
 * For each kept non-data stream whose position among the kept non-data streams differs from its
 * rank in source order, the output index it is written at. Data streams never count as moved and
 * never make another stream count as moved (isIdentity ignores them too).
 */
function moves(model: BuildModel): Map<number, number> {
  const out = outputOrder(model);
  // An mkv cover is always written last, as an attachment; that is not a move.
  // Streams from extra inputs have no source rank; they are additions, never moves.
  const media = out.filter((s) => s.type !== 'data' && !isMkvCover(model, s) && !isExtraStream(s));
  const bySource = [...media].sort((a, b) => a.sourceIndex - b.sourceIndex);
  const moved = new Map<number, number>();
  media.forEach((s, rank) => {
    if (bySource[rank] !== s) moved.set(s.sourceIndex, out.indexOf(s));
  });
  return moved;
}

/**
 * True when writing the model would reproduce the file: same container, every probe stream kept,
 * every non-data stream in copy mode, in the same relative order, with unchanged language, title,
 * flags and dispositions, and no kept stream that the probe does not have. An explicit drop of a
 * data stream is a change; a data stream's mode and position are not (it is always copied).
 */
export function isIdentity(model: BuildModel, probe: ProbeResult): boolean {
  if (model.container !== probe.container) return false;
  const plans = new Map(model.streams.map((s) => [s.sourceIndex, s]));
  for (const p of probe.streams) {
    const s = plans.get(p.index);
    if (!s?.keep) return false;
    // A kept data stream is always copied as it is; only dropping one changes the file.
    if (p.type === 'data') continue;
    if (s.mode !== 'copy' || metadataChanges(s, p).length > 0) return false;
  }
  const known = new Set(probe.streams.map((p) => p.index));
  if (kept(model).some((s) => !known.has(s.sourceIndex))) return false;
  const order = kept(model)
    .filter((s) => s.type !== 'data')
    .map((s) => s.sourceIndex);
  return order.every((index, i) => i === 0 || (order[i - 1] ?? -1) < index);
}

function lang(language: string | null): string {
  return language ?? 'und';
}

/** Language, title, flag and disposition changes of a kept stream, as diff fragments. */
function metadataChanges(s: StreamPlan, p: ProbeStream): string[] {
  const changes: string[] = [];
  if (s.language !== p.language) changes.push(`language ${lang(p.language)}→${lang(s.language)}`);
  if (s.title !== p.title) changes.push(s.title === null ? 'title cleared' : `title "${s.title}"`);
  const flag = (name: string, now: boolean, before: boolean) => {
    if (now !== before) changes.push(now ? name : `not ${name}`);
  };
  flag('default', s.default, p.default);
  flag('forced', s.forced, p.forced);
  flag('attached_pic', s.attachedPic, p.attachedPic);
  if (!sameSet(s.dispositions, p.dispositions)) {
    for (const d of s.dispositions) if (!p.dispositions.includes(d)) changes.push(`+${d}`);
    for (const d of p.dispositions) if (!s.dispositions.includes(d)) changes.push(`-${d}`);
  }
  return changes;
}

/**
 * `libx265 crf 24 medium main10 yuv420p10le`, `aac 160k 2ch`, `mov_text`. The job page reads this
 * back (`parseConversion` in packages/shared/src/engine/conversion.ts, used by the web's
 * jobs/compareJob.ts): change the format there too (build-model.test.ts round-trips it).
 */
export function conversion(s: StreamPlan): string {
  const parts = [s.encoder ?? s.codec];
  // A video quality with a bitrate is capped quality: the bitrate is a ceiling, not a target.
  const capped = s.type === 'video' && s.quality !== null && s.bitrateKbps !== null;
  if (s.quality !== null) parts.push(`${qualityName(s.encoder, capped)} ${s.quality}`);
  if (s.preset !== null) parts.push(s.preset);
  if (s.profile !== null) parts.push(s.profile);
  if (s.bitrateKbps !== null) parts.push(`${capped ? 'max ' : ''}${s.bitrateKbps}k`);
  if (s.channels !== null) parts.push(`${s.channels}ch`);
  if (s.pixelFormat !== null) parts.push(s.pixelFormat);
  return parts.join(' ');
}

/**
 * The quality option's name in diffs and reasons. Capped (render's quality with a bitrate), NVENC
 * encodes VBR with a constant-quality target (cq) and VAAPI asks for QVBR (a quality level, q).
 */
export function qualityName(encoder: string | null, capped = false): string {
  if (encoder === null) return 'q';
  if (encoder.endsWith('_nvenc')) return capped ? 'cq' : 'qp';
  if (encoder.endsWith('_vaapi')) return capped ? 'q' : 'qp';
  if (encoder.endsWith('_qsv')) return 'q';
  return 'crf';
}

/**
 * Human-readable changes from the probe to the model: the container change first, then each
 * dropped stream (source order, data streams included), then one line per changed kept non-data
 * stream in output order. Streams are named `<type> #<probe index>`. Data streams are always
 * copied, so beyond a drop they have nothing to report.
 */
export function diffFromProbe(model: BuildModel, probe: ProbeResult): string[] {
  const lines: string[] = [];
  if (model.container !== probe.container) {
    lines.push(`container: ${probe.container} → ${model.container}`);
  }
  const plans = new Map(model.streams.map((s) => [s.sourceIndex, s]));
  for (const p of probe.streams) {
    const s = plans.get(p.index);
    if (!s?.keep) {
      // A node's own reason for the drop stands in for the language.
      const why = s?.dropReason ?? p.language;
      const notes = [
        ...(why ? [why] : []),
        ...(containerCanHold(model.container, p) ? [] : ["container can't hold it"]),
      ];
      lines.push(`drop ${p.type} #${p.index}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
    }
  }
  const probes = new Map(probe.streams.map((p) => [p.index, p]));
  const moved = moves(model);
  for (const s of kept(model)) {
    const p = isExtraStream(s) ? undefined : probes.get(s.sourceIndex);
    if (!p || p.type === 'data') continue;
    const changes: string[] = [];
    if (s.mode === 'convert') changes.push(`convert ${p.codec}→${s.codec} (${conversion(s)})`);
    const to = moved.get(s.sourceIndex);
    if (to !== undefined) changes.push(`moved to output #${to}`);
    if (isMkvCover(model, s) && probe.container !== 'mkv') {
      changes.push(`written as attachment cover.${coverFile(s.codec).ext}`);
    }
    changes.push(...metadataChanges(s, p));
    if (changes.length > 0) lines.push(`${p.type} #${p.index}: ${changes.join(', ')}`);
  }
  lines.push(...sidecarLines(model));
  return lines;
}

/**
 * One line per stream from an extra input, in input order: `add subtitle from <file> (<language|und>[,
 * forced][, sdh][, convert <from>→<to>])`, or `drop subtitle from <file>` (with `(container can't
 * hold it)` when the container is why).
 */
function sidecarLines(model: BuildModel): string[] {
  const extras = model.streams
    .filter(isExtraStream)
    .sort((a, b) => (a.input ?? 0) - (b.input ?? 0) || a.order - b.order);
  return extras.flatMap((s) => {
    const input = extraInputOf(model, s);
    if (!input) return [];
    const { file, language, forced, sdh } = input.label;
    if (!s.keep) {
      const why = containerCanHold(model.container, { type: s.type, codec: input.codec })
        ? ''
        : " (container can't hold it)";
      return [`drop ${s.type} from ${file}${why}`];
    }
    const notes = [lang(language)];
    if (forced) notes.push('forced');
    if (sdh) notes.push('sdh');
    if (s.mode === 'convert') {
      notes.push(`convert ${input.codec}→${s.codec}`);
    }
    return [`add ${s.type} from ${file} (${notes.join(', ')})`];
  });
}

/**
 * Makes the kept streams' default flags what the output file will have, in place, so verify can
 * compare them strictly (final review I1). Per type, in output order: the first flagged default
 * stays and the rest are cleared; with no default audio, the first kept audio becomes default; an
 * mp4 with subtitles and no default subtitle gets its first kept subtitle flagged (the mp4 muxer
 * flags it anyway); the same for video in an mp4 (its first non-cover video). Matroska writes the flags as given (`default_mode` passthrough). Only for a
 * model that is written: the identity check comes first, so an unchanged file stays as it is.
 * Returns a plan note per changed stream.
 */
export function normalizeDefaults(model: BuildModel): Map<StreamPlan, string> {
  const notes = new Map<StreamPlan, string>();
  // An mp4 muxer enables a video track that was told "not default", so verify would see a flag the
  // plan did not have: video is normalised like a subtitle there (covers are not video tracks).
  const types =
    model.container === 'mp4'
      ? (['video', 'audio', 'subtitle'] as const)
      : (['audio', 'subtitle'] as const);
  for (const type of types) {
    const streams = streamsOf(model, type).filter((s) => !s.attachedPic);
    const first = streams.find((s) => s.default);
    for (const s of streams) {
      if (s.default && s !== first) {
        s.default = false;
        notes.set(s, `only one default ${type} track`);
      }
    }
    const lead = streams[0];
    if (first !== undefined || lead === undefined) continue;
    if (type === 'audio') {
      lead.default = true;
      notes.set(lead, 'no audio track was default');
    } else if (model.container === 'mp4') {
      lead.default = true;
      notes.set(lead, `mp4 cannot have no default ${type}`);
    }
  }
  return notes;
}

/** Hardware encoders that also need an hwaccel listed by `ffmpeg -hwaccels`. */
const NEEDS_HWACCEL: Record<string, string> = { hevc_nvenc: 'cuda', h264_nvenc: 'cuda' };

const AUTO_ENCODERS: Record<'hevc' | 'h264' | 'av1', string[]> = {
  hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_vaapi', 'libx265'],
  h264: ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'libx264'],
  av1: ['libsvtav1', 'libaom-av1'],
};

/** ffmpeg has the encoder and, for NVENC, the CUDA hwaccel it needs. */
export function encoderUsable(
  encoder: string,
  caps: { encoders: readonly string[]; hwaccels: readonly string[] },
): boolean {
  const hwaccel = NEEDS_HWACCEL[encoder];
  return (
    caps.encoders.includes(encoder) && (hwaccel === undefined || caps.hwaccels.includes(hwaccel))
  );
}

/**
 * `auto` → the first available encoder in preference order (hardware first); a named encoder →
 * itself when ffmpeg has it. Null when nothing fits.
 */
export function resolveEncoder(
  codec: 'hevc' | 'h264' | 'av1',
  encoder: string,
  caps: { encoders: string[]; hwaccels: string[] },
): string | null {
  if (encoder !== 'auto') return caps.encoders.includes(encoder) ? encoder : null;
  return AUTO_ENCODERS[codec].find((e) => encoderUsable(e, caps)) ?? null;
}
