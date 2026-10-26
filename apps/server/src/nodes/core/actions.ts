import type {
  BuildModel,
  NodeDefinition,
  NodeMigration,
  ProbeResult,
  StreamPlan,
} from '@transcoda/sdk';
import { defineNode } from '@transcoda/sdk';
import {
  DEVICE_PROFILES,
  type DeviceProfileId,
  DeviceProfileIdSchema,
  isPicture,
  normalizeLanguage,
  type ProbeStream,
} from '@transcoda/shared';
import { z } from 'zod';
import {
  fitToContainer,
  kept,
  qualityName,
  resolveEncoder,
  streamsOf,
  TEXT_SUBTITLES,
} from '../../engine/build-model.ts';
import {
  containerPlaysOn,
  defaultTracks,
  planIssues,
  streamLabel,
  type TargetIssue,
  targetWarnings,
} from '../../engine/targets.ts';
import { retitle } from './audio-title.ts';
import { filePort, LanguageCodeSchema, languageInput } from './common.ts';
import {
  addTargets,
  copyModel,
  list,
  matchesLanguage,
  NodeHookError,
  originalLanguage,
  pickDefault,
  reasonTag,
  ref,
  refs,
  setOrder,
  sortByLanguage,
  tag,
} from './stream-rules.ts';

function sourceOf(probe: ProbeResult, s: StreamPlan): ProbeStream | undefined {
  return probe.streams.find((p) => p.index === s.sourceIndex);
}

/**
 * Warnings for kept non-default tracks of `type` some target cannot play (allowed: the player
 * starts on the default tracks; controller ruling R1).
 */
function warningsFor(
  model: BuildModel,
  probe: ProbeResult,
  targets: DeviceProfileId[],
  type: StreamPlan['type'],
): string[] {
  const typeOf = new Map(model.streams.map((s) => [s.sourceIndex, s.type]));
  return targetWarnings(model, probe, targets)
    .filter((w) => w.streamIndex !== null && typeOf.get(w.streamIndex) === type)
    .map((w) => w.message);
}

/** The reason with each warning appended as `; warning: <message>`. */
function withWarnings(reason: string, warnings: string[]): string {
  return [reason, ...warnings.map((w) => `warning: ${w}`)].join('; ');
}

function unsupported(issues: TargetIssue[]): NodeHookError {
  return new NodeHookError(`target unsupported: ${issues.map((i) => i.message).join('; ')}`);
}

/** The conversion fields that describe a copy (cleared when a stream goes back to copy). */
const COPY: Pick<
  StreamPlan,
  'mode' | 'encoder' | 'quality' | 'preset' | 'bitrateKbps' | 'channels' | 'profile' | 'pixelFormat'
> = {
  mode: 'copy',
  encoder: null,
  quality: null,
  preset: null,
  bitrateKbps: null,
  channels: null,
  profile: null,
  pixelFormat: null,
};

/**
 * Version 1 → 2 of Encode video and Encode audio: existing nodes keep encoding as before, so the
 * never-above-the-source-bitrate cap (on for new nodes) starts off for them.
 */
function keepBitrateAsBefore(title: string): NodeMigration {
  return {
    from: 1,
    to: 2,
    risk: 'safe',
    note: `${title} can now cap at the source bitrate; left off for this node`,
    migrate: (settings) =>
      settings !== null &&
      typeof settings === 'object' &&
      !Array.isArray(settings) &&
      !Object.hasOwn(settings, 'neverIncreaseBitrate')
        ? { ...settings, neverIncreaseBitrate: false }
        : settings,
  };
}

/**
 * Version 2 → 3 of Encode audio: existing nodes keep their tracks' titles, so title updating (on
 * for new nodes) starts off for them.
 */
const keepTitlesAsBefore: NodeMigration = {
  from: 2,
  to: 3,
  risk: 'safe',
  note: "Encode audio can now update a re-encoded track's title to its new format; left off for this node",
  migrate: (settings) =>
    settings !== null &&
    typeof settings === 'object' &&
    !Array.isArray(settings) &&
    !Object.hasOwn(settings, 'updateTitles')
      ? { ...settings, updateTitles: false }
      : settings,
};

