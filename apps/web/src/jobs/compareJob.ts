import type { JobDetail, JobProbe } from '@transcoda/contract';
import { type Conversion, isPicture, parseConversion } from '@transcoda/shared';
import { fmtBytes } from '../lib/bytes.ts';
import { fmtKbps } from '../lib/rate.ts';
import { languageNameOf } from './planText.ts';

// The job page's before/after comparison, pure over the job detail: why the output is smaller.
// Before is the job's own probe; After is the probe verify read of the output when there is one
// (test-encodes, real runs), else the plan (with the estimate on a plan-only dry run).

export type BeforeAfterJob = Pick<
  JobDetail,
  'state' | 'dryRun' | 'testEncode' | 'dependsOnSize' | 'probe' | 'outputProbe' | 'plan'
> & {
  result: Pick<
    NonNullable<JobDetail['result']>,
    'beforeBytes' | 'afterBytes' | 'estimatedBytes'
  > | null;
};

/** Something the output loses against the original: a word to show and why, for screen readers. */
export type Loss = { word: string; why: string };

/**
 * One side of a row: its values in order (each shown whole, never broken mid-value), or a tag for a
 * track that is `kept` as it was or `added`; `losses` are what this side loses (After only).
 */
export type Side = { items: string[]; tag: 'kept' | 'added' | null; losses: Loss[] };

export type CompareRow = { key: string; label: string; before: Side; after: Side };

/**
 * Where After comes from: `measured`, the verified output's probe; `not-kept`, the same for a real
 * run whose output was then thrown away (its size gate kept the original); `planned`, the plan and
 * the estimate of a plan-only dry run (nothing was encoded); `from-plan`, the plan with the measured
 * size of a job whose output probe was not kept (results from before it was stored).
 */
export type AfterSource = 'measured' | 'not-kept' | 'planned' | 'from-plan';

export type Comparison = { after: AfterSource; rows: CompareRow[] };

/** States a comparison is shown for: the output was written, measured, or planned. */
const COMPARED_STATES: ReadonlySet<JobDetail['state']> = new Set([
  'done',
  'kept_original',
  'dry_run',
]);

type Stream = JobProbe['streams'][number];
type Plan = NonNullable<JobDetail['plan']>;
type PlanStream = Plan['streams'][number];
type Kind = 'video' | 'audio' | 'subtitle';

const KINDS: readonly Kind[] = ['video', 'audio', 'subtitle'];

const UNKNOWN = '—';

const CODECS: Record<string, string> = {
  hevc: 'HEVC',
  h264: 'H.264',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  vc1: 'VC-1',
  truehd: 'TrueHD',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  aac: 'AAC',
  flac: 'FLAC',
  alac: 'ALAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  mp2: 'MP2',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
  subrip: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  mov_text: 'MP4 text',
};

/** ffmpeg encoders by the name a person knows them by; hardware ones by their suffix. */
const ENCODERS: Record<string, string> = {
  libx265: 'x265',
  libx264: 'x264',
  libsvtav1: 'SVT-AV1',
  'libaom-av1': 'libaom',
  librav1e: 'rav1e',
  'libvpx-vp9': 'libvpx',
};
const HW_ENCODERS: [suffix: string, name: string][] = [
  ['_nvenc', 'NVENC'],
  ['_qsv', 'QSV'],
  ['_vaapi', 'VAAPI'],
  ['_videotoolbox', 'VideoToolbox'],
  ['_amf', 'AMF'],
];

const PROFILES: Record<string, string> = {
  main: 'Main',
  main10: 'Main 10',
  high: 'High',
  high10: 'High 10',
  baseline: 'Baseline',
  'constrained-baseline': 'Baseline',
};

const RANGES: Record<NonNullable<Stream['hdr']>, string> = {
  none: 'SDR',
  hdr10: 'HDR10',
  hlg: 'HLG',
  'dolby-vision': 'Dolby Vision',
};

const LAYOUTS: Record<number, string> = { 1: 'mono', 2: '2.0', 3: '2.1', 6: '5.1', 8: '7.1' };

const layoutOf = (channels: number): string => LAYOUTS[channels] ?? `${channels} ch`;

