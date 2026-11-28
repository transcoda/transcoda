// The size gate's "Write track changes": the built plan with the video kept as it is. When the
// encode saves too little, the gate may still write every other planned change (tracks kept or
// dropped, default and forced flags, order, titles, container) as a remux. The rules are in
// docs/dev/engine.md, "Size gate: write track changes".
import { join } from 'node:path';
import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import type { ProbeStream } from '@transcoda/shared';
import type { JobRow } from '../../db/repos/jobs/jobs.ts';
import { retitle } from '../../nodes/core/audio-title.ts';
import {
  isExtraStream,
  isIdentity,
  normalizeDefaults,
  outputExtension,
  planIssues,
  renderCommandLine,
} from '../model/model.ts';
import type { JobControl } from '../queue/scheduler.ts';
import type { PipelineCore } from './core.ts';
import { encode } from './encode.ts';
import { verifyEncoded } from './output.ts';
import type { End, Prepared } from './types.ts';

/** What a stream becomes when it is copied as the source has it. */
const AS_COPY = {
  mode: 'copy',
  encoder: null,
  quality: null,
  preset: null,
  bitrateKbps: null,
  channels: null,
  profile: null,
  pixelFormat: null,
} as const satisfies Partial<StreamPlan>;

/** The source keeps every sample: any of the lossy codecs Encode audio writes is smaller. */
function lossless(src: ProbeStream): boolean {
  if (['truehd', 'mlp', 'flac', 'alac', 'wavpack', 'tta'].includes(src.codec)) return true;
  if (src.codec.startsWith('pcm_')) return true;
  return src.codec === 'dts' && /\bMA\b|master/i.test(src.profile ?? '');
}

/**
 * Whether a planned audio conversion makes the track smaller: a lossless source always, a lossy
 * one only at a lower bitrate than the source's. An unknown source bitrate cannot tell, so no.
 */
function shrinks(s: StreamPlan, src: ProbeStream): boolean {
  if (lossless(src)) return true;
  return s.bitrateKbps !== null && src.bitrateKbps !== null && s.bitrateKbps < src.bitrateKbps;
}

export interface TrackChanges {
  model: BuildModel;
  /** For each stream of `model`, the index in the built model's streams it comes from. */
  origins: number[];
}

/**
 * The built model with every video conversion turned into a stream copy and every other change
 * kept. A converted audio track is copied too, unless the conversion
 *
 * - makes it play on more of the plan's targets than the source track does, or
 * - plays on as many and makes the track smaller (a lossless source, or a lower bitrate than the
 *   source's known one).
 *
 * A conversion that plays on fewer targets than the source track is always undone, so the
 * result never plays on less than the source did. An added track (a second track made from one
 * source track, Encode audio's "add track") whose conversion is undone is left out, rather than
 * written as a duplicate; the default flag it took goes back to its source track. A title Encode
 * audio rewrote for the new format goes back to the source's. Pure: `model` is not changed.
 */
export function trackChangesOnly(model: BuildModel, probe: ProbeResult): TrackChanges {
  const sourceOf = (s: StreamPlan) =>
    isExtraStream(s) ? undefined : probe.streams.find((p) => p.index === s.sourceIndex);
  const streams: StreamPlan[] = [];
  const origins: number[] = [];
  /** The first plan of each source stream: an added track's source track. */
  const firstOf = new Map<number, StreamPlan>();
  const dropped: StreamPlan[] = [];
  for (const [i, s] of model.streams.entries()) {
    const first = !firstOf.has(s.sourceIndex);
    const out: StreamPlan = { ...s, dispositions: [...s.dispositions] };
    if (first) firstOf.set(s.sourceIndex, out);
    const src = sourceOf(s);
    if (s.keep && s.mode === 'convert' && src) {
      if (s.type === 'video') {
        // mkv and mp4 hold any video track (containerCanHold): the copy always fits.
        Object.assign(out, AS_COPY, { codec: src.codec });
      } else if (s.type === 'audio') {
        const copy: StreamPlan = { ...out, ...AS_COPY, codec: src.codec };
        const asCopy = planIssues(copy, probe, model.targets).length;
        const converted = planIssues(s, probe, model.targets).length;
        const keep = converted < asCopy || (converted === asCopy && shrinks(s, src));
        if (keep) {
          // The conversion stays as planned.
        } else if (!first) {
          dropped.push(out);
          continue;
        } else {
          const channels = s.channels ?? src.channels;
          const retitled = retitle(src.title, {
            codec: s.codec,
            channels,
            bitrateKbps: s.bitrateKbps,
          });
          Object.assign(out, AS_COPY, { codec: src.codec });
          if (s.title !== src.title && s.title === retitled) out.title = src.title;
        }
      }
    }
    streams.push(out);
    origins.push(i);
  }
  // An added track that is left out hands the default flag back to its source track.
  for (const d of dropped) {
    const source = firstOf.get(d.sourceIndex);
    if (d.default && source?.keep) {
      for (const s of streams) if (s.type === 'audio') s.default = false;
      source.default = true;
    }
  }
  return { model: { ...model, streams }, origins };
}

