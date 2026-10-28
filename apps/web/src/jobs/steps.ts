// Screen 06b "What the workflow would do": one row per node in run order, a plain sentence of what
// it does and a badge. Pure over the trace's decisions (traceOverlay `decisions`), worded from the
// structured parts of each entry (`changes`, findings, the node's settings, the probe), never from
// the engine's reason text, except where a node only has that (conditions, data, plugins).
import type {
  JobState,
  JsonValue,
  ProbeSummary,
  TraceChanges,
  WorkflowGraph,
} from '@transcoda/shared';
import {
  CHECK_SOURCE_DAMAGED_PORT,
  CHECK_SOURCE_TYPE,
  changesFile,
  isFinalState,
  RENDER_DAMAGED_PORT,
  RENDER_TYPE,
} from '@transcoda/shared';
import type { Decision } from '../editor/trace/traceOverlay.ts';
import { languageNameOf } from './planText.ts';

export type Badge =
  | 'start'
  | 'change'
  | 'same'
  | 'check'
  | 'finish'
  | 'yes'
  | 'no'
  | 'failed'
  | 'not-run';

/** An unmet precondition or a warning on a step, with where to fix it when there is a place. */
export interface StepNote {
  text: string;
  link?: { href: string; label: string };
}

export type StepDetail =
  | {
      kind: 'defaults';
      rows: { track: string; language: string; before: boolean; after: boolean }[];
    }
  | { kind: 'video'; before: string; after: string; pixelFormat: string | null }
  | { kind: 'languages'; keep: string; has: string[]; drops: string | null };

export interface Step {
  key: string;
  decision: Decision;
  badge: Badge | null;
  sentence: string;
  /** The step changes nothing (or did not run): its sentence is dimmed. */
  quiet: boolean;
  notes: StepNote[];
  detail: StepDetail | null;
}

export interface StepContext {
  dryRun: boolean;
  state: JobState;
  probe: ProbeSummary | null;
  libraryName: string;
  workflowId: string;
  /** A plan-only dry run whose size gate decides after encoding (#41). */
  dependsOnSize: boolean;
  replacedTo: 'recycle' | 'deleted' | null;
  /** The source turned out damaged (`result.sourceDamaged`): the Damaged side's steps ran. */
  sourceDamaged?: boolean;
  /** The workflow's nodes on a Damaged side (`damagedSideOf`), top level only. */
  damagedSide?: ReadonlySet<string>;
}

/**
 * The nodes below a Damaged output (Render's or Check source's) of the top-level graph: they run
 * only when the source turns out damaged.
 */
export function damagedSideOf(graph: WorkflowGraph): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const queue = graph.edges
    .filter((e) => {
      const type = byId.get(e.from.node)?.type;
      return (
        (type === RENDER_TYPE && e.from.port === RENDER_DAMAGED_PORT) ||
        (type === CHECK_SOURCE_TYPE && e.from.port === CHECK_SOURCE_DAMAGED_PORT)
      );
    })
    .map((e) => e.to.node);
  const out = new Set<string>();
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (out.has(id)) continue;
    out.add(id);
    for (const e of graph.edges) if (e.from.node === id) queue.push(e.to.node);
  }
  return out;
}

type Changed = TraceChanges['dropped'][number];
type Converted = TraceChanges['converted'][number];

/** What one step needs to know about the others (worked out once in {@link steps}). */
interface Around {
  /** Where the first failure is among the steps (its index); null without one. */
  failedAt: number | null;
  /** This step's index. */
  at: number;
  /** A step replaces the original (the size gate's pass leads to it). */
  replaces: boolean;
}

/**
 * Past tense only for what a real run wrote: a dry run, a running job and a job that never wrote
 * (failed, cancelled, kept the original) describe the plan in the present.
 */
const pastOf = (ctx: StepContext) => !ctx.dryRun && ctx.state === 'done';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "A", "A and B", "A, B and C". */
function listAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const unique = (items: string[]) => [...new Set(items)];

/** At most this many names in a list; the rest are counted ("and 14 more"). */
const SHOWN_NAMES = 4;

/** "French, Spanish, Italian, Turkish and 14 more languages": a long list cut short. */
function someOf(names: string[], noun: string): string {
  if (names.length <= SHOWN_NAMES) return names.join(', ');
  const rest = names.length - SHOWN_NAMES;
  return `${names.slice(0, SHOWN_NAMES).join(', ')} and ${rest} more ${noun}`;
}

const CODEC_NAMES: Record<string, string> = {
  hevc: 'HEVC',
  h264: 'H.264',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2video: 'MPEG-2',
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  opus: 'Opus',
  flac: 'FLAC',
  dts: 'DTS',
  truehd: 'TrueHD',
  mp3: 'MP3',
};

