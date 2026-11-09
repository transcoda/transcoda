import type { ProbeResult } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { checkSource, checkSourceArgs, checkSourceTimeoutMs, locateArgs } from './check-source.ts';
import { MemoryLimitError } from './memory-guard.ts';
import { probeOf } from './test-helpers.ts';
import type { VerifyFailure } from './verify.ts';

const LFE = '[dca @ 0x55d0] [error] Invalid LFE scale factor index';

const dts = (durationSeconds = 3600): ProbeResult =>
  probeOf(
    [
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'dts', language: 'eng', default: true },
    ],
    { sizeBytes: 2 * 2 ** 30, durationSeconds },
  );

/** A mark of the locating pass for stream `index` at `t` seconds. */
const mark = (index: number, t: number) =>
  `[ashowinfo@s${index} @ 0x9] [info] n:   0 pts:    0 pts_time:${t} fmt:fltp channels:6`;

/**
 * As ffmpeg runs: `leading` stderr lines before any output, a progress block at `errorAt` seconds
 * (when given), the `stderr` lines, then a progress block at `readTo`; then resolves or rejects.
 * The locating pass (`level+info`) logs `located` when given, else the same lines with each
 * decoded stream's marks at 0 and `errorAt` before the `stderr` lines and at `readTo` after them.
 */
function fakeExec(o: {
  readTo?: number;
  errorAt?: number;
  leading?: string[];
  stderr?: string[];
  fail?: Record<string, unknown>;
  located?: string[];
}): Exec & { calls: { args: string[]; opts: Parameters<Exec>[2] }[] } {
  const calls: { args: string[]; opts: Parameters<Exec>[2] }[] = [];
  const exec = (async (_file, args, opts) => {
    calls.push({ args, opts });
    if (args.includes('level+info')) {
      const streams = [...args.join(' ').matchAll(/showinfo@s(\d+)/g)].map((m) => Number(m[1]));
      const marks = (t: number | undefined) =>
        t === undefined ? [] : streams.map((i) => mark(i, t));
      const stderr = (
        o.located ?? [
          ...(o.leading ?? []),
          ...marks(0),
          ...marks(o.errorAt),
          ...(o.stderr ?? []),
          ...marks(o.readTo),
        ]
      ).join('\n');
      if (o.fail) throw Object.assign(new Error('Command failed: ffmpeg'), { stderr, ...o.fail });
      return { stdout: '', stderr };
    }
    const progress = (t: number) =>
      opts?.onStdout?.(`out_time_us=${Math.round(t * 1e6)}\nprogress=continue\n`);
    const lines = (l: string[] = []) => {
      if (l.length > 0) opts?.onStderr?.(`${l.join('\n')}\n`);
    };
    lines(o.leading);
    if (o.errorAt !== undefined) progress(o.errorAt);
    lines(o.stderr);
    if (o.readTo !== undefined) {
      progress(o.readTo);
      opts?.onStdout?.(`out_time_us=N/A\nprogress=end\n`);
    }
    const stderr = [...(o.leading ?? []), ...(o.stderr ?? [])].join('\n');
    if (o.fail) throw Object.assign(new Error('Command failed: ffmpeg'), { stderr, ...o.fail });
    return { stdout: '', stderr };
  }) as Exec & { calls: { args: string[]; opts: Parameters<Exec>[2] }[] };
  exec.calls = calls;
  return exec;
}

/** A confirmation that finds the error again (the source really is damaged there). */
const confirms = async (): Promise<VerifyFailure[]> => [
  { check: 'decode-sample', message: 'source: decoding 7 s from 0:00 failed: [dca] Invalid LFE' },
];

const run = (
  exec: Exec,
  probe = dts(),
  decodeVideo = false,
  signal?: AbortSignal,
  confirm: (spot: { at: number; seconds: number }) => Promise<VerifyFailure[]> = confirms,
) =>
  checkSource({
    path: '/lib/a.mkv',
    probe,
    ffmpegPath: 'ffmpeg',
    decodeVideo,
    sizeBytes: probe.sizeBytes,
    exec,
    confirm,
    ...(signal ? { signal } : {}),
  });

