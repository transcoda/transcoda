// Device target checks (option A: one output must play directly on every selected target). Pure
// over the shared DEVICE_PROFILES data; the engine reports issues and never switches codecs.
import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import {
  DEVICE_PROFILES,
  type DeviceProfile,
  type DeviceProfileId,
  isPicture,
  normalizeProfile,
  type ProbeStream,
} from '@transcoda/shared';
import { extraInputOf, isExtraStream, kept } from './build-model.ts';
import { yuv420Depth } from './render.ts';

export type TargetIssue = {
  target: DeviceProfileId;
  streamIndex: number | null;
  kind:
    | 'video-codec'
    | 'video-profile'
    | 'video-level'
    | 'bit-depth'
    | 'hdr'
    | 'audio-codec'
    | 'audio-channels'
    | 'subtitle-format'
    | 'container';
  message: string;
};

/** The values a stream has in the output; null means unknown (not checked). */
interface OutputStream {
  index: number;
  type: StreamPlan['type'];
  attachedPic: boolean;
  codec: string;
  /** normalizeProfile form */
  profile: string | null;
  level: number | null;
  bitDepth: number | null;
  /** Set when the output pixel format is not 4:2:0 at a known depth (no profile plays it). */
  unsupportedPixelFormat: string | null;
  hdr: ProbeStream['hdr'];
  channels: number | null;
  /** How messages name the stream (`subtitle Show.fr.sup`); else `<type> #<index>`. */
  label?: string | undefined;
}

type Problem = { kind: TargetIssue['kind']; what: string };

function issue(profile: DeviceProfile, streamIndex: number | null, p: Problem): TargetIssue {
  return {
    target: profile.id,
    streamIndex,
    kind: p.kind,
    message: `${profile.name} cannot play ${p.what}`,
  };
}

/** A profile entry by codec name; never an inherited Object property ('constructor'). */
function own<T>(table: Record<string, T>, codec: string): T | undefined {
  return Object.hasOwn(table, codec) ? table[codec] : undefined;
}

/** Cover art, attachments and data streams are never checked. */
function exempt(s: { type: StreamPlan['type']; attachedPic: boolean }): boolean {
  return s.attachedPic || s.type === 'attachment' || s.type === 'data';
}

function videoProblems(s: OutputStream, profile: DeviceProfile): Problem[] {
  const name = s.label ?? `video #${s.index}`;
  const caps = own(profile.video, s.codec);
  if (!caps) return [{ kind: 'video-codec', what: `${name}: ${s.codec}` }];
  const problems: Problem[] = [];
  if (s.profile !== null && !caps.profiles.includes(s.profile)) {
    problems.push({ kind: 'video-profile', what: `${name}: ${s.codec} profile ${s.profile}` });
  }
  if (s.level !== null && s.level > caps.maxLevel) {
    problems.push({
      kind: 'video-level',
      what: `${name}: ${s.codec} level ${s.level} (max ${caps.maxLevel})`,
    });
  }
  if (s.unsupportedPixelFormat !== null) {
    problems.push({ kind: 'bit-depth', what: `${name}: pixel format ${s.unsupportedPixelFormat}` });
  } else if (s.bitDepth !== null && !caps.bitDepths.includes(s.bitDepth)) {
    problems.push({ kind: 'bit-depth', what: `${name}: ${s.bitDepth}-bit ${s.codec}` });
  }
  if (s.hdr !== null && s.hdr !== 'none' && !caps.hdr.includes(s.hdr)) {
    problems.push({ kind: 'hdr', what: `${name}: ${s.hdr} ${s.codec}` });
  }
  return problems;
}