/** A codec as people name it ("HEVC", "AC-3"); an unknown one in capitals. */
export function codecName(codec: string): string {
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

const LAYOUTS: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };
const layout = (channels: number) => LAYOUTS[channels] ?? `${channels}-channel`;

const TYPE_WORD: Record<Changed['type'], string> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  attachment: 'attachment',
  data: 'data track',
};

/**
 * "audio #1", "subtitle #2": the stream's place among its type in the source (1-based, from the
 * probe; without one, its index); a stream from an extra input is its file.
 */
function trackOf(s: Changed, probe: ProbeSummary | null): string {
  if (s.file !== undefined) return s.file;
  const ofType = probe?.streams.filter((p) => p.type === s.type) ?? [];
  const at = ofType.findIndex((p) => p.index === s.index);
  return `${TYPE_WORD[s.type]} #${at >= 0 ? at + 1 : s.index}`;
}

/** "English audio #1", "Untagged subtitle #3" → untagged streams are named without a language. */
function namedTrack(s: Changed, probe: ProbeSummary | null): string {
  const track = trackOf(s, probe);
  return s.language === null || s.file !== undefined
    ? capital(track)
    : `${languageNameOf(s.language)} ${track}`;
}

/** Sentence-initial track names keep their case; within a sentence a bare "Audio #1" is lower. */
const inSentence = (name: string) =>
  /^[A-Z][a-z]+ #/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;

const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null);
const num = (v: JsonValue | undefined): number | null => (typeof v === 'number' ? v : null);
const strings = (v: JsonValue | undefined): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

/**
 * The quality option's name, as the encoder calls it. Capped (a quality with a bitrate), NVENC
 * encodes VBR with a constant-quality target (CQ) and VA-API tries QVBR (a quality level).
 */
function qualityName(encoder: string, capped: boolean): string {
  if (encoder.endsWith('_nvenc')) return capped ? 'CQ' : 'QP';
  if (encoder.endsWith('_vaapi')) return capped ? 'Q' : 'QP';
  return encoder.endsWith('_qsv') ? 'Q' : 'CRF';
}

/**
 * A video conversion's rate control: "CRF 24", "3000 kb/s" (a target bitrate) or
 * "CRF 24, at most 5000 kb/s" (a quality the source bitrate caps); null for neither.
 */
function videoRate(v: Converted): string | null {
  const kbps = v.bitrateKbps === null ? null : `${v.bitrateKbps} kb/s`;
  if (v.quality === null) return kbps;
  const quality = `${qualityName(v.encoder ?? '', kbps !== null)} ${v.quality}`;
  return kbps === null ? quality : `${quality}, at most ${kbps}`;
}

/** "on the GPU (NVENC, QP 24)", "in software (libx265, CRF 24)", "in software (libx265, 3000 kb/s)". */
function encodedHow(v: Converted): string {
  const e = v.encoder ?? '';
  const rate = videoRate(v);
  const q = rate === null ? '' : `, ${rate}`;
  const gpu = [
    [/_nvenc$/, 'NVENC'],
    [/_qsv$/, 'Quick Sync'],
    [/_vaapi$/, 'VA-API'],
    [/_videotoolbox$/, 'VideoToolbox'],
    [/_amf$/, 'AMF'],
  ] as const;
  for (const [re, name] of gpu) if (re.test(e)) return `on the GPU (${name}${q})`;
  return e === '' ? '' : `in software (${e}${q})`;
}

const bitDepthOf = (pixelFormat: string | null): number | null => {
  if (pixelFormat === null) return null;
  if (/(10|p010)/.test(pixelFormat)) return 10;
  if (/(12|p012)/.test(pixelFormat)) return 12;
  return 8;
};

function videoSource(probe: ProbeSummary | null) {
  return probe?.streams.find((s) => s.type === 'video' && !s.attachedPic) ?? null;
}

// ---- per node type ----

type Words = { sentence: string; detail?: StepDetail | null; notes?: StepNote[] };
type Wording = (d: Decision, c: TraceChanges, ctx: StepContext, past: boolean) => Words;

