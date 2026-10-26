// Remove duplicate audio: drops a kept audio track that writes the same thing as another one
// (same language, codec and channel count, nothing special about it), keeping the one made from
// the best source. Typical case: TrueHD 5.1 and AC-3 5.1 of the same language, both encoded to
// AAC 2.0 by Encode audio.
import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import { defineNode } from '@transcoda/sdk';
import {
  LANGUAGES,
  normalizeLanguage,
  normalizeProfile,
  type ProbeStream,
} from '@transcoda/shared';
import { z } from 'zod';
import { isExtraStream, streamsOf } from '../../engine/build-model.ts';
import { CODEC_NAMES } from './audio-title.ts';
import { filePort } from './common.ts';
import { copyModel } from './stream-rules.ts';

/** Dispositions that make a track more than another copy of the main audio. */
const SPECIAL_DISPOSITIONS = new Set([
  'comment',
  'visual_impaired',
  'hearing_impaired',
  'karaoke',
  'dub',
]);

/** A title word that says the track is a commentary or an audio description. */
const SPECIAL_WORD = /^(comment|descri|narrat)|^ad$/;

/**
 * Format names of more than one word or with punctuation (`DD+`, `Dolby Digital Plus`, `DTS-HD
 * MA`), taken out of a title as a whole before it is split into words: their parts ("plus",
 * "master", "x") can carry meaning on their own, so they are never stripped alone.
 */
const FORMAT_PHRASES =
  /dolby\s+digital\s+plus|dolby\s+digital|dolby\s+true\s*hd|dolby\s+atmos|true\s*hd|dts[-\s]?hd\s+(ma|master\s+audio|hra|high\s+resolution(\s+audio)?)|dts[-:\s]?(x|es|hd)\b|dd\+|e-?ac-?3|ac-?3|he-?aac(v2)?|aac-?lc|\d+(\.\d+)?[\s-]*(kb\/s|kbps|kbit\/s|khz|bit|ch)\b/g;

/**
 * Single title words that only name a format (codec, layout): a title made of them, numbers and
 * the track's language says nothing a duplicate does not. Kept short on purpose: stripping a word
 * makes two tracks more alike, so a word that might mean something stays.
 */
const FORMAT_WORDS = new Set([
  'ac3',
  'eac3',
  'aac',
  'dd',
  'ddp',
  'dolby',
  'truehd',
  'atmos',
  'dts',
  'flac',
  'pcm',
  'lpcm',
  'alac',
  'mlp',
  'opus',
  'vorbis',
  'mp2',
  'mp3',
  'lossless',
  'mono',
  'stereo',
  'surround',
  'kbps',
  'khz',
]);

/** Codecs whose audio is lossless (any `pcm_*` too; DTS only as DTS-HD MA). */
const LOSSLESS = new Set(['truehd', 'mlp', 'flac', 'alac']);

const LANGUAGE_BY_CODE = new Map(LANGUAGES.map((l) => [l.t, l]));

function sourceOf(probe: ProbeResult, s: StreamPlan): ProbeStream | undefined {
  return isExtraStream(s) ? undefined : probe.streams.find((p) => p.index === s.sourceIndex);
}

/** What a kept audio track writes: a conversion's target, a copy's source (the probe). */
interface Written {
  stream: StreamPlan;
  source: ProbeStream;
  language: string | null;
  codec: string;
  channels: number | null;
  /**
   * Everything else that must be equal for a duplicate: forced, the title's meaningful words, and
   * a copy's sample rate and bit depth (unknown is a value of its own). A conversion's are what
   * the encode makes, so they are left out and only rank the sources.
   */
  rest: string;
  special: boolean;
}

