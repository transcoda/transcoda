import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import { type ProbeStream, sameLanguage } from '@transcoda/shared';
import { extraInputOf, isExtraStream, isMkvCover, outputOrder } from '../model/model.ts';
import type { VerifyFailure } from './types.ts';

// The stream checks: the output's streams, sidecar subtitles and default flags against the model.

/** Plan and output stream are a source cover and the mkv attachment it was written as. */
function coverMatches(out: ProbeStream, plan: StreamPlan): boolean {
  return (
    (out.type === 'attachment' || (out.type === 'video' && out.attachedPic)) &&
    out.codec === plan.codec
  );
}

function lang(l: string | null): string {
  return l ?? 'und';
}

/** Differences between a kept stream and the output stream at its position. */
function streamMismatches(model: BuildModel, plan: StreamPlan, out: ProbeStream): string[] {
  const file = extraInputOf(model, plan)?.label.file;
  const name = `output #${out.index} (${
    file === undefined ? `${plan.type} #${plan.sourceIndex}` : `${plan.type} from ${file}`
  })`;
  if (isMkvCover(model, plan)) {
    return coverMatches(out, plan)
      ? []
      : [`${name}: expected cover ${plan.codec}, got ${out.type} ${out.codec}`];
  }
  if (out.type !== plan.type) return [`${name}: expected ${plan.type}, got ${out.type}`];
  if (plan.type === 'data') return [];
  const problems: string[] = [];
  if (out.codec !== plan.codec) problems.push(`codec ${out.codec}, expected ${plan.codec}`);
  const sameLang =
    (plan.language === null && out.language === null) || sameLanguage(plan.language, out.language);
  if (!sameLang) problems.push(`language ${lang(out.language)}, expected ${lang(plan.language)}`);
  const flag = (what: string, want: boolean, got: boolean) => {
    if (want !== got)
      problems.push(want ? `not ${what}, expected ${what}` : `${what}, expected not ${what}`);
  };
  flag('default', plan.default, out.default);
  flag('forced', plan.forced, out.forced);
  flag('attached_pic', plan.attachedPic, out.attachedPic);
  return problems.map((p) => `${name}: ${p}`);
}

/**
 * An mp4 muxer writes the chapters as a QuickTime chapter track of its own (a `bin_data` data
 * stream), whether or not the source had one, so on an mp4 those tracks are left out of the
 * comparison on both sides. An mkv keeps its chapters in the container and counts every stream.
 */
function chapterTrack(model: BuildModel, s: { type: string; codec: string }): boolean {
  return model.container === 'mp4' && s.type === 'data' && s.codec === 'bin_data';
}

/** The kept streams against the output's, in order: count, then type, codec, language and flags. */
export function streamFailures(model: BuildModel, probe: ProbeResult): VerifyFailure[] {
  const plans = outputOrder(model).filter((s) => !chapterTrack(model, s));
  const outs = [...probe.streams]
    .sort((a, b) => a.index - b.index)
    .filter((s) => !chapterTrack(model, s));
  const failures: VerifyFailure[] = [];
  if (plans.length !== outs.length) {
    failures.push({
      check: 'stream-count',
      message: `output has ${outs.length} streams, the plan keeps ${plans.length}`,
    });
  }
  plans.forEach((plan, i) => {
    const out = outs[i];
    if (!out) return;
    for (const message of streamMismatches(model, plan, out)) {
      failures.push({ check: 'stream-match', message });
    }
  });
  return failures;
}

/**
 * Every sidecar stream the plan keeps must be in the output as a subtitle with its language tag
 * at its position. That only confirms the track and its tag survived: ffprobe cannot tell
 * whether the subtitle's text is really in that language (the tag comes from the file name).
 * Counted apart from stream-match so a lost sidecar reads as what it is.
 */
export function sidecarFailures(model: BuildModel, probe: ProbeResult): VerifyFailure[] {
  const plans = outputOrder(model);
  const outs = [...probe.streams].sort((a, b) => a.index - b.index);
  const sidecars = plans.filter(isExtraStream);
  if (sidecars.length === 0) return [];
  const present = plans.filter((plan, i) => {
    const out = outs[i];
    return (
      isExtraStream(plan) &&
      out?.type === 'subtitle' &&
      ((plan.language === null && out.language === null) ||
        sameLanguage(plan.language, out.language))
    );
  });
  return present.length === sidecars.length
    ? []
    : [
        {
          check: 'sidecars',
          message: `embedded ${present.length} of ${sidecars.length} subtitle files`,
        },
      ];
}

/** Exactly one default audio when the output has audio; at most one default subtitle. */
export function defaultFailures(probe: ProbeResult): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const audio = probe.streams.filter((s) => s.type === 'audio');
  const audioDefaults = audio.filter((s) => s.default).length;
  if (audio.length > 0 && audioDefaults !== 1) {
    failures.push({
      check: 'defaults',
      message: `${audioDefaults} default audio tracks, expected exactly one`,
    });
  }
  const subDefaults = probe.streams.filter((s) => s.type === 'subtitle' && s.default).length;
  if (subDefaults > 1) {
    failures.push({
      check: 'defaults',
      message: `${subDefaults} default subtitle tracks, expected at most one`,
    });
  }
  return failures;
}
