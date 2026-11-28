// Output verification: re-probe the encoded file and check it against the build model before any
// replace. Every check runs and failures accumulate (except an unreadable output: probe only).
import type { BuildModel, ProbeResult } from '@transcoda/sdk';
import { DEVICE_PROFILES, isPicture, type ProbeStream } from '@transcoda/shared';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { probeFile } from '../media/probe.ts';
import { containerPlaysOn, streamPlaysOn, type TargetIssue } from '../model/model.ts';
import {
  DECODE_END_SECONDS,
  decodableStart,
  decode,
  decodeChecks,
  endSeek,
  mediaMaps,
  SAMPLE_SPOTS,
  spotTimes,
} from './decode-checks.ts';
import { durationCheck } from './durations.ts';
import { firstLine, mediaFile, mediaPairs, secs, verifyExec, withSignal } from './media.ts';
import { defaultFailures, sidecarFailures, streamFailures } from './stream-checks.ts';
import type { VerifyFailure, VerifyInput, VerifyResult } from './types.ts';

export type { VerifyProgress } from '../encode/progress.ts';
export type { VerifyFailure, VerifyInput, VerifyResult } from './types.ts';

/** A source header this much longer than every kept stream is stale (a warning). */
const STALE_GAP = 2;

/**
 * Container, every video stream, and the default audio (the first flagged, else the first audio)
 * and default subtitle (the first flagged) must play on every target; other tracks only warn.
 * Covers, attachments and data streams are exempt (streamPlaysOn). Levels are checked here only.
 */
function targetResults(
  model: BuildModel,
  probe: ProbeResult,
): { failures: VerifyFailure[]; warnings: string[] } {
  if (model.targets.length === 0) return { failures: [], warnings: [] };
  const audio = probe.streams.filter((s) => s.type === 'audio');
  const defaultAudio = audio.find((s) => s.default) ?? audio[0];
  const defaultSub = probe.streams.find((s) => s.type === 'subtitle' && s.default);
  const blocking = (s: ProbeStream) => s.type === 'video' || s === defaultAudio || s === defaultSub;
  const failures: VerifyFailure[] = containerPlaysOn(model.container, model.targets).map((i) => ({
    check: 'targets',
    message: i.message,
  }));
  const warnings: string[] = [];
  for (const s of probe.streams) {
    const issues: TargetIssue[] = streamPlaysOn(s, model.targets);
    if (blocking(s)) {
      failures.push(...issues.map((i) => ({ check: 'targets' as const, message: i.message })));
      continue;
    }
    for (const target of new Set(issues.map((i) => i.target))) {
      warnings.push(`${s.type} #${s.index} won't direct-play on ${DEVICE_PROFILES[target].name}`);
    }
  }
  return { failures, warnings };
}