function problemsOn(s: OutputStream, profile: DeviceProfile): Problem[] {
  if (exempt(s)) return [];
  if (s.type === 'video') return videoProblems(s, profile);
  if (s.type === 'audio') {
    const caps = own(profile.audio, s.codec);
    if (!caps)
      return [{ kind: 'audio-codec', what: `${s.label ?? `audio #${s.index}`}: ${s.codec}` }];
    if (s.channels !== null && s.channels > caps.maxChannels) {
      return [
        {
          kind: 'audio-channels',
          what: `${s.label ?? `audio #${s.index}`}: ${s.channels} channels (max ${caps.maxChannels} for ${s.codec})`,
        },
      ];
    }
    return [];
  }
  if (s.type === 'subtitle' && !profile.subtitles.includes(s.codec)) {
    return [{ kind: 'subtitle-format', what: `${s.label ?? `subtitle #${s.index}`}: ${s.codec}` }];
  }
  return [];
}

function check(s: OutputStream, targets: DeviceProfileId[]): TargetIssue[] {
  return targets.flatMap((t) => {
    const profile = DEVICE_PROFILES[t];
    return problemsOn(s, profile).map((p) => issue(profile, s.index, p));
  });
}

function fromProbe(s: ProbeStream): OutputStream {
  return {
    index: s.index,
    type: s.type,
    attachedPic: s.attachedPic,
    codec: s.codec,
    profile: normalizeProfile(s.profile),
    level: s.level,
    bitDepth: s.bitDepth,
    unsupportedPixelFormat: null,
    hdr: s.hdr,
    channels: s.channels,
  };
}

/**
 * A planned stream's output values. Copy mode: the probed values. Convert mode: the planned
 * codec and profile; bit depth from the planned pixel format (as renderArgs reads it), else the
 * source's; the level is the encoder's choice (unknown); HDR is the source's (conservative);
 * channels are the planned count, else the source's.
 */
function fromPlan(s: StreamPlan, source: ProbeStream | undefined): OutputStream {
  const base: OutputStream = source
    ? fromProbe(source)
    : {
        index: s.sourceIndex,
        type: s.type,
        attachedPic: false,
        codec: s.codec,
        profile: null,
        level: null,
        bitDepth: null,
        unsupportedPixelFormat: null,
        hdr: null,
        channels: null,
      };
  const out: OutputStream = {
    ...base,
    index: s.sourceIndex,
    type: s.type,
    attachedPic: s.attachedPic,
    codec: s.codec,
  };
  if (s.mode === 'copy') return out;
  const depth = s.pixelFormat === null ? out.bitDepth : yuv420Depth(s.pixelFormat);
  return {
    ...out,
    profile: s.profile,
    level: null,
    bitDepth: depth,
    unsupportedPixelFormat:
      s.type === 'video' && s.pixelFormat !== null && depth === null ? s.pixelFormat : null,
    channels: s.channels ?? out.channels,
  };
}

/** `subtitle Show.fr.sup` for a stream from an extra input file; undefined for a source stream. */
export function streamLabel(model: BuildModel, s: StreamPlan): string | undefined {
  const file = extraInputOf(model, s)?.label.file;
  return file === undefined ? undefined : `${s.type} ${file}`;
}

/**
 * Target issues of one planned stream (post-conversion values), whatever its role in the file.
 * `label` names the stream in messages (see {@link streamLabel}); default `<type> #<index>`.
 */
export function planIssues(
  s: StreamPlan,
  probe: ProbeResult,
  targets: DeviceProfileId[],
  label?: string,
): TargetIssue[] {
  // An extra-input stream has no probe stream (its sourceIndex is negative).
  const source = isExtraStream(s)
    ? undefined
    : probe.streams.find((p) => p.index === s.sourceIndex);
  const out = fromPlan(s, source);
  // A poster track (isPicture) is exempt like a flagged cover: it is copied, never played as video.
  if (source && isPicture(source, probe.streams)) out.attachedPic = true;
  return check({ ...out, label }, targets);
}

/**
 * The tracks a player starts with: the first kept audio flagged default (else the first kept
 * audio, which players pick when none is flagged) and the first kept subtitle flagged default
 * (none when no subtitle is flagged: subtitles stay off).
 */
export function defaultTracks(model: BuildModel): {
  audio: StreamPlan | null;
  subtitle: StreamPlan | null;
} {
  const out = kept(model);
  const audio = out.filter((s) => s.type === 'audio');
  return {
    audio: audio.find((s) => s.default) ?? audio[0] ?? null,
    subtitle: out.find((s) => s.type === 'subtitle' && s.default) ?? null,
  };
}

/** Video streams and the default audio and subtitle must play; other tracks only warn. */
function blocks(s: StreamPlan, defaults: ReturnType<typeof defaultTracks>): boolean {
  return s.type === 'video' || s === defaults.audio || s === defaults.subtitle;
}

/**
 * What stops the output playing directly on every target (option A, controller ruling R1): the
 * container, every video stream, and the default audio and default subtitle track. Pure over the
 * model (post-conversion values) and the profiles. Cover art (`attachedPic`), attachments and data
 * streams are exempt. Non-default tracks a target cannot play are `targetWarnings`, not issues.
 */
export function checkModelAgainstTargets(
  model: BuildModel,
  probe: ProbeResult,
  targets: DeviceProfileId[],
): TargetIssue[] {
  const defaults = defaultTracks(model);
  return [
    ...containerPlaysOn(model.container, targets),
    ...kept(model)
      .filter((s) => blocks(s, defaults))
      .flatMap((s) => planIssues(s, probe, targets, streamLabel(model, s))),
  ];
}

/**
 * Non-default kept audio and subtitle tracks some target cannot play: allowed (the player starts
 * on the default tracks), reported once per track and target as
 * `<type> #<index> won't direct-play on <profile name>`.
 */
export function targetWarnings(
  model: BuildModel,
  probe: ProbeResult,
  targets: DeviceProfileId[],
): TargetIssue[] {
  const defaults = defaultTracks(model);
  return kept(model)
    .filter((s) => !blocks(s, defaults))
    .flatMap((s) => {
      const label = streamLabel(model, s);
      const issues = planIssues(s, probe, targets, label);
      return targets.flatMap((t) => {
        const first = issues.find((i) => i.target === t);
        if (!first) return [];
        const name = DEVICE_PROFILES[t].name;
        const which = label ?? `${s.type} #${s.sourceIndex}`;
        return [{ ...first, message: `${which} won't direct-play on ${name}` }];
      });
    });
}

/** Does this probed stream already play on every target? (skip rules and verify). Same exemptions; profiles compared in `normalizeProfile` form. */
export function streamPlaysOn(stream: ProbeStream, targets: DeviceProfileId[]): TargetIssue[] {
  return check(fromProbe(stream), targets);
}

export function containerPlaysOn(container: string, targets: DeviceProfileId[]): TargetIssue[] {
  return targets.flatMap((t) => {
    const profile = DEVICE_PROFILES[t];
    return (profile.containers as string[]).includes(container)
      ? []
      : [issue(profile, null, { kind: 'container', what: `${container} files` })];
  });
}

function settingIssues(
  targets: DeviceProfileId[],
  kind: TargetIssue['kind'],
  what: string,
  plays: (p: DeviceProfile) => boolean,
): TargetIssue[] {
  return targets.flatMap((t) => {
    const profile = DEVICE_PROFILES[t];
    return plays(profile) ? [] : [issue(profile, null, { kind, what })];
  });
}

/** Static check of node settings (editor-time): e.g. codec 'hevc' with targets ['chrome'] → 'Chrome (desktop) cannot play hevc'. */
export function checkEncodeVideoSettings(s: {
  codec: string;
  targets: DeviceProfileId[];
}): TargetIssue[] {
  return settingIssues(
    s.targets,
    'video-codec',
    s.codec,
    (p) => own(p.video, s.codec) !== undefined,
  );
}

export function checkEncodeAudioSettings(s: {
  codec: string;
  targets: DeviceProfileId[];
}): TargetIssue[] {
  return settingIssues(
    s.targets,
    'audio-codec',
    s.codec,
    (p) => own(p.audio, s.codec) !== undefined,
  );
}

export function checkRemuxSettings(s: {
  container: 'mkv' | 'mp4';
  targets: DeviceProfileId[];
}): TargetIssue[] {
  return containerPlaysOn(s.container, s.targets);
}