function words(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The title's words beyond format names, numbers and the track's language; '' when none. */
function meaningful(title: string | null, language: string | null): string {
  const entry = language === null ? undefined : LANGUAGE_BY_CODE.get(language);
  const languageWords = new Set(
    entry ? [entry.t, entry.b, entry.one, ...words(entry.name)].filter((w) => w !== null) : [],
  );
  return words((title ?? '').toLowerCase().replace(FORMAT_PHRASES, ' '))
    .filter((w) => !FORMAT_WORDS.has(w) && !languageWords.has(w) && !/^\d+$/.test(w))
    .join(' ');
}

function written(s: StreamPlan, source: ProbeStream): Written {
  const language = normalizeLanguage(s.language);
  const convert = s.mode === 'convert';
  const sampleRate = convert ? null : source.sampleRate;
  const bitDepth = convert ? null : source.bitDepth;
  return {
    stream: s,
    source,
    language,
    codec: convert ? s.codec : source.codec,
    channels: convert ? (s.channels ?? source.channels) : source.channels,
    rest: JSON.stringify([s.forced, meaningful(s.title, language), sampleRate, bitDepth]),
    special:
      s.dispositions.some((d) => SPECIAL_DISPOSITIONS.has(d)) ||
      words(s.title ?? '').some((w) => SPECIAL_WORD.test(w)),
  };
}

/**
 * The value two duplicates share: language (untagged is a value of its own), codec, channel count
 * and the rest, all equal. Null for a track that is never a duplicate: special, or of unknown
 * channel count. Equal keys make duplicates an equivalence, so track order never changes the groups.
 */
function keyOf(w: Written): string | null {
  if (w.special || w.channels === null) return null;
  return JSON.stringify([w.language, w.codec, w.channels, w.rest]);
}

function lossless(p: ProbeStream): boolean {
  if (LOSSLESS.has(p.codec) || p.codec.startsWith('pcm_')) return true;
  return p.codec === 'dts' && (normalizeProfile(p.profile)?.startsWith('dts-hd-ma') ?? false);
}

/**
 * Better source first: lossless, more channels, higher bit depth, higher sample rate, higher
 * bitrate (unknown lowest in each), then earlier.
 */
function better(a: Written, b: Written): number {
  const x = a.source;
  const y = b.source;
  return (
    Number(lossless(y)) - Number(lossless(x)) ||
    (y.channels ?? 0) - (x.channels ?? 0) ||
    (y.bitDepth ?? 0) - (x.bitDepth ?? 0) ||
    (y.sampleRate ?? 0) - (x.sampleRate ?? 0) ||
    (y.bitrateKbps ?? -1) - (x.bitrateKbps ?? -1)
  );
}

/**
 * Plans that copy a stream another kept plan already writes (Encode audio's added track): they
 * exist so a target can play the default, so this node leaves them alone.
 */
function addedCopies(model: BuildModel): Set<StreamPlan> {
  const seen = new Set<string>();
  const added = new Set<StreamPlan>();
  for (const s of model.streams) {
    if (!s.keep) continue;
    const key = `${s.input ?? 0}#${s.sourceIndex}`;
    if (seen.has(key)) added.add(s);
    seen.add(key);
  }
  return added;
}

const LAYOUTS: Record<number, string> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };

/** `AAC 2.0 English`, `AC-3 5.1 untagged`. */
function describe(w: Written): string {
  const codec = w.codec.startsWith('pcm_')
    ? 'PCM'
    : (CODEC_NAMES[w.codec] ?? w.codec.toUpperCase());
  const layout = w.channels === null ? null : (LAYOUTS[w.channels] ?? `${w.channels}ch`);
  const language =
    w.language === null ? 'untagged' : (LANGUAGE_BY_CODE.get(w.language)?.name ?? w.language);
  return [codec, layout, language].filter((x) => x !== null).join(' ');
}

/** `audio #2`: the track's place among the source's audio tracks, as the job page names it. */
function audioRef(probe: ProbeResult, s: StreamPlan): string {
  const at = probe.streams
    .filter((p) => p.type === 'audio')
    .findIndex((p) => p.index === s.sourceIndex);
  return `audio #${at >= 0 ? at + 1 : s.sourceIndex}`;
}

export const removeDuplicateAudio = defineNode({
  version: 1,
  kind: 'action',
  inputs: [filePort],
  outputs: [filePort],
  type: 'core:remove-duplicate-audio',
  title: 'Remove duplicate audio',
  description:
    'Drops an audio track that ends up the same as another one (language, codec and channels), keeping the one made from the best source.',
  icon: 'copy',
  settings: z.object({}),
  async build(ctx) {
    const model: BuildModel = copyModel(ctx.model);
    const audio = streamsOf(model, 'audio');
    const added = addedCopies(model);
    // Duplicates share a key; groups keep the order of their first track.
    const groups = new Map<string, Written[]>();
    for (const s of audio) {
      const source = sourceOf(ctx.probe, s);
      if (!source || added.has(s)) continue;
      const w = written(s, source);
      const key = keyOf(w);
      if (key !== null) groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    const drops: { loser: Written; winner: Written; why: string }[] = [];
    let defaultFor: StreamPlan | null = null;
    for (const group of groups.values()) {
      // Stable sort: equal sources keep their output order, so the earlier track wins.
      const [winner, ...losers] = [...group].sort(better);
      if (!winner || losers.length === 0) continue;
      const why = `same as ${audioRef(ctx.probe, winner.stream)} (${describe(winner)})`;
      for (const loser of losers) drops.push({ loser, winner, why });
      if (defaultFor === null && losers.some((t) => t.stream.default)) defaultFor = winner.stream;
    }
    if (drops.length === 0) return { model, reason: 'no duplicate audio' };
    drops.sort((a, b) => audio.indexOf(a.loser.stream) - audio.indexOf(b.loser.stream));
    for (const { loser, why } of drops) {
      loser.stream.keep = false;
      loser.stream.dropReason = why;
    }
    const pieces = drops.map(
      ({ loser, why }) => `dropped ${audioRef(ctx.probe, loser.stream)}: ${why}`,
    );
    // A dropped default hands its flag to the track kept in its place, unless another kept audio
    // track is default already.
    if (defaultFor !== null && !audio.some((s) => s.keep && s.default)) {
      defaultFor.default = true;
      pieces.push(`default audio now ${audioRef(ctx.probe, defaultFor)}`);
    }
    return {
      model,
      reason: pieces.join('; '),
      findings: {
        dropped: drops.map(({ loser, winner }) => ({
          index: loser.stream.sourceIndex,
          sameAs: winner.stream.sourceIndex,
          codec: loser.codec,
          channels: loser.channels,
        })),
      },
    };
  },
});