/** TrueHD, FLAC, ALAC, PCM and DTS-HD MA keep every bit; anything else is lossy. */
function isLossless(codec: string, profile: string | null): boolean {
  if (['truehd', 'mlp', 'flac', 'alac', 'wavpack', 'tta', 'ape'].includes(codec)) return true;
  if (codec.startsWith('pcm_')) return true;
  return codec === 'dts' && profile !== null && profile.includes('dts-hd-ma');
}

function codecName(codec: string, profile: string | null): string {
  if (codec === 'dts' && profile?.includes('dts-hd-ma')) return 'DTS-HD MA';
  if (codec === 'dts' && profile?.includes('dts-hd-hra')) return 'DTS-HD HRA';
  if (codec.startsWith('pcm_')) return 'PCM';
  return CODECS[codec] ?? codec.toUpperCase();
}

/** "13.7 Mb/s", "640 kb/s"; "≈" in front of a derived one. */
function fmtRate(rate: Rate | null): string {
  if (rate === null) return UNKNOWN;
  const text = fmtKbps(rate.kbps);
  return rate.approx ? `≈${text}` : text;
}

/** "23.976 fps", "25 fps". */
const fmtFps = (fps: number): string => `${Number(fps.toFixed(3))} fps`;

type Rate = { kbps: number; approx: boolean };

/**
 * A stream's bitrate: ffprobe's own, else its Matroska statistics tag when `trustTags` and the tag
 * fits the file (bitrate × duration ≤ file size). A muxer that copies stream tags keeps an older
 * file's statistics (the example: 17.9 Mbit/s of video, 15 GB, in an 11.6 GB file), so a tag that
 * cannot fit is stale. Tags on an output are never trusted: ffmpeg writes no statistics, so any
 * there are the source's, copied.
 */
export function streamKbps(s: Stream, probe: JobProbe, trustTags: boolean): number | null {
  if (s.bitrateKbps !== null && s.bitrateKbps > 0) return s.bitrateKbps;
  const tag = s.tagBitrateKbps;
  if (!trustTags || tag === null || !(tag > 0) || !(probe.durationSeconds > 0)) return null;
  return ((tag * 1000) / 8) * probe.durationSeconds <= probe.sizeBytes ? tag : null;
}

/** The file's overall bitrate: ffprobe's, else size over duration. */
function fileKbps(sizeBytes: number, durationSeconds: number, kbps: number | null): number | null {
  if (kbps !== null && kbps > 0) return kbps;
  return durationSeconds > 0 ? (sizeBytes * 8) / durationSeconds / 1000 : null;
}

function encoderName(encoder: string | null): string | null {
  if (encoder === null) return null;
  const hw = HW_ENCODERS.find(([suffix]) => encoder.endsWith(suffix));
  return hw ? hw[1] : (ENCODERS[encoder] ?? null);
}

/** A track's facts, from a probe stream or from the plan; null is unknown. */
type Facts = {
  type: Kind;
  codec: string;
  profile: string | null;
  /** "NVENC QP 24": how a converted video track was encoded. */
  encoding: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitDepth: number | null;
  hdr: Stream['hdr'];
  channels: number | null;
  rate: Rate | null;
  lossless: boolean;
  language: string | null;
  forced: boolean;
};

function factsOf(s: Stream, kbps: number | null): Facts {
  return {
    type: s.type as Kind,
    codec: s.codec,
    profile: s.profile,
    encoding: null,
    width: s.width,
    height: s.height,
    frameRate: s.frameRate,
    bitDepth: s.bitDepth,
    hdr: s.hdr,
    channels: s.channels,
    rate: kbps === null ? null : { kbps, approx: false },
    lossless: isLossless(s.codec, s.profile),
    language: s.language,
    forced: s.forced,
  };
}

