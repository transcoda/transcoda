// What one build hook changed in the build model, for the trace (`TraceEntry.changes`): the job
// screens word each step from it instead of reading the hook's reason.
import type { BuildModel, StreamPlan } from '@transcoda/sdk';
import type { TraceChanges } from '@transcoda/shared';
import { extraInputOf, kept } from './build-model.ts';

type Changed = TraceChanges['dropped'][number];
type Converted = TraceChanges['converted'][number];

/** The fields that say how a stream is encoded (`converted` when any differs). */
const ENCODING = [
  'mode',
  'codec',
  'encoder',
  'quality',
  'preset',
  'bitrateKbps',
  'channels',
  'profile',
  'pixelFormat',
] as const satisfies readonly (keyof StreamPlan)[];

/** The fields that land in the output as metadata or flags (`other` when any differs). */
const METADATA = [
  'language',
  'title',
  'forced',
  'attachedPic',
  'dispositions',
] as const satisfies readonly (keyof StreamPlan)[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changed(model: BuildModel, s: StreamPlan): Changed {
  const file = extraInputOf(model, s)?.label.file;
  return {
    index: s.sourceIndex,
    type: s.type,
    codec: s.codec,
    language: s.language,
    forced: s.forced,
    ...(file === undefined ? {} : { file }),
  };
}

function converted(model: BuildModel, s: StreamPlan, from: string): Converted {
  return {
    ...changed(model, s),
    from,
    encoder: s.encoder,
    quality: s.quality,
    preset: s.preset,
    bitrateKbps: s.bitrateKbps,
    channels: s.channels,
    pixelFormat: s.pixelFormat,
  };
}

/**
 * Pairs each stream after the hook with the one it was before: the n-th stream of a source (its
 * `sourceIndex` and `input`) with the n-th before, so a copy added from the same source (Encode
 * audio's added track) has no pair. Hooks work on copies, so object identity cannot pair them.
 */
const sourceKey = (s: StreamPlan) => `${s.input ?? 0}#${s.sourceIndex}`;

function pair(before: BuildModel, after: BuildModel): Map<StreamPlan, StreamPlan | null> {
  const key = sourceKey;
  const pool = new Map<string, StreamPlan[]>();
  for (const s of before.streams) pool.set(key(s), [...(pool.get(key(s)) ?? []), s]);
  return new Map(after.streams.map((s) => [s, pool.get(key(s))?.shift() ?? null]));
}

/**
 * The difference `after` makes to `before` in what would be written: dropped, added, converted and
 * re-flagged streams, the order of the kept ones, the container, and anything else (metadata, flags,
 * ffmpeg options). The model's targets are left out: they change what verify checks, not the file.
 */
export function modelChanges(before: BuildModel, after: BuildModel): TraceChanges {
  const pairs = pair(before, after);
  const paired = new Set([...pairs.values()].filter((s) => s !== null));
  const out: TraceChanges = {
    dropped: [],
    added: [],
    converted: [],
    defaults: [],
    reordered: false,
    other: false,
  };
  if (before.container !== after.container) {
    out.container = { from: before.container, to: after.container };
  }
  for (const s of before.streams) {
    // A stream the hook took out of the model altogether is dropped too.
    if (s.keep && !paired.has(s)) out.dropped.push(changed(before, s));
  }
  for (const [s, was] of pairs) {
    if (!was?.keep) {
      // An added copy was its source's codec before it was converted.
      const source = was ?? before.streams.find((b) => sourceKey(b) === sourceKey(s));
      if (s.keep) out.added.push(converted(after, s, source?.codec ?? s.codec));
      continue;
    }
    if (!s.keep) {
      out.dropped.push(changed(before, was));
      continue;
    }
    if (ENCODING.some((k) => !same(s[k], was[k])))
      out.converted.push(converted(after, s, was.codec));
    if (s.default !== was.default) {
      out.defaults.push({ ...changed(after, s), before: was.default, after: s.default });
    }
    if (METADATA.some((k) => !same(s[k], was[k]))) out.other = true;
  }
  // The order of the streams kept on both sides, among themselves (an added stream moves no other).
  const afterOrder = kept(after).flatMap((s) => {
    const was = pairs.get(s);
    return was?.keep ? [was] : [];
  });
  const beforeOrder = kept(before).filter((s) => afterOrder.includes(s));
  out.reordered = afterOrder.some((s, i) => beforeOrder[i] !== s);
  const recycles = (m: BuildModel) => (m.extraInputs ?? []).map((e) => e.afterReplace);
  if (
    !same(before.inputArgs, after.inputArgs) ||
    !same(before.globalArgs, after.globalArgs) ||
    recycles(before).some((r, i) => recycles(after)[i] !== r)
  ) {
    out.other = true;
  }
  return out;
}