function keepLanguages(d: Decision, c: TraceChanges, ctx: StepContext, past: boolean): Words {
  const { probe } = ctx;
  const byType = (type: 'audio' | 'subtitle') => c.dropped.filter((s) => s.type === type);
  const parts: string[] = [];
  const drops: string[] = [];
  for (const type of ['audio', 'subtitle'] as const) {
    const list = byType(type);
    if (list.length === 0) continue;
    const names = unique(list.map((s) => languageNameOf(s.language)));
    const noun =
      type === 'audio'
        ? plural(list.length, 'audio track', 'audio tracks')
        : plural(list.length, 'subtitle', 'subtitles');
    parts.push(`${list.length} ${noun} (${someOf(names, 'languages')})`);
    // The details name every language: they are where the whole list is.
    drops.push(
      `${listAnd(names)} ${type === 'audio' ? 'audio' : plural(list.length, 'subtitle', 'subtitles')}`,
    );
  }
  let sentence: string;
  if (parts.length > 0) {
    sentence = `${past ? 'Dropped' : 'Drops'} ${parts.join(' and ')}`;
  } else {
    const tracks = probe?.streams.filter((s) => s.type === 'audio' || s.type === 'subtitle') ?? [];
    const languages = unique(tracks.map((s) => languageNameOf(s.language)));
    const all = languages.length === 1 && tracks.every((s) => s.language !== null);
    const lead = all
      ? `All tracks ${past ? 'were' : 'are'} already ${languages[0]}`
      : `Every track ${past ? 'was' : 'is'} in a language to keep`;
    sentence = `${lead}, so nothing ${past ? 'was' : 'is'} dropped`;
  }
  const handed = c.defaults.filter((s) => s.after).map((s) => namedTrack(s, probe));
  if (handed.length > 0) {
    const verb = past ? 'became' : handed.length === 1 ? 'becomes' : 'become';
    sentence += `; ${inSentence(listAnd(handed))} ${verb} ${plural(handed.length, 'the default', 'the defaults')}`;
  }
  const s = d.settings;
  const original = str(d.findings.originalLanguage);
  const keep = [
    ...(s.keepOriginal === false
      ? []
      : [
          original && original !== 'unknown'
            ? `the original language (${languageNameOf(original)})`
            : 'the original language',
        ]),
    ...(strings(s.languages) ?? ['en']).map(languageNameOf),
    ...(s.keepUntagged === false ? [] : ['untagged tracks']),
  ];
  const has = probe
    ? (['audio', 'subtitle'] as const).flatMap((type) => {
        const names = probe.streams
          .filter((p) => p.type === type)
          .map((p) => languageNameOf(p.language));
        if (names.length === 0) return [];
        const counted = unique(names).map((n) => {
          const count = names.filter((x) => x === n).length;
          return count > 1 ? `${n} (${count})` : n;
        });
        return [`${type === 'audio' ? 'Audio' : 'Subtitles'} in this file: ${counted.join(', ')}`];
      })
    : [];
  return {
    sentence,
    detail: {
      kind: 'languages',
      keep: `Keep: ${keep.join(', ')}`,
      has,
      drops: drops.length > 0 ? `Drops: ${drops.join(', ')}` : null,
    },
  };
}

function setDefaultTrack(_d: Decision, c: TraceChanges, ctx: StepContext, past: boolean): Words {
  const { probe } = ctx;
  const made = c.defaults.filter((s) => s.after).map((s) => namedTrack(s, probe));
  const cleared = c.defaults.filter((s) => !s.after).map((s) => namedTrack(s, probe));
  let sentence: string;
  if (made.length > 0) {
    const verb = past ? 'became' : made.length === 1 ? 'becomes' : 'become';
    sentence = `${listAnd(made)} ${verb} ${plural(made.length, 'the default', 'the defaults')}`;
  } else if (cleared.length > 0) {
    const verb = past ? plural(cleared.length, 'was', 'were') : plural(cleared.length, 'is', 'are');
    sentence = `${listAnd(cleared)} ${verb} no longer ${plural(cleared.length, 'a default', 'defaults')}`;
  } else {
    sentence = `The default tracks already ${past ? 'matched' : 'match'} the preference`;
  }
  const rows = c.defaults.map((s) => ({
    track: trackOf(s, probe),
    language: `${languageNameOf(s.language)}${s.forced ? ', forced' : ''}`,
    before: s.before,
    after: s.after,
  }));
  return { sentence, detail: rows.length > 0 ? { kind: 'defaults', rows } : null };
}

function reorderTracks(d: Decision, c: TraceChanges, _ctx: StepContext, past: boolean): Words {
  if (!c.reordered) {
    return {
      sentence: `The track order already ${past ? 'matched' : 'matches'} the language order`,
    };
  }
  const order = (strings(d.settings.languages) ?? ['en']).map(languageNameOf);
  return {
    sentence: `${past ? 'Put' : 'Puts'} audio and subtitles in the language order ${listAnd(order)}`,
  };
}

function coverAttachments(d: Decision, c: TraceChanges, _ctx: StepContext, past: boolean): Words {
  const covers = c.dropped.filter((s) => s.type === 'video');
  const attachments = c.dropped.filter((s) => s.type === 'attachment');
  const parts = [
    ...(covers.length > 0
      ? [plural(covers.length, 'the cover image', `${covers.length} cover images`)]
      : []),
    ...(attachments.length > 0
      ? [plural(attachments.length, 'an attachment', `${attachments.length} attachments`)]
      : []),
  ];
  let sentence =
    parts.length > 0
      ? `${past ? 'Dropped' : 'Drops'} ${listAnd(parts)}`
      : `Covers and attachments ${past ? 'stayed as they were' : 'stay as they are'}`;
  if (d.findings.fontsKeptForAss === true) {
    sentence += `; the fonts the ASS subtitles need ${past ? 'stayed' : 'stay'}`;
  }
  return { sentence };
}