/** Whole kbps of a measured rate (never rounded up, so a cap stays at or under the source). */
const wholeKbps = (kbps: number | null | undefined) =>
  kbps === null || kbps === undefined || kbps < 1 ? null : Math.floor(kbps);

/**
 * A video stream's source bitrate, and whether it is the whole file's: mkv streams written by
 * ffmpeg carry none, and the file's rate (video plus every other stream) still bounds the video.
 */
function sourceBitrate(probe: ProbeResult, s: StreamPlan): { kbps: number; whole: boolean } | null {
  const own = wholeKbps(sourceOf(probe, s)?.bitrateKbps);
  if (own !== null) return { kbps: own, whole: false };
  const file = wholeKbps(probe.bitrateKbps);
  return file === null ? null : { kbps: file, whole: true };
}

/**
 * Encode video's rate control as a plan: quality alone (constant quality), a bitrate alone (target
 * bitrate), or both (capped quality: render gives the encoder the bitrate as its ceiling). With
 * neverIncreaseBitrate the source bitrate caps either mode.
 */
function videoRate(
  settings: {
    rateControl: 'quality' | 'bitrate';
    quality: number;
    bitrateKbps: number;
    neverIncreaseBitrate: boolean;
    preset: string;
  },
  encoder: string,
  source: { kbps: number; whole: boolean } | null,
): { quality: number | null; bitrateKbps: number | null; how: string; note: string } {
  const cap = settings.neverIncreaseBitrate ? source : null;
  const note =
    settings.neverIncreaseBitrate && source === null ? '; source bitrate unknown, not capped' : '';
  if (settings.rateControl === 'bitrate') {
    const capped = cap !== null && settings.bitrateKbps > cap.kbps;
    const kbps = capped ? cap.kbps : settings.bitrateKbps;
    const why = capped
      ? `, capped from ${settings.bitrateKbps}k at the ${cap.whole ? 'whole file’s' : 'source'} bitrate`
      : '';
    return {
      quality: null,
      bitrateKbps: kbps,
      how: `${encoder} ${kbps}k ${settings.preset}${why}`,
      note,
    };
  }
  const ceiling =
    cap === null ? '' : `, at most ${cap.kbps}k${cap.whole ? ': the whole file’s bitrate' : ''}`;
  return {
    quality: settings.quality,
    bitrateKbps: cap?.kbps ?? null,
    how: `${encoder} ${qualityName(encoder, cap !== null)} ${settings.quality} ${settings.preset}${ceiling}`,
    note,
  };
}

/**
 * Schema marker for the editor: show the field only while each named setting has the given
 * value (its default when unset). The engine ignores it; a hidden field keeps its value.
 */
const SHOW_WHEN = 'x-transcoda-show-when';

const AUDIO_ENCODERS = { aac: 'aac', ac3: 'ac3', opus: 'libopus' } as const;

/** The most channels every target plays for `codec`; null when no target limits it. */
function maxChannels(codec: string, targets: DeviceProfileId[]): number | null {
  const limits = targets.flatMap((t) => {
    const caps = DEVICE_PROFILES[t].audio;
    return Object.hasOwn(caps, codec) ? [caps[codec]?.maxChannels ?? Infinity] : [];
  });
  return limits.length > 0 ? Math.min(...limits) : null;
}

const FONT_CODECS = new Set(['ttf', 'otf']);
const ASS_CODECS = new Set(['ass', 'ssa']);

/**
 * When the stream flagged default among `streams` was dropped and none kept is flagged, flags the
 * first kept one; returns the reason fragment (`default audio now eng (#2)`), else null.
 */