/** How the plan says a converted track is encoded ("NVENC QP 24"); null for a copy. */
function encodingOf(c: Conversion | null): string | null {
  if (!c) return null;
  const parts = [encoderName(c.encoder), c.quality].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The output track the plan describes: the encode's settings over the source's (a copy keeps them). */
function plannedFacts(p: PlanStream, src: Stream | null, srcKbps: number | null): Facts {
  const c = p.action === 'convert' ? parseConversion(p.note, p.type) : null;
  const converted = p.action === 'convert';
  const base = src ? factsOf(src, converted ? null : srcKbps) : null;
  return {
    type: p.type as Kind,
    codec: p.codec,
    profile: converted ? null : (base?.profile ?? null),
    encoding: p.type === 'video' ? encodingOf(c) : null,
    width: base?.width ?? null,
    height: base?.height ?? null,
    frameRate: base?.frameRate ?? null,
    bitDepth: c?.bitDepth ?? base?.bitDepth ?? null,
    hdr: converted ? null : (base?.hdr ?? null),
    channels: c?.channels ?? base?.channels ?? null,
    rate: c?.kbps ? { kbps: c.kbps, approx: false } : (base?.rate ?? null),
    lossless: isLossless(p.codec, converted ? null : (src?.profile ?? null)),
    language: p.language,
    forced: p.forced,
  };
}

/**
 * The verified output track, with what the plan says of its encode where the probe is silent; a
 * copied track without its own bitrate has its source's (`srcKbps`).
 */
function measuredFacts(
  s: Stream,
  kbps: number | null,
  p: PlanStream | null,
  srcKbps: number | null,
): Facts {
  const facts = factsOf(s, kbps ?? (p?.action === 'keep' ? srcKbps : null));
  const c = p?.action === 'convert' ? parseConversion(p.note, p.type) : null;
  if (s.type === 'video') facts.encoding = encodingOf(c);
  // An audio encode's target bitrate stands in for the one Matroska does not record.
  if (facts.rate === null && c?.kbps) facts.rate = { kbps: c.kbps, approx: false };
  return facts;
}

/**
 * The bitrate of the one video track nobody measured: the file's minus every audio track's, when
 * each of those is known and something is left (subtitles are too small to count). "≈" marks it.
 */
function deriveVideo(facts: Facts[], totalKbps: number | null): void {
  const videos = facts.filter((f) => f.type === 'video');
  const audio = facts.filter((f) => f.type === 'audio');
  const [video] = videos;
  if (!video || videos.length !== 1 || video.rate !== null || totalKbps === null) return;
  if (audio.some((a) => a.rate === null)) return;
  const rest = totalKbps - audio.reduce((sum, a) => sum + (a.rate?.kbps ?? 0), 0);
  if (rest > 0) video.rate = { kbps: rest, approx: true };
}

const bitsOf = (f: Facts, withRange: boolean): string | null => {
  const depth = f.bitDepth === null ? null : `${f.bitDepth}-bit`;
  const range = withRange && f.hdr !== null ? RANGES[f.hdr] : null;
  const both = [depth, range].filter(Boolean).join(' ');
  return both === '' ? null : both;
};

/** The values of a track, in order; `was` (After only) leaves out what did not change. */
function describe(f: Facts, was: Facts | null): string[] {
  const items: (string | null)[] = [];
  if (f.type === 'video') {
    const profile = f.profile ? (PROFILES[f.profile] ?? null) : null;
    const name = codecName(f.codec, f.profile);
    items.push(f.encoding ? `${name} (${f.encoding})` : profile ? `${name} ${profile}` : name);
    items.push(f.width && f.height ? `${f.width}×${f.height}` : null);
    const fpsChanged =
      !was || (f.frameRate !== null && fmtFps(f.frameRate) !== fmtFps(was.frameRate ?? 0));
    items.push(f.frameRate !== null && fpsChanged ? fmtFps(f.frameRate) : null);
    const rangeChanged = !was || (f.hdr !== null && f.hdr !== was.hdr);
    items.push(bitsOf(f, rangeChanged));
    items.push(fmtRate(f.rate));
  } else if (f.type === 'audio') {
    const name = codecName(f.codec, f.profile);
    items.push(f.channels ? `${name} ${layoutOf(f.channels)}` : name);
    items.push(f.lossless ? 'lossless' : fmtRate(f.rate));
    if (!was || f.language !== was.language)
      items.push(f.language ? languageNameOf(f.language) : null);
  } else {
    items.push(codecName(f.codec, null));
    if (!was || f.language !== was.language)
      items.push(f.language ? languageNameOf(f.language) : null);
    if (f.forced && !was?.forced) items.push('forced');
  }
  return items.filter((i): i is string => i !== null);
}

/** What the After track loses against the original (only where both sides are known). */
function lossesOf(was: Facts, now: Facts): Loss[] {
  const losses: Loss[] = [];
  if (now.type === 'video') {
    if (was.width && was.height && now.width && now.height) {
      if (now.width < was.width || now.height < was.height) {
        losses.push({
          word: 'downscaled',
          why: `lower resolution than the original (${was.width}×${was.height} → ${now.width}×${now.height})`,
        });
      }
    }
    if (was.bitDepth !== null && now.bitDepth !== null && now.bitDepth < was.bitDepth) {
      losses.push({
        word: 'lower bit depth',
        why: `${was.bitDepth}-bit in the original, ${now.bitDepth}-bit now`,
      });
    }
    if (was.hdr !== null && was.hdr !== 'none' && now.hdr === 'none') {
      losses.push({ word: 'HDR lost', why: `the original is ${RANGES[was.hdr]}, this is SDR` });
    } else if (was.hdr === 'dolby-vision' && (now.hdr === 'hdr10' || now.hdr === 'hlg')) {
      losses.push({
        word: 'Dolby Vision lost',
        why: `the original is Dolby Vision, this is ${RANGES[now.hdr]}`,
      });
    }
  }
  if (now.type === 'audio') {
    if (was.channels !== null && now.channels !== null && now.channels < was.channels) {
      losses.push({
        word: 'downmixed',
        why: `fewer channels than the original (${layoutOf(was.channels)} → ${layoutOf(now.channels)})`,
      });
    }
    if (was.lossless && !now.lossless) {
      losses.push({ word: 'lossy', why: 'the original is lossless, this is not' });
    }
  }
  return losses;
}

const side = (items: string[], losses: Loss[] = []): Side => ({ items, tag: null, losses });
const tagged = (tag: 'kept' | 'added'): Side => ({ items: [], tag, losses: [] });
const REMOVED: Loss = { word: 'removed', why: 'the output does not have this track' };

/**
 * The verified output's streams of each kind, in output order (pictures left out: covers, posters
 * and images stored as video tracks, see isPicture).
 */
function outputStreams(probe: JobProbe, kind: Kind): Stream[] {
  return probe.streams.filter((s) => s.type === kind && !isPicture(s, probe.streams));
}

/**
 * Which output stream each kept plan entry became: by the plan's output tracks (`sourceIndex`,
 * output order), else (plans stored before it) the n-th kept entry of a kind is the n-th output
 * stream of that kind.
 */
function pairOutputs(
  plan: Plan,
  out: JobProbe,
  pictureSources: ReadonlySet<number>,
): Map<PlanStream, Stream> {
  const paired = new Map<PlanStream, Stream>();
  // Pictures are left out on both sides (outputStreams skips them in the output).
  const kept = plan.streams.filter((s) => s.action !== 'drop' && !pictureSources.has(s.index));
  const tracks = plan.output ?? [];
  if (tracks.length > 0 && tracks.every((t) => t.sourceIndex !== undefined)) {
    const taken = new Set<PlanStream>();
    const ordinal = new Map<string, number>();
    for (const t of tracks) {
      if (typeof t.sourceIndex === 'number' && pictureSources.has(t.sourceIndex)) continue;
      const n = ordinal.get(t.type) ?? 0;
      ordinal.set(t.type, n + 1);
      if (t.sourceIndex === null || !KINDS.includes(t.type as Kind)) continue;
      // The same source and codec first: an added track (a second encode of one source) may be
      // written before the one that keeps it.
      const free = (s: PlanStream) => s.index === t.sourceIndex && !taken.has(s);
      const entry = kept.find((s) => free(s) && s.codec === t.codec) ?? kept.find(free);
      const stream = outputStreams(out, t.type as Kind)[n];
      if (!entry || !stream) continue;
      taken.add(entry);
      paired.set(entry, stream);
    }
    return paired;
  }
  for (const kind of KINDS) {
    const streams = outputStreams(out, kind);
    kept
      .filter((s) => s.type === kind)
      .forEach((s, n) => {
        const stream = streams[n];
        if (stream) paired.set(s, stream);
      });
  }
  return paired;
}

/** "Video", "Audio 1", "Subtitles 2": numbered when a kind has more than one row. */
function labels(kinds: Kind[]): string[] {
  const NAMES: Record<Kind, string> = { video: 'Video', audio: 'Audio', subtitle: 'Subtitles' };
  const seen = new Map<Kind, number>();
  return kinds.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return kinds.filter((x) => x === k).length > 1 ? `${NAMES[k]} ${n}` : NAMES[k];
  });
}