function encodeVideo(d: Decision, c: TraceChanges, ctx: StepContext, past: boolean): Words {
  const notes: StepNote[] = [];
  const skipIf = str(d.settings.skipIf) ?? 'already-target-codec';
  const targets = strings(d.settings.targets) ?? [];
  if (skipIf === 'plays-on-all-targets' && targets.length === 0) {
    notes.push({
      text: "Playback compatibility wasn't checked: no playback targets are set.",
      link: { href: `/workflows/${ctx.workflowId}`, label: 'Add targets in the workflow' },
    });
  }
  const src = videoSource(ctx.probe);
  const v = c.converted.find((s) => s.type === 'video');
  if (!v) {
    if (ctx.probe && !src) return { sentence: "There's no video to encode", notes };
    const was = past ? 'was' : 'is';
    // An earlier step already converts the video: this one leaves that as it is.
    if (d.reason.startsWith('video already converted to')) {
      return {
        sentence: `Video ${was} already being re-encoded by an earlier step, so this step ${past ? 'left' : 'leaves'} it`,
        notes,
      };
    }
    const copied = past ? 'it was copied' : "it's copied";
    if (skipIf === 'plays-on-all-targets' && targets.length > 0) {
      return {
        sentence: `Video already ${past ? 'played' : 'plays'} on every target, so ${copied}`,
        notes,
      };
    }
    if (!src) return { sentence: `Video ${was} copied as it ${was}`, notes };
    return { sentence: `Video ${was} already ${codecName(src.codec)}, so ${copied}`, notes };
  }
  const how = encodedHow(v);
  const sentence = `Video ${past ? 'was' : 'is'} re-encoded to ${codecName(v.codec)}${how ? ` ${how}` : ''}`;
  const beforeParts = src
    ? [
        `${codecName(src.codec)}${src.bitDepth ? ` ${src.bitDepth}-bit` : ''}`,
        ...(src.height ? [`${src.height}p`] : []),
      ]
    : [codecName(v.from)];
  const depth = bitDepthOf(v.pixelFormat);
  const afterParts = [
    `${codecName(v.codec)}${depth ? ` ${depth}-bit` : ''}`,
    ...(v.encoder ? [v.encoder] : []),
    ...[videoRate(v)].filter((r) => r !== null),
    ...(v.preset ? [v.preset] : []),
  ];
  let pixelFormat: string | null = null;
  if (v.pixelFormat !== null) {
    const from = src?.pixelFormat;
    pixelFormat = from && from !== v.pixelFormat ? `${from} → ${v.pixelFormat}` : v.pixelFormat;
    if (/_nvenc$/.test(v.encoder ?? '') && depth === 10) {
      pixelFormat += ', passed to NVENC as p010le (its 10-bit format)';
    }
  }
  return {
    sentence,
    notes,
    detail: {
      kind: 'video',
      before: beforeParts.join(', '),
      after: afterParts.join(', '),
      pixelFormat,
    },
  };
}

/** "AAC 160 kb/s stereo". */
function audioTarget(s: Converted): string {
  return [
    codecName(s.codec),
    ...(s.bitrateKbps !== null ? [`${s.bitrateKbps} kb/s`] : []),
    ...(s.channels !== null ? [layout(s.channels)] : []),
  ].join(' ');
}

function encodeAudio(_d: Decision, c: TraceChanges, ctx: StepContext, past: boolean): Words {
  const { probe } = ctx;
  const parts: string[] = [];
  const converted = c.converted.filter((s) => s.type === 'audio');
  const is = past ? 'was' : 'is';
  const are = past ? 'were' : 'are';
  if (converted.length === 1 && converted[0]) {
    const s = converted[0];
    parts.push(`${namedTrack(s, probe)} ${is} re-encoded to ${audioTarget(s)}`);
  } else if (converted.length > 1) {
    const targets = unique(converted.map(audioTarget));
    const to =
      targets.length === 1
        ? targets[0]
        : unique(converted.map((s) => codecName(s.codec))).join(' and ');
    parts.push(`${converted.length} audio tracks ${are} re-encoded to ${to}`);
  }
  for (const s of c.added.filter((a) => a.type === 'audio')) {
    const what = [s.channels !== null ? layout(s.channels) : null, codecName(s.codec)]
      .filter((x) => x !== null)
      .join(' ');
    const lead = parts.length === 0 ? (past ? 'Added' : 'Adds') : past ? 'added' : 'adds';
    parts.push(
      `${lead} a ${what} copy of ${inSentence(namedTrack(s, probe))} so every target can play it`,
    );
  }
  return {
    sentence: parts.length > 0 ? parts.join('; ') : `Audio ${is} copied as it ${is}`,
  };
}

