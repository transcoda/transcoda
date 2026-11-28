// The ffmpeg run: progress, the stall guard, the in-pass checks of its error lines (output
// errors, source damage, read errors, the frame count) and the GPU fallbacks; the cover copy's
// time limit and failure text.

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult, StreamPlan } from '@transcoda/sdk';
import type { JobRow } from '../../db/repos/jobs/jobs.ts';
import { errorCode } from '../../platform/fs-ops.ts';
import type { ProgressSample } from '../encode/progress.ts';
import { toJobProgress, withFrameTime } from '../encode/progress.ts';
import {
  noOutputReason,
  OutputStallGuard,
  stoppedOutputReason,
  watchForStall,
} from '../encode/stall-guard.ts';
import { classifyErrorLine, READ_FAILURE, sourceDecoderNames } from '../media/decoder-names.ts';
import {
  ffmpegFailure,
  isMkvCover,
  kept,
  looksLikeGpuFailure,
  outputOrder,
  renderCommandLine,
  renderEncoders,
  softwareFallback,
} from '../model/model.ts';
import type { JobControl } from '../queue/scheduler.ts';
import { confirmSourceDamage } from '../verify/verify.ts';
import { sourceDamaged } from './branches.ts';
import type { PipelineCore } from './core.ts';
import { pictureOf } from './plan.ts';
import {
  type End,
  fail,
  final,
  message,
  PROGRESS_INTERVAL_MS,
  type Prepared,
  retryable,
  TRYING_ANOTHER_GPU,
} from './types.ts';

/** Error lines kept for a reason or a warning. */
const MAX_ERROR_LINES = 3;
/** Bytes read from the end of a job log for a failure reason. */
const REASON_TAIL_BYTES = 8 * 1024;
/** A source frame count may differ from the output's by this many frames… */
const FRAME_SLACK = 2;
/** …or this fraction of the count, whichever is larger. */
const FRAME_TOLERANCE = 0.005;