function handDefault(
  type: 'audio' | 'subtitle',
  streams: StreamPlan[],
  model: BuildModel,
): string | null {
  const keptOnes = streams.filter((s) => s.keep);
  const first = keptOnes[0];
  const droppedDefault = streams.some((s) => !s.keep && s.default);
  if (!droppedDefault || first === undefined || keptOnes.some((s) => s.default)) return null;
  first.default = true;
  return `default ${type} now ${reasonTag(first)} (${ref(first, model)})`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const codecRefs = (streams: StreamPlan[], model: BuildModel) =>
  streams.map((s) => `${ref(s, model)} ${s.codec}`).join(', ');

const action: Pick<NodeDefinition, 'version' | 'kind' | 'inputs' | 'outputs'> = {
  version: 1,
  kind: 'action',
  inputs: [filePort],
  outputs: [filePort],
};

const targets = z.array(DeviceProfileIdSchema).default([]).describe('Target devices');

const actionWithLanguage: Pick<NodeDefinition, 'version' | 'kind' | 'inputs' | 'outputs'> = {
  ...action,
  inputs: [filePort, languageInput],
};

export const keepLanguages = defineNode({
  ...actionWithLanguage,
  type: 'core:keep-languages',
  title: 'Keep languages',
  description: 'Removes audio and subtitle tracks that are not in the chosen languages.',
  icon: 'languages',
  onNodeSettings: ['languages'],
  settings: z.object({
    languages: z.array(LanguageCodeSchema).default(['en']).describe('Languages to keep'),
    keepOriginal: z.boolean().default(true).describe('Keep the original language'),
    keepUntagged: z.boolean().default(true).describe('Keep tracks without a language tag'),
  }),
  async build(ctx, settings) {
    const model = copyModel(ctx.model);
    const original = settings.keepOriginal ? originalLanguage(ctx.data) : null;
    const codes = original === null ? settings.languages : [...settings.languages, original];
    const keeps = (s: StreamPlan) =>
      matchesLanguage(s, codes) ||
      (settings.keepUntagged && normalizeLanguage(s.language) === null);
    const audio = streamsOf(model, 'audio');
    const subtitles = streamsOf(model, 'subtitle');
    const keptAudio = audio.filter(keeps);
    const keptSubtitles = subtitles.filter(keeps);
    // Never leave a file that had audio without any.
    const keepAllAudio = audio.length > 0 && keptAudio.length === 0;
    for (const s of audio) s.keep = keepAllAudio || keeps(s);
    for (const s of subtitles) s.keep = keeps(s);
    // A dropped default hands its flag to the first kept track of its type (ruling R4).
    const newDefaults = [
      handDefault('audio', audio, model),
      handDefault('subtitle', subtitles, model),
    ].flatMap((d) => (d === null ? [] : [d]));
    const reason = [
      `audio: ${list(audio.map(reasonTag))} → kept ${list(keptAudio.map(reasonTag))}`,
      `subtitles: ${list(subtitles.map(reasonTag))} → kept ${list(keptSubtitles.map(reasonTag))}`,
      ...(keepAllAudio ? ['kept all audio (none matched)'] : []),
      ...newDefaults,
    ].join('; ');
    return {
      model,
      reason,
      findings: settings.keepOriginal ? { originalLanguage: original ?? 'unknown' } : {},
    };
  },
});

export const setDefaultTrack = defineNode({
  ...actionWithLanguage,
  type: 'core:set-default-track',
  title: 'Set default track',
  description: 'Marks the default audio and subtitle tracks by language preference.',
  icon: 'star',
  onNodeSettings: ['audioLanguages'],
  settings: z.object({
    audioLanguages: z
      .array(LanguageCodeSchema)
      .default(['en'])
      .describe('Audio languages in order of preference; the original language comes first'),
    subtitleLanguages: z
      .array(LanguageCodeSchema)
      .default([])
      .describe(
        'Subtitle languages in order of preference; empty means no default subtitle (an mp4 output still flags its first subtitle: the mp4 muxer always marks one)',
      ),
  }),
  async build(ctx, settings) {
    const model = copyModel(ctx.model);
    const audio = streamsOf(model, 'audio');
    let audioDefault: StreamPlan | null = null;
    if (audio.length > 0) {
      const original = originalLanguage(ctx.data);
      const listed =
        original !== null && matchesLanguage({ language: original }, settings.audioLanguages);
      const order = listed ? [original, ...settings.audioLanguages] : settings.audioLanguages;
      const defaults = audio.filter((s) => s.default);
      audioDefault =
        pickDefault(audio, order) ?? (defaults.length === 1 ? defaults[0] : audio[0]) ?? null;
      for (const s of audio) s.default = s === audioDefault;
    }
    const subtitles = streamsOf(model, 'subtitle');
    const subtitleDefault = pickDefault(subtitles, settings.subtitleLanguages);
    for (const s of subtitles) s.default = s === subtitleDefault;
    const name = (s: StreamPlan | null) =>
      s === null ? 'none' : `${reasonTag(s)} (${ref(s, model)})`;
    return {
      model,
      reason: `default audio: ${name(audioDefault)}; default subtitle: ${name(subtitleDefault)}`,
      findings: {
        audio: audioDefault?.sourceIndex ?? null,
        subtitle: subtitleDefault?.sourceIndex ?? null,
      },
    };
  },
});

export const reorderTracks = defineNode({
  ...action,
  type: 'core:reorder-tracks',
  title: 'Reorder tracks',
  description: 'Puts audio and subtitle tracks in language order.',
  icon: 'list-ordered',
  onNodeSettings: ['languages'],
  settings: z.object({
    languages: z.array(LanguageCodeSchema).default(['en']).describe('Language order'),
  }),
  async build(ctx, settings) {
    const model = copyModel(ctx.model);
    const out = kept(model);
    const audio = sortByLanguage(
      out.filter((s) => s.type === 'audio'),
      settings.languages,
    );
    const subtitles = sortByLanguage(
      out.filter((s) => s.type === 'subtitle'),
      settings.languages,
    );
    // Audio and subtitle slots are refilled in sorted order; every other stream keeps its slot.
    let a = 0;
    let t = 0;
    const arranged = out.map((s) => {
      if (s.type === 'audio') return audio[a++] ?? s;
      if (s.type === 'subtitle') return subtitles[t++] ?? s;
      return s;
    });
    setOrder(model, arranged);
    return {
      model,
      reason: `audio: ${list(audio.map(reasonTag))}; subtitles: ${list(subtitles.map(reasonTag))}`,
    };
  },
});

export const coverAttachments = defineNode({
  ...action,
  type: 'core:cover-attachments',
  title: 'Cover and attachments',
  description: 'Keeps or removes cover images and attachments.',
  icon: 'image',
  settings: z.object({
    keepCover: z.boolean().default(true).describe('Keep cover images'),
    keepAttachments: z.boolean().default(false).describe('Keep attachments such as fonts'),
  }),
  async build(ctx, settings) {
    const model = copyModel(ctx.model);
    const pieces: string[] = [];
    let fontsKeptForAss = false;
    if (!settings.keepCover) {
      const covers = streamsOf(model, 'video').filter((s) => s.attachedPic);
      for (const s of covers) s.keep = false;
      if (covers.length > 0) {
        pieces.push(`dropped ${plural(covers.length, 'cover', 'covers')} ${refs(covers, model)}`);
      }
    }
    if (!settings.keepAttachments) {
      // ASS/SSA subtitles render with their embedded fonts.
      const ass = streamsOf(model, 'subtitle').some((s) => ASS_CODECS.has(s.codec));
      const attachments = streamsOf(model, 'attachment');
      const fonts = ass ? attachments.filter((s) => FONT_CODECS.has(s.codec)) : [];
      const dropped = attachments.filter((s) => !fonts.includes(s));
      for (const s of dropped) s.keep = false;
      if (dropped.length > 0) {
        pieces.push(
          `dropped ${plural(dropped.length, 'attachment', 'attachments')} ${refs(dropped, model)}`,
        );
      }
      if (fonts.length > 0) {
        fontsKeptForAss = true;
        pieces.push(`kept fonts ${refs(fonts, model)} for ass subtitles`);
      }
    }
    return {
      model,
      reason: pieces.length > 0 ? pieces.join('; ') : 'nothing to change',
      findings: fontsKeptForAss ? { fontsKeptForAss } : {},
    };
  },
});

export const encodeVideo = defineNode({
  ...action,
  type: 'core:encode-video',
  title: 'Encode video',
  description: 'Re-encodes the video stream.',
  icon: 'video',
  // Encoder availability depends on the `encoder` setting value; per-setting
  // availability is for the engine track.
  // The card shows the first of these the editor shows: quality, or the bitrate in bitrate mode.
  onNodeSettings: ['quality', 'bitrateKbps'],
  version: 2,
  migrations: [keepBitrateAsBefore('Encode video')],
  settings: z.object({
    codec: z.enum(['hevc', 'h264', 'av1']).default('hevc').describe('Target codec'),
    encoder: z.string().default('auto').describe('Encoder (auto picks hardware first)'),
    rateControl: z
      .enum(['quality', 'bitrate'])
      .default('quality')
      .describe(
        'Rate control; quality keeps a constant quality (CRF, or CQ/QP on hardware), bitrate aims at the target bitrate',
      ),
    quality: z
      .number()
      .int()
      .min(0)
      .max(63)
      .default(24)
      .meta({
        description: 'Quality (CRF); lower is better',
        [SHOW_WHEN]: { rateControl: 'quality' },
      }),
    bitrateKbps: z
      .number()
      .int()
      .min(100)
      .max(200_000)
      .default(6000)
      .meta({ description: 'Target bitrate (kb/s)', [SHOW_WHEN]: { rateControl: 'bitrate' } }),
    neverIncreaseBitrate: z
      .boolean()
      .default(true)
      .describe(
        "Never above the source bitrate; caps the encode at the source video's bitrate (the whole file's when the stream has none)",
      ),
    preset: z.string().default('medium').describe('Encoder preset'),
    skipIf: z
      .enum(['never', 'already-target-codec', 'plays-on-all-targets'])
      .default('already-target-codec')
      .describe('Skip encoding when'),
    targets,
  }),
  async build(ctx, settings) {
    const { codec, targets } = settings;
    const encoder = resolveEncoder(codec, settings.encoder, ctx.capabilities);
    if (encoder === null) {
      throw new NodeHookError(
        settings.encoder === 'auto'
          ? `no ${codec} encoder is available`
          : `encoder ${settings.encoder} is not available`,
      );
    }
    const model = copyModel(ctx.model);
    addTargets(model, targets);
    // Posters and covers (JPEG tracks included, see isPicture) are copied, never encoded.
    const videos = streamsOf(model, 'video').filter((s) => {
      const src = sourceOf(ctx.probe, s);
      return src ? !isPicture(src, ctx.probe.streams) : !s.attachedPic;
    });
    if (videos.length === 0) return { model, reason: 'no video stream' };
    const reasons = videos.map((s) => {
      // What the stream will be as planned so far: an earlier node may already convert it.
      const converting = s.mode === 'convert';
      const from = converting ? s.codec : (sourceOf(ctx.probe, s)?.codec ?? s.codec);
      const skipped = converting
        ? `video already converted to ${from} → unchanged`
        : `video already ${from} → copy`;
      let reason: string;
      if (settings.skipIf === 'already-target-codec' && from === codec) {
        reason = skipped;
      } else if (
        settings.skipIf === 'plays-on-all-targets' &&
        targets.length > 0 &&
        planIssues(s, ctx.probe, targets).length === 0
      ) {
        reason = converting
          ? `video already converted to ${from}, plays on all targets → unchanged`
          : `video ${from} plays on all targets → copy`;
      } else {
        const pixelFormat =
          sourceOf(ctx.probe, s)?.bitDepth === 10 && codec === 'hevc' ? 'yuv420p10le' : 'yuv420p';
        const rate = videoRate(settings, encoder, sourceBitrate(ctx.probe, s));
        Object.assign(s, COPY, {
          mode: 'convert',
          codec,
          encoder,
          quality: rate.quality,
          bitrateKbps: rate.bitrateKbps,
          preset: settings.preset,
          pixelFormat,
        });
        reason = `video ${from} → ${codec} (${rate.how})${rate.note}`;
        if (settings.skipIf === 'plays-on-all-targets' && targets.length === 0) {
          reason += '; plays-on-all-targets has no targets to check';
        }
      }
      const issues = planIssues(s, ctx.probe, targets);
      if (issues.length > 0) throw unsupported(issues);
      return reason;
    });
    return { model, reason: reasons.join('; ') };
  },
});

export const encodeAudio = defineNode({
  ...action,
  type: 'core:encode-audio',
  title: 'Encode audio',
  description: 'Copies or re-encodes the audio streams.',
  icon: 'volume-2',
  requires: { encoders: ['aac'], filters: ['pan'] },
  version: 3,
  migrations: [keepBitrateAsBefore('Encode audio'), keepTitlesAsBefore],
  settings: z.object({
    mode: z.enum(['copy', 'reencode']).default('copy').describe('Mode'),
    codec: z.enum(['aac', 'ac3', 'opus']).default('aac').describe('Codec'),
    bitrateKbps: z.number().int().min(32).max(1024).default(160).describe('Bitrate (kb/s)'),
    neverIncreaseBitrate: z
      .boolean()
      .default(true)
      .describe(
        "Never above the source bitrate; a track is encoded at most at its source bitrate, when it's known",
      ),
    downmixTo: z.enum(['none', 'stereo']).default('none').describe('Downmix to'),
    updateTitles: z
      .boolean()
      .default(true)
      .describe(
        "Update track titles; a re-encoded track's title names its new format (codec, channels, bitrate) instead of the old one, and keeps its other words",
      ),
    targets,
    whenUnsupported: z
      .enum(['add-track', 'convert', 'fail'])
      .default('add-track')
      .describe('When a target cannot play a kept track'),
  }),
  async build(ctx, settings) {
    const { codec, bitrateKbps, targets } = settings;
    const encoder = AUDIO_ENCODERS[codec];
    const model = copyModel(ctx.model);
    addTargets(model, targets);
    const needEncoder = () => {
      if (!ctx.capabilities.encoders.includes(encoder)) {
        throw new NodeHookError(`encoder ${encoder} is not available`);
      }
    };
    const channelsOf = (s: StreamPlan) => s.channels ?? sourceOf(ctx.probe, s)?.channels ?? null;
    const describe = (s: StreamPlan) => {
      const channels = channelsOf(s);
      return `${s.codec}${channels === null ? '' : ` ${channels}ch`}`;
    };
    /** The set bitrate, or the source's when that is lower and the cap is on. */
    const bitrateOf = (s: StreamPlan) => {
      const source = settings.neverIncreaseBitrate
        ? wholeKbps(sourceOf(ctx.probe, s)?.bitrateKbps)
        : null;
      return source !== null && source < bitrateKbps ? source : bitrateKbps;
    };
    /** Converts `s`; its title follows unless it is an added copy, which is named on its own. */
    const convert = (s: StreamPlan, channels: number | null, ownTitle = false) => {
      const out = channels ?? channelsOf(s);
      const kbps = bitrateOf(s);
      Object.assign(s, COPY, { mode: 'convert', codec, encoder, bitrateKbps: kbps, channels });
      if (settings.updateTitles && !ownTitle) {
        s.title = retitle(s.title, { codec, channels: out, bitrateKbps: kbps });
      }
      return `${codec} ${kbps}k${out === null ? '' : ` ${out}ch`}`;
    };
    const issuesOf = (s: StreamPlan) => planIssues(s, ctx.probe, targets);
    const audio = streamsOf(model, 'audio');
    const pieces: string[] = [];
    if (settings.mode === 'reencode' && audio.length > 0) {
      needEncoder();
      const stereo = settings.downmixTo === 'stereo';
      for (const s of audio) {
        // Downmix only what has more than two channels (or an unknown count); mono stays mono.
        const channels = channelsOf(s);
        convert(s, stereo && (channels === null || channels > 2) ? 2 : null);
      }
      pieces.push(`audio ${refs(audio)} → ${codec} ${bitrateKbps}k${stereo ? ' 2ch' : ''}`);
      for (const s of audio) {
        if (s.bitrateKbps !== bitrateKbps) {
          pieces.push(`audio ${refs([s])} capped at its source ${s.bitrateKbps}k`);
        }
      }
    }
    const offending = audio.filter((s) => issuesOf(s).length > 0);
    const forTargets = `for ${targets.join(', ')}`;
    // Only the default audio must play everywhere (ruling R1); other tracks only warn, except
    // under 'convert', which converts every track a target cannot play.
    const main = defaultTracks(model).audio;
    if (settings.whenUnsupported === 'convert' && offending.length > 0) {
      needEncoder();
      const max = maxChannels(codec, targets);
      for (const s of offending) {
        const before = describe(s);
        const channels = channelsOf(s);
        const capped = channels !== null && max !== null && channels > max ? max : null;
        pieces.push(
          `audio #${s.sourceIndex} ${before}: converted to ${convert(s, capped)} ${forTargets}`,
        );
      }
      const issues = offending.flatMap(issuesOf);
      if (issues.length > 0) throw unsupported(issues);
    } else if (main !== null && offending.includes(main)) {
      if (settings.whenUnsupported === 'fail') throw unsupported(issuesOf(main));
      needEncoder();
      // add-track: a stereo copy of the default track, right after it, that becomes the default.
      const before = describe(main);
      const copy: StreamPlan = {
        ...main,
        title: `${tag(main)} (${codec})`,
        default: true,
        forced: false,
        dispositions: [],
      };
      const what = convert(copy, 2, true);
      main.default = false;
      const arranged = kept(model);
      arranged.splice(arranged.indexOf(main) + 1, 0, copy);
      model.streams.push(copy);
      setOrder(model, arranged);
      pieces.push(`audio #${main.sourceIndex} ${before}: added default ${what} copy ${forTargets}`);
      const issues = issuesOf(copy);
      if (issues.length > 0) throw unsupported(issues);
    }
    const warnings = warningsFor(model, ctx.probe, targets, 'audio');
    const findings = {
      ...(targets.length > 0 ? { unsupported: offending.map((s) => s.sourceIndex) } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    const reason = pieces.length > 0 ? pieces.join('; ') : 'audio copied';
    return { model, reason: withWarnings(reason, warnings), findings };
  },
});

export const remux = defineNode({
  ...action,
  type: 'core:remux',
  title: 'Remux',
  description: 'Moves the streams into another container without re-encoding.',
  icon: 'package',
  settings: z.object({
    container: z.enum(['mkv', 'mp4']).default('mkv').describe('Container'),
    subtitleConversion: z
      .enum(['keep', 'convert', 'drop-incompatible'])
      .default('convert')
      .describe(
        "Subtitle conversion ('keep' and 'convert': text subtitles are converted to the container's text format and image subtitles the container or targets cannot carry fail the job; 'drop-incompatible': Drop subtitles the container or targets cannot carry)",
      ),
    targets,
  }),
  async build(ctx, settings) {
    const { container, targets } = settings;
    const containerIssues = containerPlaysOn(container, targets);
    if (containerIssues.length > 0) throw unsupported(containerIssues);
    const model = copyModel(ctx.model);
    addTargets(model, targets);
    const dropIncompatible = settings.subtitleConversion === 'drop-incompatible';
    const pieces = [
      model.container === container
        ? `container ${container}`
        : `container ${model.container} → ${container}`,
    ];
    model.container = container;
    // Image subtitles cannot become text (no OCR): keep/convert asked to carry them, so fail.
    const image = streamsOf(model, 'subtitle').filter(
      (s) => container === 'mp4' && !TEXT_SUBTITLES.has(s.codec),
    );
    if (image.length > 0 && !dropIncompatible) {
      throw new NodeHookError(
        `mp4 cannot carry these subtitles: ${codecRefs(image, model)} (no OCR; use drop-incompatible)`,
      );
    }
    // Text subtitles convert to the container's text format; what it cannot hold is dropped.
    const fit = fitToContainer(model);
    if (fit.converted.length > 0) {
      pieces.push(`subtitles ${refs(fit.converted, model)} → ${fit.converted[0]?.codec}`);
    }
    if (fit.dropped.length > 0) {
      pieces.push(`dropped (container can't hold it): ${codecRefs(fit.dropped, model)}`);
    }
    // Ruling R1: the default subtitle must play on every target; others only warn, unless
    // drop-incompatible drops every subtitle a target cannot play.
    const unplayable = streamsOf(model, 'subtitle').filter(
      (s) => planIssues(s, ctx.probe, targets, streamLabel(model, s)).length > 0,
    );
    if (dropIncompatible && unplayable.length > 0) {
      for (const s of unplayable) s.keep = false;
      pieces.push(`dropped subtitles the targets cannot play: ${codecRefs(unplayable, model)}`);
    }
    const main = defaultTracks(model).subtitle;
    if (main !== null) {
      const issues = planIssues(main, ctx.probe, targets, streamLabel(model, main));
      if (issues.length > 0) throw unsupported(issues);
    }
    const warnings = warningsFor(model, ctx.probe, targets, 'subtitle');
    return {
      model,
      reason: withWarnings(pieces.join('; '), warnings),
      ...(warnings.length > 0 ? { findings: { warnings } } : {}),
    };
  },
});