function remux(d: Decision, c: TraceChanges, _ctx: StepContext, past: boolean): Words {
  const parts: string[] = [];
  if (c.container) {
    parts.push(
      `${past ? 'Moved' : 'Moves'} the streams into ${c.container.to.toUpperCase()} (was ${c.container.from.toUpperCase()})`,
    );
  } else {
    const to = (str(d.settings.container) ?? 'mkv').toUpperCase();
    parts.push(
      `The file ${past ? 'was' : 'is'} already ${to}, so the container ${past ? 'stayed' : 'stays'}`,
    );
  }
  const subs = c.converted.filter((s) => s.type === 'subtitle');
  if (subs.length > 0 && subs[0]) {
    parts.push(`text subtitles ${past ? 'became' : 'become'} ${subs[0].codec}`);
  }
  const dropped = c.dropped.filter((s) => s.type === 'subtitle');
  if (dropped.length > 0) {
    parts.push(
      `${past ? 'dropped' : 'drops'} ${dropped.length} ${plural(dropped.length, 'subtitle', 'subtitles')} the container or targets can't play`,
    );
  }
  return { sentence: parts.join('; ') };
}

function embedSubtitles(d: Decision, c: TraceChanges, _ctx: StepContext, past: boolean): Words {
  const files = c.added.filter((s) => s.type === 'subtitle').map((s) => s.file ?? trackOf(s, null));
  const skipped = Array.isArray(d.findings.skipped) ? d.findings.skipped : [];
  const notes = skipped.flatMap((k) => {
    if (typeof k !== 'object' || k === null || Array.isArray(k)) return [];
    const file = str(k.file);
    const reason = str(k.reason);
    return file && reason ? [{ text: `${file} wasn't embedded: ${reason}` }] : [];
  });
  if (files.length > 0)
    return { sentence: `${past ? 'Embedded' : 'Embeds'} ${listAnd(files)}`, notes };
  return {
    sentence:
      notes.length > 0
        ? `None of the subtitle files next to the video ${past ? 'could' : 'can'} be embedded`
        : 'There are no subtitle files next to the video',
    notes,
  };
}

/** "5.1", "2.0": a channel count as audio formats are named; null when unknown. */
const SPEAKERS: Record<number, string> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };
const speakers = (channels: number | null) =>
  channels === null ? null : (SPEAKERS[channels] ?? `${channels}-channel`);

/** "AC-3 5.1 → AAC 2.0", or "AAC 2.0" when the track was copied as it was. */
function audioChange(
  source: ProbeSummary['streams'][number] | undefined,
  codec: string,
  channels: number | null,
): string {
  const to = [codecName(codec), speakers(channels)].filter((x) => x !== null).join(' ');
  if (!source) return to;
  const from = [codecName(source.codec), speakers(source.channels)]
    .filter((x) => x !== null)
    .join(' ');
  return from === to ? to : `${from} → ${to}`;
}

function removeDuplicateAudio(
  d: Decision,
  c: TraceChanges,
  ctx: StepContext,
  past: boolean,
): Words {
  const { probe } = ctx;
  const dropped = c.dropped.filter((s) => s.type === 'audio');
  if (dropped.length === 0) return { sentence: 'No duplicate audio tracks' };
  const found = Array.isArray(d.findings.dropped) ? d.findings.dropped : [];
  const whyOf = (index: number) => {
    const f = found.find(
      (x) => typeof x === 'object' && x !== null && !Array.isArray(x) && x.index === index,
    );
    return f && typeof f === 'object' && !Array.isArray(f) ? f : null;
  };
  const audioTrack = (index: number) =>
    trackOf({ index, type: 'audio', codec: '', language: null, forced: false }, probe);
  // One clause per kept track, in the order of its first dropped duplicate.
  const clauses = new Map<string, string[]>();
  for (const s of dropped) {
    const why = whyOf(s.index);
    const sameAs = num(why?.sameAs);
    const key = sameAs === null ? '' : audioTrack(sameAs);
    const source = probe?.streams.find((p) => p.index === s.index);
    const what = audioChange(source, str(why?.codec) ?? s.codec, num(why?.channels));
    clauses.set(key, [...(clauses.get(key) ?? []), `${trackOf(s, probe)} (${what})`]);
  }
  const parts = [...clauses].map(([keptAs, tracks], i) => {
    const verb = past ? 'dropped' : 'drops';
    const lead = i === 0 ? capital(verb) : verb;
    return `${lead} ${listAnd(tracks)}${keptAs === '' ? '' : `: same as ${keptAs}`}`;
  });
  const handed = c.defaults.filter((s) => s.after).map((s) => namedTrack(s, probe));
  if (handed.length > 0) {
    const verb = past ? 'became' : handed.length === 1 ? 'becomes' : 'become';
    parts.push(
      `${listAnd(handed)} ${verb} ${plural(handed.length, 'the default', 'the defaults')}`,
    );
  }
  return { sentence: parts.join('; ') };
}