/** The last `bytes` of a file as text (from the next full line); '' when it does not exist. */
export async function readTail(path: string, bytes: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return '';
    throw err;
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? text : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

/** A stream's exact frame count (`nb_frames`) and mkvmerge's NUMBER_OF_FRAMES tag (only advisory). */
function sourceFrameCounts(
  probe: ProbeResult,
  index: number,
): { exact: number | null; tag: number | null } {
  const raw = (probe.raw ?? {}) as { streams?: unknown };
  const streams = Array.isArray(raw.streams) ? (raw.streams as Record<string, unknown>[]) : [];
  const s = streams.find((x) => Number(x.index) === index);
  const count = (v: unknown): number | null => {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
    return n !== null && n > 0 ? n : null;
  };
  if (!s) return { exact: null, tag: null };
  const tags = (s.tags ?? {}) as Record<string, unknown>;
  return {
    exact: count(s.nb_frames),
    tag: count(tags.NUMBER_OF_FRAMES) ?? count(tags['NUMBER_OF_FRAMES-eng']),
  };
}

/**
 * Runs ffmpeg and the in-pass checks; null when the output may be verified. Decoder errors
 * before the first output frame (a stream cut mid-GOP) are ignored; a later source-side error
 * keeps the original only when the source reproduces it at that spot.
 */
export async function encode(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
): Promise<End | null> {
  const { config } = core.deps;
  const encoders = renderEncoders(p.model);
  const sourceCodecs = sourceDecoderNames(p.probe.streams.map((s) => s.codec));
  let last: ProgressSample | null = null;
  let lastWrite = Number.NEGATIVE_INFINITY;
  let framesOut = false;
  /** How far the output got: the furthest out time, or frames over the frame rate without one. */
  let reached: number | null = null;
  // `frame=` counts the first video stream ffmpeg writes (see withFrameTime).
  const firstVideo = outputOrder(p.model).find(
    (s) => s.type === 'video' && !isMkvCover(p.model, s),
  );
  const frameRate =
    p.probe.streams.find((s) => s.index === firstVideo?.sourceIndex)?.frameRate ?? null;
  let leading = 0;
  let unplaced = 0;
  const sourceErrors: { line: string; at: number }[] = [];
  const demuxerErrors: { line: string; at: number }[] = [];
  const outputErrors: string[] = [];
  // The stall guard (TRANSCODA_ENCODE_STALL_MINUTES, 0 = off): no more output for that long
  // stops ffmpeg, so a stuck muxer cannot hold the source in memory for hours.
  const stallMs = config.encodeStallMinutes * 60_000;
  const guard = stallMs > 0 ? new OutputStallGuard(stallMs, () => core.deps.now().getTime()) : null;
  let stalled = false;
  const proc = core.deps.spawner.spawn(config.ffmpegPath, p.args, {
    logPath: p.logPath,
    pidFile: join(p.tempDir, 'ffmpeg.pid'),
    log: core.deps.log,
    onProgress: (s) => {
      last = s;
      guard?.sample(s);
      if ((s.frames ?? 0) > 0 || (s.outTimeSeconds ?? 0) > 0) framesOut = true;
      const shown = withFrameTime(s, frameRate);
      if (shown.outTimeSeconds !== null) reached = Math.max(reached ?? 0, shown.outTimeSeconds);
      if (ctl.signal.aborted) return;
      const t = core.deps.now().getTime();
      if (t - lastWrite < PROGRESS_INTERVAL_MS) return;
      lastWrite = t;
      core.update(job, ctl, { progress: toJobProgress(shown, p.probe.durationSeconds) });
    },
    onStderrLine: (line) => {
      const side = classifyErrorLine(line, sourceCodecs, encoders);
      if (side === 'output') outputErrors.push(line.trim());
      // Before the first output frame, or with no position known (ffmpeg 8 without an out time
      // and no frame rate to read the frames by): ignored with a warning, never placed at 0,
      // where confirming the damage would decode the wrong part of the source.
      else if (side !== null && !framesOut) leading += 1;
      else if (side !== null && reached === null) unplaced += 1;
      else if (side !== null && reached !== null) {
        const at = reached;
        (side === 'source' ? sourceErrors : demuxerErrors).push({ line: line.trim(), at });
      }
    },
  });
  const watch = guard
    ? watchForStall(proc, guard, stallMs, () => {
        stalled = true;
        core.deps.log.warn({ msg: 'encode wrote no output, stopping ffmpeg', job: job.id });
      })
    : null;
  ctl.attach(watch?.proc ?? proc);
  let result: Awaited<typeof proc.done>;
  try {
    result = await proc.done;
  } catch (err) {
    watch?.stop();
    ctl.attach(null);
    core.stopIfAborted(ctl);
    return fail(retryable('encode', `ffmpeg could not start: ${message(err)}`));
  }
  watch?.stop();
  ctl.attach(null);
  core.stopIfAborted(ctl);
  // Stopped by the stall guard before any output: a stream that never started holds the output
  // back, and the same plan would stall again, so it is not retried. A stall after output had
  // started (a hung share, a stuck GPU) fails like any killed encode below: retryable, and a
  // hardware encode tries another GPU or software first.
  const stalledAfterOutput = stalled && (guard?.started() ?? false);
  if (stalled && !stalledAfterOutput) {
    return fail(final('encode', noOutputReason(config.encodeStallMinutes)));
  }
  if (stalledAfterOutput || result.code !== 0) {
    const why = stalledAfterOutput
      ? stoppedOutputReason(config.encodeStallMinutes)
      : result.code === null
        ? `ffmpeg killed by ${result.signal ?? 'a signal'}`
        : `ffmpeg exited ${result.code}`;
    const tail = await readTail(p.logPath, REASON_TAIL_BYTES);
    const cause = ffmpegFailure(tail);
    // The GPU gave up: back to the queue for a GPU it has not failed on, when there is one
    // (never for a software job); else the same plan once more on the software encoder, in
    // this attempt.
    const gpuStalled = stalledAfterOutput && p.fit !== 'software';
    // A size gate's track changes copy the video: no GPU took part, whatever the log says.
    const onGpu = p.trackChanges === null;
    if (onGpu && !p.softwareFallback && (looksLikeGpuFailure(tail) || gpuStalled)) {
      const { slot } = p;
      const failed = slot?.gpuId ? [...job.failedGpus, slot.gpuId] : null;
      if (slot && failed && p.fit !== 'software' && core.deps.otherGpuFor?.(p.fit, failed)) {
        const reason = `${slot.label} failed (${cause ?? why})${TRYING_ANOTHER_GPU}`;
        core.gpuWarnings.set(job.id, [...(core.gpuWarnings.get(job.id) ?? []), reason]);
        core.deps.log.warn({ msg: 'GPU encode failed, trying another GPU', job: job.id });
        if (job.encodedOn !== null) core.update(job, ctl, { encodedOn: null });
        return { kind: 'requeue', reason, failedGpus: failed };
      }
      // The Intel GPU decoded the source into GPU frames and gave up (a 4:2:2 source, which its
      // decoder cannot take): the same GPU once more with the source decoded on the CPU, before
      // a full software encode.
      const device = slot?.device;
      if (
        device?.kind === 'qsv' &&
        !p.cpuDecode &&
        !gpuStalled &&
        p.args.includes('-hwaccel_output_format')
      ) {
        const args = core.renderFor({ ...p, cpuDecode: true }, p.model, device);
        // Unchanged: the GPU frames were the model's own, so the same argv would fail again.
        if (args && args.join('\0') !== p.args.join('\0')) {
          p.cpuDecode = true;
          p.args = args;
          p.command = renderCommandLine(config.ffmpegPath, args);
          core.renderWarn(
            job,
            p,
            `the Intel GPU encode failed (${cause ?? why}); retried with the source decoded on the CPU`,
          );
          core.deps.log.warn({
            msg: 'GPU decode failed, retrying with CPU decoding',
            job: job.id,
          });
          return encode(core, job, ctl, p);
        }
      }
      const soft = softwareFallback(p.model, core.capabilitiesOf().encoders);
      const args = soft && core.renderFor(p, soft);
      if (soft && args) {
        p.model = soft;
        p.plan = p.replan(soft);
        p.args = args;
        p.command = renderCommandLine(config.ffmpegPath, args);
        p.softwareFallback = true;
        core.renderWarn(
          job,
          p,
          `the GPU encode failed (${cause ?? why}); encoded in software instead`,
        );
        core.deps.log.warn({ msg: 'GPU encode failed, retrying in software', job: job.id });
        const row = job.encodedOn === null ? job : core.update(job, ctl, { encodedOn: null });
        return encode(core, row, ctl, p);
      }
    }
    // ffmpeg often exits non-zero after a read error: the source is the cause, not the encoder.
    const unreadable = [...demuxerErrors, ...sourceErrors].find((e) => READ_FAILURE.test(e.line));
    if (unreadable) {
      return fail(
        retryable('source_unreadable', `encode could not read the source: ${unreadable.line}`),
      );
    }
    return fail(retryable('encode', cause ? `${why}: ${cause}` : why));
  }
  if (unplaced > 0) {
    core.renderWarn(
      job,
      p,
      `ignored ${unplaced} decoder error(s): ffmpeg reported no output time to place them by`,
    );
  }
  if (leading > 0) {
    core.renderWarn(job, p, `ignored ${leading} decoder error(s) before the first output frame`);
  }
  if (outputErrors.length > 0) {
    const lines = outputErrors.slice(0, MAX_ERROR_LINES);
    return fail(retryable('encode', `encode reported errors: ${lines[0] ?? ''}`, lines));
  }
  // A read error (a disk or network share) may cause any decoder error after it: never damage.
  const unreadable = [...demuxerErrors, ...sourceErrors].find((e) => READ_FAILURE.test(e.line));
  if (unreadable) {
    return fail(
      retryable('source_unreadable', `encode could not read the source: ${unreadable.line}`),
    );
  }
  // The demuxer alone proves nothing; with a decoder error its lines are part of the damage.
  if (sourceErrors.length === 0 && demuxerErrors.length > 0) {
    const lines = demuxerErrors.slice(0, MAX_ERROR_LINES).map((e) => e.line);
    return fail(
      retryable(
        'source_unreadable',
        `encode reported source read errors: ${lines[0] ?? ''}`,
        lines,
      ),
    );
  }
  if (sourceErrors.length > 0) {
    sourceErrors.push(...demuxerErrors);
    sourceErrors.sort((a, b) => a.at - b.at);
    const lines = sourceErrors.slice(0, MAX_ERROR_LINES).map((e) => e.line);
    const confirmed = await confirmSourceDamage({
      sourcePath: p.realPath,
      sourceProbe: p.probe,
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      times: sourceErrors.map((e) => e.at),
      model: p.model,
      signal: ctl.signal,
      ...(core.deps.exec ? { exec: core.deps.exec } : {}),
    });
    core.stopIfAborted(ctl);
    if (confirmed.length > 0) {
      return sourceDamaged(
        core,
        job,
        ctl,
        p,
        [...lines, ...confirmed.map((f) => `${f.check}: ${f.message}`)],
        confirmed,
      );
    }
    return fail(
      retryable(
        'encode',
        `encode reported source decode errors the source does not reproduce: ${lines[0] ?? ''}`,
        lines,
      ),
    );
  }
  const videos = kept(p.model).filter((s) => s.type === 'video' && !pictureOf(s, p.probe));
  const sample = last as ProgressSample | null;
  const frames = sample?.frames;
  if (videos.length === 1 && frames !== undefined) {
    const { exact, tag } = sourceFrameCounts(p.probe, (videos[0] as StreamPlan).sourceIndex);
    const off = (n: number) => Math.abs(frames - n) > Math.max(FRAME_SLACK, n * FRAME_TOLERANCE);
    if (exact !== null && off(exact)) {
      return fail(
        retryable('encode', `encode wrote ${frames} video frames, the source has ${exact}`),
      );
    }
    if (exact === null && tag !== null && off(tag)) {
      core.renderWarn(
        job,
        p,
        `encode wrote ${frames} video frames; the source tag NUMBER_OF_FRAMES says ${tag}`,
      );
    }
  }
  return null;
}

/**
 * Copying a cover out reads the whole file (ffmpeg reaches the picture's packet only after the
 * rest: about 3 min for a 30 GB remux on a hard disk), so the limit grows with the file: 60 s plus
 * 1 s per 100 MB.
 */
export function coverTimeoutMs(sizeBytes: number): number {
  return 60_000 + Math.ceil(Math.max(0, sizeBytes) / 100_000_000) * 1000;
}

/** Why a cover could not be copied out, in one line: a timeout in words, else ffmpeg's last error. */
export function coverFailure(err: unknown, index: number, timeoutMs: number): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    killed?: unknown;
    stderr?: unknown;
  };
  if (e.killed === true) {
    const minutes = Math.round(timeoutMs / 60_000);
    return `render: copying the cover (video #${index}) out of the file took longer than ${minutes} min and was stopped`;
  }
  const lines = (typeof e.stderr === 'string' ? e.stderr : '').trim().split('\n').filter(Boolean);
  const last = lines
    .at(-1)
    ?.replace(/^\[[^\]]* @ 0x[0-9a-f]+\]\s*/i, '')
    .trim();
  return `render: the cover (video #${index}) could not be copied out of the file${last ? `: ${last}` : ''}`;
}
