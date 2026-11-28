// What a plugin build hook changed in the model: the extra input files it must leave alone, and
// the video encoders it picked.
import type { BuildModel } from '@transcoda/sdk';
import { type AutoPick, isExtraStream } from '../model/model.ts';

/**
 * What a plugin build hook must leave alone: the extra input files and which streams read them.
 * Extra-stream pairs are sorted so a re-sorted array is not a change; source streams are checked
 * apart (none may read an input), so dropping or re-ordering them is not one either.
 */
export function inputFilesOf(model: BuildModel): string {
  return JSON.stringify([
    model.extraInputs ?? [],
    model.streams
      .filter(isExtraStream)
      .map((s) => [s.sourceIndex, s.input])
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
  ]);
}

/** A stream that is not from an extra input must not claim an `input` (a re-pointed stream). */
export function repointsSourceStream(model: BuildModel): boolean {
  return model.streams.some((s) => !isExtraStream(s) && (s.input ?? 0) !== 0);
}

/**
 * The kept video streams in convert mode that `after` encodes differently from `before`: a new
 * encoder, or newly converted. Streams match by source index and input file.
 */
export function picksOf(before: BuildModel, after: BuildModel): AutoPick[] {
  const picks: AutoPick[] = [];
  for (const s of after.streams) {
    if (!(s.keep && s.type === 'video' && s.mode === 'convert' && s.encoder !== null)) continue;
    const input = s.input ?? 0;
    const was = before.streams.find(
      (b) => b.sourceIndex === s.sourceIndex && (b.input ?? 0) === input,
    );
    if (was?.mode === 'convert' && was.encoder === s.encoder) continue;
    picks.push({ sourceIndex: s.sourceIndex, input, encoder: s.encoder });
  }
  return picks;
}