const ACTIONS: Record<string, Wording> = {
  'core:keep-languages': keepLanguages,
  'core:set-default-track': setDefaultTrack,
  'core:reorder-tracks': reorderTracks,
  'core:cover-attachments': coverAttachments,
  'core:encode-video': encodeVideo,
  'core:encode-audio': encodeAudio,
  'core:remove-duplicate-audio': removeDuplicateAudio,
  'core:remux': remux,
  'core:embed-sidecar-subtitles': embedSubtitles,
};

const TRIGGERS: Record<string, (ctx: StepContext) => string> = {
  'core:input-library': (ctx) => `Picked up from the ${ctx.libraryName} library`,
  'core:input-manual': () => 'Started on a file picked by hand',
  'core:input-webhook': () => 'Started by a webhook request',
};

/**
 * A reason without the node's own title at its start: "video is hevc 180p" under the title "Video
 * is" reads "hevc 180p" (only at a word boundary: "Cover" never eats the start of "covered").
 */
export function withoutTitle(reason: string, title: string): string {
  if (title === '' || !reason.toLowerCase().startsWith(title.toLowerCase())) return reason;
  const rest = reason.slice(title.length);
  if (rest !== '' && !/^[:\s]/.test(rest)) return reason;
  return rest.replace(/^[:\s]+/, '');
}

/**
 * A reason without the "→ yes" / "→ no" tail the engine appends (older traces: pass / else;
 * Render's "→ Done" / "→ Damaged").
 */
export function withoutVerdict(reason: string): string {
  return reason.replace(/\s*(?:→|->)\s*(?:pass|else|yes|no|done|damaged)(?=\)?$)/i, '');
}

/** The engine's own words for a node it has no structure for: a sentence, title and verdict off. */
const reasonSentence = (d: Decision) =>
  capital(withoutVerdict(withoutTitle(d.reason, d.title)).replace(/^start:\s*/, ''));

const FAILED = 'failed:';
const WRITES = new Set(['core:replace-original', 'core:move-copy']);

/** A finish step below a Damaged output (it runs only for a damaged source). */
const onDamagedSide = (d: Decision, ctx: StepContext) =>
  d.workflowPath.length === 0 && (ctx.damagedSide?.has(d.nodeId) ?? false);

/** Why a finish step did not run in a settled job; null when it ran (or will). */
function notRun(d: Decision, ctx: StepContext, around: Around): string | null {
  if (d.untaken) return "the file took the size gate's other branch";
  // The Damaged side of a real run whose source was fine never ran.
  if (onDamagedSide(d, ctx) && !ctx.sourceDamaged && !ctx.dryRun && isFinalState(ctx.state)) {
    return 'the source was not damaged';
  }
  if (!isFinalState(ctx.state) || d.plugin) return null;
  // A step before the failing one ran (a write, then a later step failed); a failure that is not
  // on the trace (ffmpeg, verify, the server) came after the build, before any finish step ran.
  if (ctx.state === 'failed' && (around.failedAt === null || around.at > around.failedAt)) {
    return 'the job failed first';
  }
  if (ctx.state === 'failed') return null;
  if (ctx.state === 'cancelled') return 'the job was cancelled first';
  // A dry run's write steps never run: its sentence says what they would do.
  if (!ctx.dryRun && d.type !== null && WRITES.has(d.type)) {
    if (ctx.state === 'kept_original') return 'the original was kept';
    if (ctx.state === 'nothing_to_do') return 'there was nothing to change';
    if (ctx.state === 'skipped') return 'the file was skipped';
  }
  return null;
}