/**
 * The size gate's track changes for a job, with the default flags the output will have; null when
 * they change nothing compared with the source (the original is kept, as with Keep original).
 */
export function trackChangesFor(asBuilt: BuildModel, probe: ProbeResult): TrackChanges | null {
  const tc = trackChangesOnly(asBuilt, probe);
  if (isIdentity(tc.model, probe)) return null;
  normalizeDefaults(tc.model, probe);
  return tc;
}

/** The job's reason once a size gate wrote the track changes. */
export function trackChangesReason(why: string): string {
  return `${why} → wrote track changes without re-encoding`;
}

/** How writing the track changes ended. */
export type TrackChangesEnd =
  /** Rendered and verified: the output is the track changes now (`p.outputPath`). */
  | { kind: 'written'; job: JobRow; afterBytes: number }
  /** Nothing to write, or it could not be written: the original is kept as before. */
  | { kind: 'kept'; job: JobRow; note: string; warnings: string[] }
  /** The job ended meanwhile (a damaged source was recorded). */
  | { kind: 'end'; end: End };

/**
 * A size gate with Write track changes on a result that saved too little (`why`): renders the
 * plan's track changes (the video copied, see trackChangesOnly) in place of the encoded output,
 * with the same in-pass checks, then verifies it like any output. The encoded output is deleted
 * first. A failure here keeps the original with a warning: it is never retried, because a retry
 * would encode the whole file again. Throws Stop on a cancel or shutdown.
 */
export async function writeTrackChanges(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  why: string,
): Promise<TrackChangesEnd> {
  const tc = trackChangesFor(p.asBuilt, p.probe);
  if (tc === null) {
    return { kind: 'kept', job, note: 'nothing but the video would change', warnings: [] };
  }
  const cannot = (detail: string) => `could not write the track changes: ${detail}`;
  const before = {
    model: p.model,
    plan: p.plan,
    args: p.args,
    command: p.command,
    outputPath: p.outputPath,
    outputProbe: p.outputProbe,
  };
  const restore = () => {
    Object.assign(p, before);
    p.trackChanges = null;
  };
  const { fs, config } = core.deps;
  try {
    await fs.rm(p.outputPath, { recursive: true });
  } catch {
    // Only space: the temp dir goes with the job.
  }
  p.model = tc.model;
  p.plan = p.replan(tc.model, tc.origins);
  p.outputPath = join(p.tempDir, `tracks${outputExtension(tc.model.container)}`);
  p.outputProbe = null;
  p.trackChanges = { reason: trackChangesReason(why) };
  const args = core.renderFor(p, tc.model);
  if (args === null) {
    restore();
    const note = cannot('they cannot be rendered');
    return { kind: 'kept', job, note, warnings: [note] };
  }
  p.args = args;
  p.command = renderCommandLine(config.ffmpegPath, args);
  const failed = (end: End): TrackChangesEnd => {
    if (end.kind === 'settled') return { kind: 'end', end };
    const detail = end.kind === 'fail' ? end.failure.reason : end.reason;
    restore();
    return { kind: 'kept', job, note: cannot(detail), warnings: [cannot(detail)] };
  };
  job = core.update(job, ctl, { state: 'encoding', progress: null });
  const encoded = await encode(core, job, ctl, p);
  if (encoded !== null) return failed(encoded);
  job = core.update(job, ctl, { state: 'verifying', progress: null });
  await core.waitWhilePaused(ctl);
  const unverified = await verifyEncoded(core, job, ctl, p, false);
  if (unverified !== null) return failed(unverified);
  return { kind: 'written', job, afterBytes: (await fs.stat(p.outputPath)).size };
}
