import type { ProbeResult } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { checkSource, checkSourceArgs, checkSourceTimeoutMs } from './check-source.ts';
import { probeOf } from './test-helpers.ts';

const LFE = '[dca @ 0x55d0] [error] Invalid LFE scale factor index';

const dts = (durationSeconds = 3600): ProbeResult =>
  probeOf(
    [
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'dts', language: 'eng', default: true },
    ],
    { sizeBytes: 2 * 2 ** 30, durationSeconds },
  );

/** Progress blocks up to `readTo` seconds through `onStdout`; then resolves or rejects. */
function fakeExec(o: {
  readTo?: number;
  stderr?: string[];
  fail?: Record<string, unknown>;
}): Exec & { calls: { args: string[]; opts: Parameters<Exec>[2] }[] } {
  const calls: { args: string[]; opts: Parameters<Exec>[2] }[] = [];
  const exec = (async (_file, args, opts) => {
    calls.push({ args, opts });
    if (o.readTo !== undefined) {
      opts?.onStdout?.(`out_time_us=${Math.round(o.readTo * 1e6)}\nprogress=continue\n`);
      opts?.onStdout?.(`out_time_us=N/A\nprogress=end\n`);
    }
    const stderr = (o.stderr ?? []).join('\n');
    if (o.fail) throw Object.assign(new Error('Command failed: ffmpeg'), { stderr, ...o.fail });
    return { stdout: '', stderr };
  }) as Exec & { calls: { args: string[]; opts: Parameters<Exec>[2] }[] };
  exec.calls = calls;
  return exec;
}

const run = (exec: Exec, probe = dts(), decodeVideo = false, signal?: AbortSignal) =>
  checkSource({
    path: '/lib/a.mkv',
    probe,
    ffmpegPath: 'ffmpeg',
    decodeVideo,
    sizeBytes: probe.sizeBytes,
    exec,
    ...(signal ? { signal } : {}),
  });

describe('checkSource', () => {
  it('a dca error line on a dts source → damaged, reason "audio #1 (DTS): Invalid LFE scale factor index"', async () => {
    expect(await run(fakeExec({ readTo: 3600, stderr: [LFE] }))).toEqual({
      kind: 'damaged',
      reason: 'audio #1 (DTS): Invalid LFE scale factor index',
      stream: 'audio #1 (DTS)',
    });
    // An input-stream context names its stream by index.
    expect(
      await run(
        fakeExec({
          readTo: 3600,
          stderr: ['[aist#0:1/dts @ 0x1] [error] Error while decoding stream #0:1'],
        }),
      ),
    ).toMatchObject({ kind: 'damaged', stream: 'audio #1 (DTS)' });
    // Even when ffmpeg exits non-zero after it.
    expect(await run(fakeExec({ stderr: [LFE], fail: { code: 1 } }))).toMatchObject({
      kind: 'damaged',
    });
  });

  it('copies video unless decodeVideo; decodes video when the file has no audio', async () => {
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
      '0:a?',
      '-map',
      '0:V?',
      '-c:v',
      'copy',
      '-f',
      'null',
      '-',
    ]);
    expect(checkSourceArgs('/lib/a.mkv', dts(), true)).not.toContain('-c:v');
    const silent = probeOf([{ type: 'video', codec: 'hevc', default: true }]);
    expect(checkSourceArgs('/lib/a.mkv', silent, false)).not.toContain('-c:v');
    const exec = fakeExec({ readTo: 60 });
    expect(await run(exec, silent)).toEqual({ kind: 'ok', warnings: [] });
    expect(exec.calls[0]?.args).not.toContain('copy');
  });

  it('cut-off: 30 s and 2 % of the declared end decide', async () => {
    expect(await run(fakeExec({ readTo: 3569 }))).toEqual({
      kind: 'ok',
      warnings: ['ends 31 s short of the declared 1:00:00'],
    });
    expect(await run(fakeExec({ readTo: 3400 }))).toEqual({
      kind: 'damaged',
      reason: 'cut off: readable to 56:40 of 1:00:00',
    });
    expect(await run(fakeExec({ readTo: 95 }), dts(100))).toEqual({
      kind: 'ok',
      warnings: ['ends 5 s short of the declared 1:40'],
    });
    expect(await run(fakeExec({ readTo: 60 }), dts(100))).toEqual({
      kind: 'damaged',
      reason: 'cut off: readable to 1:00 of 1:40',
    });
    expect(await run(fakeExec({ readTo: 3600 }))).toEqual({ kind: 'ok', warnings: [] });
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
      await run(fakeExec({ stderr: [LFE], fail: { killed: true, signal: 'SIGKILL' } })),
    ).toEqual({
      kind: 'error',
      message: 'reading the file took longer than 20 min and was stopped',
    });
    // An I/O error with decoder errors after it: the read failed, the file is not proven damaged.
    for (const fail of [undefined, { code: 1 }]) {
      expect(
        await run(
          fakeExec({
            readTo: 1200,
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