function sizeGate(d: Decision, ctx: StepContext, past: boolean, around: Around): string {
  const min = num(d.findings.minSavingPercent) ?? num(d.settings.minSavingPercent) ?? 10;
  const saved = num(d.findings.savedPercent);
  if (ctx.dryRun && saved !== null && (d.branch === 'pass' || d.branch === 'else')) {
    // A test encode measured it: what a real run would then do.
    const would =
      d.branch === 'else'
        ? 'keep the original'
        : around.replaces
          ? 'replace the original'
          : 'go on to the finish steps';
    const how =
      saved < 0
        ? `${-saved}% bigger (at least ${min}% smaller needed)`
        : `${saved}% smaller (at least ${min}% needed)`;
    return `The test encode came out ${how}, so a real run would ${would}`;
  }
  const is = past ? 'was' : 'is';
  if (d.branch === 'pass' && saved !== null) {
    return `The result ${is} ${saved}% smaller (at least ${min}% needed), so the finish steps ${past ? 'went' : 'go'} ahead`;
  }
  if (d.branch === 'else' && saved !== null && saved < 0) {
    return `The result ${is} ${-saved}% bigger (at least ${min}% smaller needed), so the original ${is} kept`;
  }
  if (d.branch === 'else' && saved !== null) {
    return `The result ${is} only ${saved}% smaller (at least ${min}% needed), so the original ${is} kept`;
  }
  return `Keeps the result only if it is at least ${min}% smaller`;
}

function finishStep(d: Decision, ctx: StepContext, past: boolean): string {
  const s = d.settings;
  switch (d.type) {
    case 'core:replace-original': {
      const folder = str(s.recycleFolder);
      const where = folder ? `the folder ${folder}` : "this library's recycle folder";
      if (ctx.dependsOnSize) {
        return `If the size gate passes, replaces the original and moves it to ${where}; otherwise keeps it`;
      }
      // A real job still running has not written yet: it says when, not where the original goes.
      if (!ctx.dryRun && !isFinalState(ctx.state))
        return 'Replaces the original once the result is verified';
      if (!past) return `Replaces the original, which moves to ${where}`;
      return ctx.replacedTo === 'recycle'
        ? `Replaced the original, which is now in ${where}`
        : 'Replaced the original';
    }
    case 'core:move-copy': {
      const mode = str(s.mode) === 'move' ? 'move' : 'copy';
      const root = str(s.outputRoot) ?? 'the output folder';
      if (ctx.dependsOnSize) {
        return `If the size gate passes, ${mode === 'move' ? 'moves' : 'copies'} the result to ${root}; otherwise keeps the original`;
      }
      const verb = past
        ? mode === 'move'
          ? 'Moved'
          : 'Copied'
        : mode === 'move'
          ? 'Moves'
          : 'Copies';
      return `${verb} the result to ${root}`;
    }
    case 'core:notify-webhook':
      return `${past ? 'Sent' : 'Sends'} a ${str(s.method) ?? 'POST'} request to the webhook`;
    default:
      return reasonSentence(d);
  }
}

function step(d: Decision, ctx: StepContext, around: Around): Step {
  let past = pastOf(ctx);
  const base = { key: d.key, decision: d, notes: [], detail: null };
  if (d.reason.startsWith(FAILED)) {
    return {
      ...base,
      badge: 'failed',
      quiet: false,
      sentence: capital(d.reason.slice(FAILED.length).trim()),
    };
  }
  if (d.reason === 'bypassed' || d.reason.startsWith('bypassed (')) {
    const why = d.reason.slice('bypassed'.length).trim();
    return {
      ...base,
      badge: 'same',
      quiet: true,
      sentence: `Bypassed${why ? ` ${why}` : ''}, so this step ${past ? 'was' : 'is'} skipped`,
    };
  }
  if (d.kind === 'trigger') {
    const word = d.type ? TRIGGERS[d.type] : undefined;
    return {
      ...base,
      badge: 'start',
      quiet: false,
      sentence: word ? word(ctx) : reasonSentence(d),
    };
  }
  if (d.kind === 'condition') {
    const badge = d.port === 'pass' ? 'yes' : d.port === 'else' ? 'no' : null;
    return { ...base, badge, quiet: false, sentence: reasonSentence(d) };
  }
  if (d.type === 'core:run-subworkflow') {
    return {
      ...base,
      badge: null,
      quiet: false,
      sentence: `${past ? 'Ran' : 'Runs'} its sub-workflow on the file; its steps follow`,
    };
  }
  if (d.kind === 'finish') {
    const why = notRun(d, ctx, around);
    if (why !== null)
      return { ...base, badge: 'not-run', quiet: true, sentence: `Didn't run: ${why}` };
    // A real run that failed after this step: it ran.
    if (!ctx.dryRun && ctx.state === 'failed') past = true;
    // Render renders: its entries say how it went ("encoded and verified", "source is damaged …";
    // a plan: "decides while encoding; if the source is damaged: Notify webhook").
    if (d.type === RENDER_TYPE) {
      return { ...base, badge: null, quiet: false, sentence: reasonSentence(d) };
    }
    if (onDamagedSide(d, ctx)) {
      // A real run's damaged source ran the Damaged side; otherwise it only would if damaged.
      if (ctx.sourceDamaged && !ctx.dryRun && isFinalState(ctx.state)) {
        return { ...base, badge: 'finish', quiet: false, sentence: finishStep(d, ctx, true) };
      }
      const what = finishStep(d, ctx, false);
      const sentence = ctx.sourceDamaged ? what : `If the source is damaged: ${what}`;
      return { ...base, badge: 'finish', quiet: false, sentence };
    }
    if (d.type === 'core:size-gate') {
      // A real run's measurement is over once it settled, whether it wrote or kept the original.
      const measured = !ctx.dryRun && isFinalState(ctx.state);
      // Settled without writing and without a decision: the gate never measured anything.
      if (measured && ctx.state !== 'done' && d.branch === null) {
        return {
          ...base,
          badge: 'not-run',
          quiet: true,
          sentence: "Didn't decide: the job ended without measuring the result",
        };
      }
      return {
        ...base,
        badge: 'check',
        quiet: false,
        sentence: sizeGate(d, ctx, measured, around),
      };
    }
    return { ...base, badge: 'finish', quiet: false, sentence: finishStep(d, ctx, past) };
  }
  if (d.reason === 'no-op') {
    return { ...base, badge: 'same', quiet: true, sentence: 'Does nothing to the file' };
  }
  const warnings = (strings(d.findings.warnings) ?? []).map((w) => ({ text: capital(w) }));
  if (d.changes === null) {
    // Data nodes, and actions traced before entries said what they changed.
    return { ...base, badge: null, quiet: false, sentence: reasonSentence(d), notes: warnings };
  }
  const changing = changesFile(d.changes);
  const wording = d.type ? ACTIONS[d.type] : undefined;
  const words: Words = wording ? wording(d, d.changes, ctx, past) : { sentence: reasonSentence(d) };
  return {
    ...base,
    badge: changing ? 'change' : 'same',
    quiet: !changing,
    sentence: words.sentence,
    notes: [...(words.notes ?? []), ...warnings],
    detail: words.detail ?? null,
  };
}