/**
 * The comparison the job page shows, or null when there is nothing to compare: no probe of the
 * source; no verified output and no plan that would rewrite the file (a dry run or a done job); a
 * job that ended any other way without an output (failed, cancelled, skipped…).
 */
export function compareJob(job: BeforeAfterJob): Comparison | null {
  const { probe, outputProbe: out, plan } = job;
  if (!probe) return null;
  // A failed or cancelled job's output (if it got one) was thrown away: nothing to compare.
  if (!COMPARED_STATES.has(job.state)) return null;
  if (!out && !plan?.rewrite) return null;
  const after = afterSourceOf(job);

  // Before: every source track, with the bitrates it can be trusted with.
  const srcKbps = new Map(probe.streams.map((s) => [s.index, streamKbps(s, probe, true)]));
  const before = new Map(
    probe.streams.map((s) => [s.index, factsOf(s, srcKbps.get(s.index) ?? null)]),
  );
  // Pictures (covers, posters, images stored as video tracks) are not compared as video.
  const shown = (s: Stream) => KINDS.includes(s.type as Kind) && !isPicture(s, probe.streams);
  deriveVideo(
    probe.streams.filter(shown).map((s) => before.get(s.index) as Facts),
    fileKbps(probe.sizeBytes, probe.durationSeconds, probe.bitrateKbps),
  );

  // The rows: the plan's entries in source order (one per source track, then added ones), else the
  // source's tracks paired with the output's by kind and order.
  type Pending = {
    kind: Kind;
    src: Stream | null;
    was: Facts | null;
    now: Facts | null;
    drop: boolean;
    added: boolean;
  };
  const pending: Pending[] = [];
  if (plan) {
    const pictureSources = new Set(
      probe.streams.filter((s) => isPicture(s, probe.streams)).map((s) => s.index),
    );
    const paired = out ? pairOutputs(plan, out, pictureSources) : new Map<PlanStream, Stream>();
    const outKbps = (s: Stream) => (out ? streamKbps(s, out, false) : null);
    for (const p of plan.streams) {
      const src = probe.streams.find((s) => s.index === p.index) ?? null;
      if (!KINDS.includes(p.type as Kind) || (src && isPicture(src, probe.streams))) continue;
      const added = p.note === 'added' || p.note.startsWith('added: ');
      const drop = p.action === 'drop';
      const o = paired.get(p);
      const now = drop
        ? null
        : o
          ? measuredFacts(o, outKbps(o), p, src ? (srcKbps.get(src.index) ?? null) : null)
          : plannedFacts(p, src, src ? (srcKbps.get(src.index) ?? null) : null);
      pending.push({
        kind: p.type as Kind,
        src,
        was: src && !added ? (before.get(src.index) ?? null) : null,
        now,
        drop,
        added,
      });
    }
    // Tracks from subtitle files the output gains.
    for (const sc of plan.sidecars ?? []) {
      if (sc.action !== 'embed') continue;
      pending.push({
        kind: 'subtitle',
        src: null,
        was: null,
        now: subtitleFacts(sc.codec, sc.language, sc.forced),
        drop: false,
        added: true,
      });
    }
  } else if (out) {
    for (const kind of KINDS) {
      const outs = outputStreams(out, kind);
      probe.streams
        .filter((s) => s.type === kind && shown(s))
        .forEach((s, n) => {
          const o = outs[n];
          pending.push({
            kind,
            src: s,
            was: before.get(s.index) ?? null,
            now: o ? measuredFacts(o, streamKbps(o, out, false), null, null) : null,
            drop: !o,
            added: false,
          });
        });
    }
  }

  // After's video bitrate, derived the same way from the output (a plan has no measured total).
  if (out) {
    deriveVideo(
      pending.flatMap((r) => (r.now ? [r.now] : [])),
      fileKbps(out.sizeBytes, out.durationSeconds, out.bitrateKbps),
    );
  }

  // Video, then audio, then subtitles, each in source order (a sort is stable).
  pending.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const names = labels(pending.map((r) => r.kind));
  const rows: CompareRow[] = [fileRow(job, probe, out, plan)];
  pending.forEach((r, i) => {
    const label = names[i] ?? r.kind;
    const beforeSide = r.added || !r.was ? tagged('added') : side(describe(r.was, null));
    let afterSide: Side;
    if (r.drop || !r.now) afterSide = side([], [REMOVED]);
    else if (r.added || !r.was) afterSide = side(describe(r.now, null));
    else if (isCopy(plan, r.src)) afterSide = tagged('kept');
    else afterSide = side(describe(r.now, r.was), lossesOf(r.was, r.now));
    rows.push({ key: `${r.kind}-${i}`, label, before: beforeSide, after: afterSide });
  });
  return { after, rows };
}

