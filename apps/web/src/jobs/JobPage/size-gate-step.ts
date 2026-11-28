// The Size gate's step sentence on the job page: what it measured and what it did (or would do).
import type { JsonValue } from '@transcoda/shared';
import type { Decision } from '../../editor/trace/trace-overlay.ts';

const num = (v: JsonValue | undefined): number | null => (typeof v === 'number' ? v : null);

/**
 * `past`: the step ran (a real run, or a test encode that measured it); `replaces`: a Replace
 * original follows, so a test encode's Yes says "replace the original".
 */
export function sizeGateSentence(
  d: Decision,
  dryRun: boolean,
  past: boolean,
  replaces: boolean,
): string {
  const min = num(d.findings.minSavingPercent) ?? num(d.settings.minSavingPercent) ?? 10;
  const saved = num(d.findings.savedPercent);
  const how = (n: number) =>
    n < 0
      ? `${-n}% bigger (at least ${min}% smaller needed)`
      : `only ${n}% smaller (at least ${min}% needed)`;
  // Saved too little, but the gate wrote (or would write) the track changes and went on to Yes.
  if (d.findings.trackChanges === true && d.branch === 'pass') {
    if (saved === null)
      return 'Only the track changes were written, so there was nothing to measure';
    if (dryRun) {
      return `The test encode came out ${how(saved)}, so a real run would keep the video as it is and write only the track changes`;
    }
    const was = past ? 'was' : 'is';
    return `The result ${was} ${how(saved)}, so the video ${was} kept as it is and only the track changes ${past ? 'were' : 'are'} written`;
  }
  if (dryRun && saved !== null && (d.branch === 'pass' || d.branch === 'else')) {
    // A test encode measured it: what a real run would then do.
    const would =
      d.branch === 'else'
        ? 'keep the original'
        : replaces
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
  if (d.settings.belowMinimum === 'write-track-changes') {
    return `Keeps the result only if it is at least ${min}% smaller; otherwise writes only the track changes`;
  }
  return `Keeps the result only if it is at least ${min}% smaller`;
}