/** The entry that speaks for a node in its attempt: a failure, else a gate's decision, else the last. */
function speaksFor(a: Decision, b: Decision): Decision {
  if (a.reason.startsWith(FAILED)) return a;
  if (b.reason.startsWith(FAILED)) return b;
  if (a.branch !== null && b.branch === null) return a;
  return b;
}

/**
 * One step per node and attempt, at the place of its first entry, in the decisions' order (run
 * order): a size gate's decision stands in for its build entry.
 */
export function steps(items: readonly Decision[], ctx: StepContext): Step[] {
  const byNode = new Map<string, Decision>();
  const order: string[] = [];
  for (const d of items) {
    const key = `${d.attempt}#${d.workflowPath.join('/')}#${d.nodeId}`;
    const seen = byNode.get(key);
    if (!seen) order.push(key);
    byNode.set(key, seen ? speaksFor(seen, d) : d);
  }
  const list = order.flatMap((key) => {
    const d = byNode.get(key);
    return d ? [d] : [];
  });
  // Only the last attempt's failure says which steps never ran.
  const lastAttempt = Math.max(0, ...list.map((d) => d.attempt));
  const failed = list.findIndex((d) => d.attempt === lastAttempt && d.reason.startsWith(FAILED));
  const replaces = list.some((d) => d.type === 'core:replace-original' && !d.untaken);
  return list.map((d, at) => step(d, ctx, { at, failedAt: failed >= 0 ? failed : null, replaces }));
}

/** The header's counts: steps that change the file, steps that do not (or did not run), notes. */
export function stepsSummary(list: readonly Step[]): {
  changing: number;
  unchanged: number;
  notes: number;
} {
  return {
    changing: list.filter((s) => s.badge === 'change').length,
    unchanged: list.filter((s) => s.badge === 'same' || s.badge === 'not-run').length,
    notes: list.reduce((n, s) => n + s.notes.length, 0),
  };
}

/** The section's heading: what the workflow would do, did, is doing, or planned. */
export function stepsHeading(ctx: Pick<StepContext, 'dryRun' | 'state'>): string {
  if (ctx.dryRun) return 'What the workflow would do';
  if (ctx.state === 'done') return 'What the workflow did';
  return isFinalState(ctx.state) ? 'What the workflow planned' : 'What the workflow is doing';
}

/** The badge's word; a real run that wrote says the file changed. */
export function badgeWord(badge: Badge, past: boolean): string {
  switch (badge) {
    case 'start':
      return 'Start';
    case 'change':
      return past ? 'Changed file' : 'Changes file';
    case 'same':
      return 'No change';
    case 'check':
      return 'Checked after encode';
    case 'finish':
      return 'After verification';
    case 'yes':
      return 'Yes';
    case 'no':
      return 'No';
    case 'failed':
      return 'Failed';
    case 'not-run':
      return "Didn't run";
  }
}

export { pastOf };