describe('checkSource', () => {
  it('a dca error line on a dts source → damaged, reason "audio #1 (DTS): Invalid LFE scale factor index"', async () => {
    expect(await run(fakeExec({ errorAt: 1200, readTo: 3600, stderr: [LFE] }))).toEqual({
      kind: 'damaged',
      reason: 'audio #1 (DTS): Invalid LFE scale factor index',
      stream: 'audio #1 (DTS)',
    });
    // An input-stream context names its stream by index.
    expect(
      await run(
        fakeExec({
          errorAt: 1200,
          readTo: 3600,
          stderr: ['[aist#0:1/dts @ 0x1] [error] Error while decoding stream #0:1'],
        }),
      ),
    ).toMatchObject({ kind: 'damaged', stream: 'audio #1 (DTS)' });
    // Even when ffmpeg exits non-zero after it.
    expect(await run(fakeExec({ errorAt: 1200, stderr: [LFE], fail: { code: 1 } }))).toMatchObject({
      kind: 'damaged',
    });
  });

  it('decoder errors before the first output frame (audio starting mid-frame) are ignored', async () => {
    const mp3 = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'mp3', language: 'eng', default: true },
      ],
      { durationSeconds: 3600 },
    );
    const spots: unknown[] = [];
    const confirm = async (spot: unknown) => {
      spots.push(spot);
      return confirms();
    };
    const exec = fakeExec({
      readTo: 3600,
      leading: ['[mp3float @ 0x1] [error] Header missing'],
    });
    expect(await run(exec, mp3, false, undefined, confirm)).toEqual({
      kind: 'ok',
      warnings: ['ignored 1 decoder error(s) before the first output frame'],
    });
    expect(spots).toEqual([]);
  });

  it('a mid-file error is damaged only when the source reproduces it at that spot', async () => {
    const spots: { at: number; seconds: number }[] = [];
    const confirm = (found: VerifyFailure[]) => async (spot: { at: number; seconds: number }) => {
      spots.push(spot);
      return found;
    };
    const exec = () => fakeExec({ errorAt: 1200, stderr: [LFE], readTo: 3600 });
    expect(await run(exec(), dts(), false, undefined, confirm(await confirms()))).toEqual({
      kind: 'damaged',
      reason: 'audio #1 (DTS): Invalid LFE scale factor index',
      stream: 'audio #1 (DTS)',
    });
    // Read from where the error was seen to the next progress block (capped), plus the window.
    expect(spots).toEqual([{ at: 1200, seconds: 120 }]);
    spots.length = 0;
    expect(await run(exec(), dts(), false, undefined, confirm([]))).toEqual({
      kind: 'error',
      message:
        'audio #1 (DTS): Invalid LFE scale factor index at 20:00, which the source does not reproduce',
    });
    expect(
      await run(
        fakeExec({ errorAt: 1200, stderr: [LFE], readTo: 1203 }),
        dts(),
        false,
        undefined,
        confirm([]),
      ),
    ).toMatchObject({ kind: 'error' });
    expect(spots.at(-1)).toEqual({ at: 1200, seconds: 10 });
  });

  it('places errors by media time, not by when they were read (a fast read before any progress)', async () => {
    const spots: { at: number; seconds: number }[] = [];
    const confirm = async (spot: { at: number; seconds: number }) => {
      spots.push(spot);
      return confirms();
    };
    // The whole file read before the first progress block: the error has no out time at all.
    const exec = fakeExec({
      leading: [LFE],
      readTo: 3600,
      located: [mark(1, 0), mark(1, 137), LFE, mark(1, 138)],
    });
    expect(await run(exec, dts(), false, undefined, confirm)).toEqual({
      kind: 'damaged',
      reason: 'audio #1 (DTS): Invalid LFE scale factor index',
      stream: 'audio #1 (DTS)',
    });
    expect(spots).toEqual([{ at: 137, seconds: 8 }]);
    expect(exec.calls[1]?.args).toEqual(locateArgs('/lib/a.mkv', dts(), false));
    // Within LEADING_SECONDS of the stream's first frame: leading, as the encode drops it.
    spots.length = 0;
    const early = fakeExec({
      leading: [LFE],
      readTo: 3600,
      located: [mark(1, 0.5), mark(1, 1.5), LFE, mark(1, 2.5)],
    });
    expect(await run(early, dts(), false, undefined, confirm)).toEqual({
      kind: 'ok',
      warnings: ['ignored 1 decoder error(s) before the first output frame'],
    });
    expect(spots).toEqual([]);
    // Video decode errors before the video's first frame are leading while audio is far along.
    const hevc = '[hevc @ 0x7] [error] Could not find ref with POC 12';
    const late = fakeExec({
      leading: [hevc],
      readTo: 3600,
      located: [mark(1, 0), mark(1, 5), hevc, mark(0, 6), mark(1, 6)],
    });
    expect(await run(late, dts(), true, undefined, confirm)).toEqual({
      kind: 'ok',
      warnings: ['ignored 1 decoder error(s) before the first output frame'],
    });
    // A second read without the error: not proven damaged.
    expect(
      await run(fakeExec({ leading: [LFE], readTo: 3600, located: [mark(1, 0)] }), dts()),
    ).toEqual({
      kind: 'error',
      message:
        'audio #1 (DTS): Invalid LFE scale factor index, which a second read does not reproduce',
    });
  });

  it('the locating pass decodes what the first pass decodes, one mark per media second each', () => {
    expect(locateArgs('/lib/a.mkv', dts(), false)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'level+info',
      '-i',
      '/lib/a.mkv',
      '-map',
      '0:1',
      '-filter:0',
      "aselect='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',ashowinfo@s1",
      '-f',
      'null',
      '-',
    ]);
    expect(locateArgs('/lib/a.mkv', dts(), true)).toContain(
      "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',showinfo@s0",
    );
  });

  it('maps audio only unless decodeVideo; decodes video when the file has no audio', async () => {
    const args = checkSourceArgs('/lib/a.mkv', dts(), false);
    expect(args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'level+error',
      '-progress',
      'pipe:1',
      '-i',
      '/lib/a.mkv',
      '-map',
      '0:1',
      '-f',
      'null',
      '-',
    ]);
    expect(maps(checkSourceArgs('/lib/a.mkv', dts(), true))).toEqual(['0:0', '0:1']);
    const silent = probeOf([{ type: 'video', codec: 'hevc', default: true }]);
    expect(maps(checkSourceArgs('/lib/a.mkv', silent, false))).toEqual(['0:0']);
    const exec = fakeExec({ readTo: 60 });
    expect(await run(exec, silent)).toEqual({ kind: 'ok', warnings: [] });
  });

  /** The `-map` values of an ffmpeg argv. */
  const maps = (args: string[]) => args.filter((_, i) => args[i - 1] === '-map');

  /**
   * A film whose cover an earlier encode turned into an ordinary HEVC video track (image tags, no
   * attached_pic): ffmpeg's `0:V?` maps it, and the null muxer then queues every decoded frame of
   * the film waiting for the cover's next frame until memory runs out.
   */
  const withCoverTrack = (): ProbeResult =>
    probeOf(
      [
        { type: 'video', codec: 'hevc', default: true, width: 1920, height: 1080 },
        { type: 'audio', codec: 'eac3', language: 'eng', default: true },
        { type: 'video', codec: 'hevc', width: 640, height: 360, imageTrack: true },
        { type: 'audio', codec: 'aac', language: 'deu' },
      ],
      { sizeBytes: 12 * 2 ** 30, durationSeconds: 7200 },
    );

  it('never maps a cover stored as a video track: the decoded streams by index, no 0:V?', async () => {
    for (const decodeVideo of [false, true]) {
      const args = checkSourceArgs('/lib/a.mkv', withCoverTrack(), decodeVideo);
      expect(maps(args)).toEqual(decodeVideo ? ['0:0', '0:1', '0:3'] : ['0:1', '0:3']);
      expect(args.join(' ')).not.toMatch(/0:V|0:a\?|0:2/);
    }
    // A file with no audio decodes its video, still without the cover.
    const silent = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
      { type: 'video', codec: 'hevc', imageTrack: true },
    ]);
    expect(maps(checkSourceArgs('/lib/a.mkv', silent, false))).toEqual(['0:0']);
    // The locating pass reads the same streams.
    expect(maps(locateArgs('/lib/a.mkv', withCoverTrack(), true))).toEqual(['0:0', '0:1', '0:3']);
  });

  it('a file with nothing to read (no audio, video only pictures) is an error, and runs nothing', async () => {
    const covers = probeOf([{ type: 'video', codec: 'mjpeg', attachedPic: true }]);
    const exec = fakeExec({ readTo: 60 });
    expect(await run(exec, covers, true)).toEqual({
      kind: 'error',
      message: 'the file has no audio or video stream to read',
    });
    expect(exec.calls).toHaveLength(0);
  });

  it('ffmpeg stopped by the memory guard is an error that is not worth retrying (never damaged)', async () => {
    const memory = new MemoryLimitError(4_000_000_000, `${LFE}\n`);
    expect(await run(fakeExec({ errorAt: 60, stderr: [LFE], fail: { ...memory } }))).toEqual({
      kind: 'error',
      message: 'ffmpeg used more than 4.00 GB of memory and was stopped',
      final: true,
    });
    // In the locating pass too.
    const locating = (async (_file, args) => {
      if (args.includes('level+info')) throw memory;
      return { stdout: '', stderr: `${LFE}\n` };
    }) as Exec;
    expect(await run(locating)).toEqual({
      kind: 'error',
      message: 'ffmpeg used more than 4.00 GB of memory and was stopped',
      final: true,
    });
  });

  /** The demuxer says the file stops at `at` (its own context, as libavformat logs it). */
  const truncated = (
    readTo: number,
    line = '[matroska,webm @ 0x1] [error] File ended prematurely',
  ) => fakeExec({ errorAt: readTo - 1, stderr: [line], readTo });

  it('cut-off: 30 s and 2 % of the declared end decide, with the demuxer reporting truncation at the tail', async () => {
    expect(await run(fakeExec({ readTo: 3569 }))).toEqual({
      kind: 'ok',
      warnings: ['ends 31 s short of the declared 1:00:00'],
    });
    expect(await run(truncated(3400))).toEqual({
      kind: 'damaged',
      reason: 'cut off: readable to 56:40 of 1:00:00',
    });
    for (const line of [
      '[in#0/matroska,webm @ 0x1] [error] Error during demuxing: End of file',
      '[in#0/matroska,webm @ 0x1] [error] Truncating packet of size 4096 to 1024',
    ]) {
      expect(await run(truncated(3400, line))).toMatchObject({ kind: 'damaged' });
    }
    expect(await run(fakeExec({ readTo: 95 }), dts(100))).toEqual({
      kind: 'ok',
      warnings: ['ends 5 s short of the declared 1:40'],
    });
    expect(await run(truncated(60), dts(100))).toEqual({
      kind: 'damaged',
      reason: 'cut off: readable to 1:00 of 1:40',
    });
    expect(await run(fakeExec({ readTo: 3600 }))).toEqual({ kind: 'ok', warnings: [] });
  });

  it('a header longer than what was read, without truncation at the tail, is a warning (a stale header)', async () => {
    expect(await run(fakeExec({ readTo: 3400 }))).toEqual({
      kind: 'ok',
      warnings: ['the header says 1:00:00, but the file reads to 56:40'],
    });
    // Truncation reported far from where the read stopped says nothing about the tail.
    expect(
      await run(
        fakeExec({
          errorAt: 100,
          stderr: ['[matroska,webm @ 0x1] [error] File ended prematurely'],
          readTo: 3400,
        }),
      ),
    ).toEqual({
      kind: 'ok',
      warnings: ['the header says 1:00:00, but the file reads to 56:40'],
    });
  });

  it('a non-zero exit without a source error, a timeout and a read error are errors (never damaged)', async () => {
    expect(
      await run(
        fakeExec({
          stderr: ['[out#0/null @ 0x1] [error] Error opening output file -.'],
          fail: { code: 1 },
        }),
      ),
    ).toEqual({ kind: 'error', message: 'Error opening output file -.' });
    expect(
      await run(
        fakeExec({ errorAt: 60, stderr: [LFE], fail: { killed: true, signal: 'SIGKILL' } }),
      ),
    ).toEqual({
      kind: 'error',
      message: 'reading the file took longer than 20 min and was stopped',
    });
    // An I/O error with decoder errors after it: the read failed, the file is not proven damaged.
    for (const fail of [undefined, { code: 1 }]) {
      expect(
        await run(
          fakeExec({
            errorAt: 1200,
            stderr: [
              '[in#0/matroska,webm @ 0x1] [error] Error during demuxing: Input/output error',
              LFE,
            ],
            ...(fail ? { fail } : {}),
          }),
        ),
      ).toEqual({ kind: 'error', message: 'Error during demuxing: Input/output error' });
    }
    // ffmpeg did not start at all.
    const missing = (async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    }) as Exec;
    expect(await run(missing)).toEqual({
      kind: 'error',
      message: 'ffmpeg could not run: spawn ffmpeg ENOENT',
    });
  });

  it.each([
    'Transport endpoint is not connected',
    'Host is down',
    'Network is unreachable',
    'Operation timed out',
    'Broken pipe',
    'Software caused connection abort',
  ])('a network share read error (%s) is an error, never damaged', async (why) => {
    for (const fail of [undefined, { code: 1 }]) {
      // From the demuxer, with decoder errors after it.
      expect(
        await run(
          fakeExec({
            errorAt: 1200,
            stderr: [`[in#0/matroska,webm @ 0x1] [error] Error during demuxing: ${why}`, LFE],
            ...(fail ? { fail } : {}),
          }),
        ),
      ).toEqual({ kind: 'error', message: `Error during demuxing: ${why}` });
      // As ffmpeg's own last word, without a context.
      expect(
        await run(
          fakeExec({
            errorAt: 1200,
            stderr: [LFE, `[error] /lib/a.mkv: ${why}`],
            ...(fail ? { fail } : {}),
          }),
        ),
      ).toEqual({ kind: 'error', message: `/lib/a.mkv: ${why}` });
    }
  });

  it('a demuxer error without a decoder error is an error, never damaged', async () => {
    const line = '[in#0/matroska,webm @ 0x1] [error] 0x00 at pos 300606 invalid as first byte';
    for (const fail of [undefined, { code: 1 }]) {
      expect(
        await run(
          fakeExec({ errorAt: 1200, readTo: 3600, stderr: [line], ...(fail ? { fail } : {}) }),
        ),
      ).toEqual({ kind: 'error', message: '0x00 at pos 300606 invalid as first byte' });
    }
    // A decoder error the source reproduces still says damaged, the demuxer line beside it.
    expect(await run(fakeExec({ errorAt: 1200, readTo: 3600, stderr: [line, LFE] }))).toMatchObject(
      { kind: 'damaged', stream: 'audio #1 (DTS)' },
    );
  });

  it('passes the signal and a timeout of 600000 + 300000 * ceil(GiB) ms; an abort rethrows', async () => {
    const exec = fakeExec({ readTo: 3600 });
    const ctl = new AbortController();
    await run(exec, dts(), false, ctl.signal);
    expect(exec.calls[0]?.opts?.signal).toBe(ctl.signal);
    expect(exec.calls[0]?.opts?.timeoutMs).toBe(600_000 + 300_000 * 2);
    expect(checkSourceTimeoutMs(1)).toBe(900_000);
    expect(checkSourceTimeoutMs(2 ** 30 + 1)).toBe(1_200_000);
    ctl.abort();
    const aborting = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as Exec;
    await expect(run(aborting, dts(), false, ctl.signal)).rejects.toThrow('aborted');
  });
});