/** Checks the written output against the plan; see the module comment and docs/dev/engine.md. */
export async function verifyOutput(input: VerifyInput): Promise<VerifyResult> {
  const exec = withSignal(input.exec ?? verifyExec, input.signal);
  let probe: ProbeResult;
  try {
    probe = await probeFile(input.outputPath, { ffprobePath: input.ffprobePath, exec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const e = err as { stderr?: unknown };
    const detail = firstLine(String(e.stderr ?? '')) ?? message;
    return {
      ok: false,
      kind: 'output-invalid',
      failures: [{ check: 'probe', message: `the output cannot be read: ${detail}` }],
      sourceFailures: [],
      probe: null,
      warnings: [],
    };
  }
  // The checks: this probe, each output media stream's end, decode start and end, and each spot.
  const total =
    1 +
    mediaPairs(input.model, probe).length +
    2 +
    spotTimes(probe, input.sampleSpots ?? SAMPLE_SPOTS).size;
  let done = 0;
  const tick = () => {
    done = Math.min(total, done + 1);
    input.onProgress?.({ stage: 'checks', done, total });
  };
  tick();
  const targets = targetResults(input.model, probe);
  const warnings = [...targets.warnings];
  const output = await mediaFile(exec, input.ffprobePath, input.outputPath, probe);
  const source = await mediaFile(exec, input.ffprobePath, input.sourcePath, input.sourceProbe);
  const decodable = await decodableStart(exec, input.ffprobePath, input.model, source);
  source.skipped = decodable - source.start;
  source.start = decodable;
  const duration = await durationCheck(exec, input.ffprobePath, input.model, source, output, tick);
  const stated = input.sourceProbe.durationSeconds;
  if (stated > 0 && duration.sourceEnds.length > 0) {
    const longest = Math.max(...duration.sourceEnds);
    if (stated - longest > STALE_GAP) {
      warnings.push(
        `the source header says ${secs(stated)}, but its streams end at ${secs(longest)}`,
      );
    }
  }
  const decoding = await decodeChecks(exec, input, source, output, tick);
  const others = [
    ...duration.failures,
    ...streamFailures(input.model, probe),
    ...sidecarFailures(input.model, probe),
    ...defaultFailures(probe),
  ];
  const failures = [...others, ...decoding.failures, ...targets.failures];
  if (failures.length === 0) return { ok: true, probe, warnings };
  // Only decode failures can be the source's fault, and only when each is matched on the source.
  const onlyDecode = failures.length === decoding.failures.length;
  const { explained, sourceFailures } = onlyDecode
    ? await decoding.attribute()
    : { explained: false, sourceFailures: [] };
  return {
    ok: false,
    kind: explained ? 'source-damaged' : 'output-invalid',
    failures,
    sourceFailures: explained ? sourceFailures : [],
    probe,
    warnings,
  };
}

/** A confirmation decode of the source starts this long before the spot… */
const CONFIRM_BEFORE = 1;

/** …and runs this long: the encoder's lookahead puts the output time seconds behind the decoder. */
const CONFIRM_SECONDS = 7;

/**
 * Decodes the source around each spot (output seconds where the encode reported a source-side
 * decoder error) and returns the failures: an error the source reproduces there confirms damage;
 * a run that could not start, was killed (the time or output limit) or could not read the file
 * confirms nothing.
 * mkv/mp4 sources are opened with input `-ss` (keyframe before the spot); byte-seek formats at the
 * anchor stream's last keyframe at or before it (`subfile`); a spot without one is not confirmed.
 */
export async function confirmSourceDamage(input: {
  sourcePath: string;
  sourceProbe: ProbeResult;
  ffmpegPath: string;
  ffprobePath: string;
  times: number[];
  /** How long each decode runs (default CONFIRM_SECONDS). */
  seconds?: number;
  exec?: Exec;
  signal?: AbortSignal;
}): Promise<VerifyFailure[]> {
  const seconds = input.seconds ?? CONFIRM_SECONDS;
  const exec = withSignal(input.exec ?? verifyExec, input.signal);
  const file = await mediaFile(exec, input.ffprobePath, input.sourcePath, input.sourceProbe);
  const streams = [...file.probe.streams].sort((a, b) => a.index - b.index);
  const anchor =
    streams.find((s) => s.type === 'video' && !isPicture(s, streams)) ??
    streams.find((s) => s.type === 'audio');
  const failures: VerifyFailure[] = [];
  const spots = [
    ...new Set(input.times.map((t) => Math.max(0, Math.round((t - CONFIRM_BEFORE) * 10) / 10))),
  ];
  for (const from of spots) {
    let open: string[] | null;
    let where = `${seconds} s from ${secs(from)}`;
    if (!file.byteSeek) {
      open = ['-ss', from.toFixed(3), '-t', String(seconds), '-i', file.path];
    } else if (anchor) {
      const seek = await endSeek(
        exec,
        input.ffprobePath,
        file,
        anchor.index,
        from + DECODE_END_SECONDS,
      );
      if (seek) {
        const i = seek.args.indexOf('-i');
        open = [...seek.args.slice(0, i), '-t', String(seconds), ...seek.args.slice(i)];
        where = `${seconds} s from ${secs(seek.from)}`;
      } else open = null;
    } else open = null;
    if (!open) continue;
    const f = await decode(
      exec,
      input.ffmpegPath,
      'decode-sample',
      { input: open, maps: mediaMaps(file.probe, file.byteSeek), where },
      'source: ',
    );
    // Only a decode error confirms: a timeout or a read error says nothing about the file.
    if (f?.decodeError) failures.push(f.failure);
  }
  return failures;
}