function afterSourceOf(job: BeforeAfterJob): AfterSource {
  if (job.outputProbe) {
    return !job.dryRun && job.state === 'kept_original' ? 'not-kept' : 'measured';
  }
  return job.dryRun && !job.testEncode ? 'planned' : 'from-plan';
}

/** A subtitle track known only by its codec, language and forced flag (one from a file). */
function subtitleFacts(codec: string, language: string | null, forced: boolean): Facts {
  return {
    type: 'subtitle',
    codec,
    profile: null,
    encoding: null,
    width: null,
    height: null,
    frameRate: null,
    bitDepth: null,
    hdr: null,
    channels: null,
    rate: null,
    lossless: false,
    language,
    forced,
  };
}

/** The plan copies this source track as it is (its first entry keeps it). */
function isCopy(plan: Plan | null, src: Stream | null): boolean {
  if (!plan || !src) return false;
  const first = plan.streams.find((s) => s.index === src.index);
  return first?.action === 'keep';
}

/** File: size, overall bitrate and container, before and after. */
function fileRow(
  job: BeforeAfterJob,
  probe: JobProbe,
  out: JobProbe | null,
  plan: Plan | null,
): CompareRow {
  const before = side([
    fmtBytes(probe.sizeBytes),
    fmtRate(rateOf(fileKbps(probe.sizeBytes, probe.durationSeconds, probe.bitrateKbps), false)),
    probe.container.toUpperCase(),
  ]);
  if (out) {
    return {
      key: 'file',
      label: 'File',
      before,
      after: side([
        fmtBytes(out.sizeBytes),
        fmtRate(rateOf(fileKbps(out.sizeBytes, out.durationSeconds, out.bitrateKbps), false)),
        out.container.toUpperCase(),
      ]),
    };
  }
  // Planned: a done job (stored before its output was) measured its size; a dry run estimates it,
  // except when a size gate decides after encoding (no estimate claims what it will decide).
  const measured = !job.dryRun || job.testEncode ? (job.result?.afterBytes ?? null) : null;
  const estimate =
    job.dryRun && !job.testEncode && !job.dependsOnSize
      ? (job.result?.estimatedBytes ?? null)
      : null;
  const size = measured ?? estimate;
  const kbps =
    size !== null && probe.durationSeconds > 0 ? (size * 8) / probe.durationSeconds / 1000 : null;
  return {
    key: 'file',
    label: 'File',
    before,
    // Without a size the bitrate is unknown too: one "—" says both.
    after: side([
      ...(size === null
        ? [UNKNOWN]
        : [
            `${fmtBytes(size)}${measured === null ? ' (est.)' : ''}`,
            fmtRate(rateOf(kbps, measured === null)),
          ]),
      (plan?.container.to ?? probe.container).toUpperCase(),
    ]),
  };
}

const rateOf = (kbps: number | null, approx: boolean): Rate | null =>
  kbps === null ? null : { kbps, approx };
