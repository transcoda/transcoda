import { execFile } from 'node:child_process';
import { copyFile, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BuildModel, ProbeResult } from '@transcoda/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { fitToContainer, modelFromProbe } from './build-model.ts';
import {
  type FixtureName,
  fixturePath,
  fixturesAvailable,
  tempDir,
  toolPaths,
} from './fixtures.ts';
import { probeFile } from './probe.ts';
import { coverExtractArgs, renderArgs } from './render.ts';
import { probeOf, withSidecar, withStream } from './test-helpers.ts';
import {
  confirmSourceDamage,
  referenceDuration,
  streamFailures,
  type VerifyFailure,
  type VerifyProgress,
  verifyOutput,
} from './verify.ts';

const execFileAsync = promisify(execFile);

function checks(failures: VerifyFailure[]): string[] {
  return [...new Set(failures.map((f) => f.check))];
}

/** How a source decode can fail without saying anything about the file's content. */
const UNSURE: [string, object][] = [
  ['killed (the verify timeout)', { killed: true, signal: 'SIGKILL', code: null }],
  ['over the output limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
  ['not started', { code: 'ENOENT' }],
  [
    'a read error',
    { code: 1, stderr: '[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error\n' },
  ],
];

describe('verifyOutput without ffmpeg', () => {
  it('an output ffprobe cannot read fails the probe check only', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      throw Object.assign(new Error('Command failed'), {
        stderr: 'out.mkv: Invalid data found when processing input\n',
      });
    };
    const source = probeOf([{ type: 'video' }, { type: 'audio', default: true }]);
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(result).toEqual({
      ok: false,
      kind: 'output-invalid',
      sourceFailures: [],
      failures: [
        {
          check: 'probe',
          message: 'the output cannot be read: out.mkv: Invalid data found when processing input',
        },
      ],
      probe: null,
      warnings: [],
    });
    expect(calls).toHaveLength(1);
  });

  /**
   * A fake ffprobe/ffmpeg for a 7200 s file with one video stream starting at 0: `ends` answers the
   * per-stream tail reads (by file and read number), every keyframe read finds one at 7190 s.
   */
  function fakeTools(ends: (path: string, read: number) => string) {
    const reads: string[] = [];
    const count = new Map<string, number>();
    const exec: Exec = async (file, args) => {
      const path = args.at(-1) as string;
      if (args.includes('-show_format')) {
        const json = {
          format: { format_name: 'matroska,webm', duration: '7200.000000', start_time: '0.000000' },
          streams: [
            { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
          ],
        };
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      const at = args.indexOf('-read_intervals');
      if (at >= 0 && args.includes('packet=pts_time,duration_time')) {
        const n = count.get(path) ?? 0;
        count.set(path, n + 1);
        reads.push(`${path} ${args[at + 1]}`);
        return { stdout: ends(path, n), stderr: '' };
      }
      if (at >= 0) return { stdout: '7190.000000,1000,K__\n', stderr: '' };
      expect(file).toBe('ffmpeg');
      return { stdout: '', stderr: '' };
    };
    return { exec, reads };
  }

  function longSource(): ProbeResult {
    return probeOf([{ type: 'video', default: true }], {
      durationSeconds: 7200,
      raw: { format: { duration: '7200.000000', start_time: '0.000000' }, streams: [] },
    });
  }

  it('reads only a bounded window at the end of a long file', async () => {
    const { exec, reads } = fakeTools(() => '7199.960000,0.040000\n');
    const source = longSource();
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(result).toMatchObject({ ok: true, warnings: [] });
    expect(reads).toEqual(['/lib/in.mkv 7198%7203', '/tmp/job/out.mkv 7198%7203']);
  });

  it('an output end just before the read window is still compared with the tolerance', async () => {
    // The output's last packet starts before the first window and lasts 2 s: it ends 0.06 s
    // before the source stream, well within 0.25 s plus its own duration.
    const { exec, reads } = fakeTools((path, n) =>
      path === '/lib/in.mkv' ? '7199.960000,0.040000\n' : n === 0 ? '' : '7197.900000,2.000000\n',
    );
    const source = longSource();
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(result).toMatchObject({ ok: true, warnings: [] });
    expect(reads).toEqual([
      '/lib/in.mkv 7198%7203',
      '/tmp/job/out.mkv 7198%7203',
      '/tmp/job/out.mkv 7192%7203',
    ]);
  });

  it('an output stream with no packets anywhere near the source end fails duration', async () => {
    const { exec } = fakeTools((path) => (path === '/lib/in.mkv' ? '7199.960000,0.040000\n' : ''));
    const source = longSource();
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: 'output-invalid',
      failures: [
        {
          check: 'duration',
          message:
            'output #0 (video #0) ends early: no packets in the 600.00s before the source stream ends at 7200.00s',
        },
      ],
    });
  });
  it('decodes 10 keyframe-aligned one-second spots across the output, and the whole file with fullDecode', async () => {
    const decodes: string[][] = [];
    const { exec: tools } = fakeTools(() => '7199.960000,0.040000\n');
    const exec: Exec = async (file, args) => {
      if (file === 'ffmpeg') decodes.push(args);
      return tools(file, args);
    };
    const source = longSource();
    const base = {
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    };
    expect(await verifyOutput(base)).toMatchObject({ ok: true });
    const spots = decodes.filter((a) => a.includes('-ss') && a.includes('-t'));
    expect(spots.map((a) => a[a.indexOf('-ss') + 1])).toEqual(
      ['360', '1080', '1800', '2520', '3240', '3960', '4680', '5400', '6120', '6840'].map((t) =>
        Number(t).toFixed(3),
      ),
    );
    expect(
      spots.every((a) => a[a.indexOf('-t') + 1] === '1' && a.includes('/tmp/job/out.mkv')),
    ).toBe(true);
    const whole0 = decodes.filter((a) => !a.includes('-ss') && !a.includes('-t'));
    expect(whole0).toEqual([]);
    decodes.length = 0;
    expect(await verifyOutput({ ...base, fullDecode: true })).toMatchObject({ ok: true });
    const whole = decodes.filter((a) => !a.includes('-ss') && !a.includes('-t'));
    expect(whole.map((a) => a.slice(a.indexOf('-i'), a.indexOf('-i') + 2))).toEqual([
      ['-i', '/tmp/job/out.mkv'],
    ]);
  });

  it('reports each check as it is done: the probe, each stream end, then each decode', async () => {
    const { exec } = fakeTools(() => '7199.960000,0.040000\n');
    const source = longSource();
    const reports: VerifyProgress[] = [];
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
      onProgress: (p) => reports.push(p),
    });
    expect(result).toMatchObject({ ok: true });
    // 1 probe + 1 stream end + decode start and end + 10 spots.
    expect(reports).toEqual(
      Array.from({ length: 14 }, (_, i) => ({ stage: 'checks', done: i + 1, total: 14 })),
    );
  });

  it('a whole-file decode reports its own progress from ffmpeg -progress, after the checks', async () => {
    const { exec: tools } = fakeTools(() => '7199.960000,0.040000\n');
    let fullArgs: string[] = [];
    const exec: Exec = async (file, args, opts) => {
      if (file === 'ffmpeg' && !args.includes('-ss') && !args.includes('-t')) {
        fullArgs = args;
        opts?.onStdout?.('out_time_us=1800000000\nspeed=12x\nprogress=continue\n');
        opts?.onStdout?.('out_time_us=7200000000\nspeed=12x\nprogress=end\n');
      }
      return tools(file, args);
    };
    const source = longSource();
    const reports: VerifyProgress[] = [];
    await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
      fullDecode: true,
      onProgress: (p) => reports.push(p),
    });
    expect(fullArgs.join(' ')).toContain('-progress pipe:1');
    expect(reports.at(13)).toEqual({ stage: 'checks', done: 14, total: 14 });
    expect(reports.slice(14)).toEqual([
      {
        stage: 'full-decode',
        sample: { outTimeSeconds: 0, speed: null, fps: null, sizeBytes: null },
        durationSeconds: 7200,
      },
      {
        stage: 'full-decode',
        sample: { outTimeSeconds: 1800, speed: 12, fps: null, sizeBytes: null },
        durationSeconds: 7200,
      },
      {
        stage: 'full-decode',
        sample: { outTimeSeconds: 7200, speed: 12, fps: null, sizeBytes: null },
        durationSeconds: 7200,
      },
    ]);
  });

  it('says when it re-checks the source after a decode failure', async () => {
    const { exec: tools } = fakeTools(() => '7199.960000,0.040000\n');
    const exec: Exec = async (file, args, opts) => {
      if (file === 'ffmpeg' && args.includes('/tmp/job/out.mkv') && args.includes('-ss')) {
        return { stdout: '', stderr: '[hevc @ 0x1] error while decoding\n' };
      }
      return tools(file, args, opts);
    };
    const source = longSource();
    const reports: VerifyProgress[] = [];
    await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
      onProgress: (p) => reports.push(p),
    });
    expect(reports.at(-1)).toEqual({ stage: 'source' });
  });

  it.each(UNSURE)('a source decode that fails %s never says source-damaged', async (_, err) => {
    const { exec: tools } = fakeTools(() => '7199.960000,0.040000\n');
    const exec: Exec = async (file, args, opts) => {
      if (file === 'ffmpeg' && args.includes('/tmp/job/out.mkv') && args.includes('-ss')) {
        return { stdout: '', stderr: '[hevc @ 0x1] error while decoding\n' };
      }
      if (file === 'ffmpeg' && args.includes('/lib/in.mkv')) {
        throw Object.assign(new Error('Command failed: ffmpeg'), err);
      }
      return tools(file, args, opts);
    };
    const source = longSource();
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
  });

  it('a source decode that exits with a decoder error is source-damaged', async () => {
    const { exec: tools } = fakeTools(() => '7199.960000,0.040000\n');
    const exec: Exec = async (file, args, opts) => {
      if (file === 'ffmpeg' && args.includes('/tmp/job/out.mkv') && args.includes('-ss')) {
        return { stdout: '', stderr: '[hevc @ 0x1] error while decoding\n' };
      }
      if (file === 'ffmpeg' && args.includes('/lib/in.mkv')) {
        throw Object.assign(new Error('Command failed: ffmpeg'), {
          code: 1,
          stderr: '[hevc @ 0x1] error while decoding\n',
        });
      }
      return tools(file, args, opts);
    };
    const source = longSource();
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(result).toMatchObject({ ok: false, kind: 'source-damaged' });
  });
});

describe('confirmSourceDamage without ffmpeg', () => {
  const source = probeOf([{ type: 'video', default: true }], {
    durationSeconds: 7200,
    raw: { format: { duration: '7200.000000', start_time: '0.000000' }, streams: [] },
  });
  const confirm = (exec: Exec) =>
    confirmSourceDamage({
      sourcePath: '/lib/in.mkv',
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      times: [30],
      exec,
    });

  it.each(UNSURE)('a run that fails %s confirms nothing', async (_, err) => {
    const exec: Exec = async () => {
      throw Object.assign(new Error('Command failed: ffmpeg'), err);
    };
    expect(await confirm(exec)).toEqual([]);
  });

  it('a run that exits 0 but logged a read error confirms nothing', async () => {
    const exec: Exec = async () => ({
      stdout: '',
      stderr: '[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error\n',
    });
    expect(await confirm(exec)).toEqual([]);
  });

  it('a decoder error the source reproduces confirms it', async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error('Command failed: ffmpeg'), {
        code: 1,
        stderr: '[dca @ 0x1] Invalid LFE scale factor index\n',
      });
    };
    expect(await confirm(exec)).toEqual([
      {
        check: 'decode-sample',
        message:
          'source: decoding 7 s from 29.00s failed: [dca @ 0x1] Invalid LFE scale factor index',
      },
    ]);
  });
});

describe('verifyOutput: sidecar subtitle streams', () => {
  const source = probeOf(
    [
      { type: 'video', default: true },
      { type: 'audio', language: 'eng', default: true },
    ],
    {
      durationSeconds: 60,
      raw: { format: { duration: '60.000000', start_time: '0.000000' }, streams: [] },
    },
  );

  /** A fake ffprobe/ffmpeg: the output has video, audio and the given subtitle languages. */
  function tools(subtitles: string[]) {
    const mapped: string[] = [];
    const exec: Exec = async (file, args) => {
      const path = args.at(-1) as string;
      if (args.includes('-show_format')) {
        const base =
          path === '/lib/in.mkv'
            ? [
                { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
                {
                  index: 1,
                  codec_type: 'audio',
                  codec_name: 'aac',
                  tags: { language: 'eng' },
                  disposition: { default: 1 },
                },
              ]
            : [
                { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
                {
                  index: 1,
                  codec_type: 'audio',
                  codec_name: 'aac',
                  tags: { language: 'eng' },
                  disposition: { default: 1 },
                },
                ...subtitles.map((language, n) => ({
                  index: 2 + n,
                  codec_type: 'subtitle',
                  codec_name: 'subrip',
                  tags: { language },
                  disposition: {},
                })),
              ];
        const json = {
          format: { format_name: 'matroska,webm', duration: '60.000000', start_time: '0.000000' },
          streams: base,
        };
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      if (file === 'ffmpeg') mapped.push(args.join(' '));
      if (args.includes('packet=pts_time,duration_time')) {
        return { stdout: '59.960000,0.040000\n', stderr: '' };
      }
      if (args.includes('-read_intervals')) return { stdout: '50.000000,1000,K__\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    return { exec, mapped };
  }

  async function verify(model: BuildModel, subtitles: string[]) {
    const { exec, mapped } = tools(subtitles);
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model,
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    return { result, mapped };
  }

  function two(): BuildModel {
    let model = withSidecar(modelFromProbe(source), 1, 'Show.de.srt');
    model = withSidecar(model, 2, 'Show.en.srt', { language: 'eng' });
    return model;
  }

  it('an output with only one of two embedded sidecars fails the sidecars check', async () => {
    const { result } = await verify(two(), ['deu']);
    if (result.ok) throw new Error('expected a failure');
    expect(result.failures).toContainEqual({
      check: 'sidecars',
      message: 'embedded 1 of 2 subtitle files',
    });
    expect(result.failures.map((f) => f.check)).toContain('stream-count');
  });

  it('an output with both sidecars verifies', async () => {
    const { result } = await verify(two(), ['deu', 'eng']);
    expect(result.ok ? [] : result.failures).toEqual([]);
  });

  it('stream-mismatch names a sidecar stream by its file', async () => {
    const { result } = await verify(two(), ['fra', 'eng']);
    if (result.ok) throw new Error('expected a failure');
    expect(result.failures).toContainEqual({
      check: 'stream-match',
      message: 'output #2 (subtitle from Show.de.srt): language fra, expected deu',
    });
    expect(result.failures.some((f) => f.message.includes('#-1'))).toBe(false);
  });

  it('no check maps a negative source index', async () => {
    const { mapped } = await verify(two(), ['deu', 'eng']);
    expect(mapped.some((a) => /0:-\d/.test(a))).toBe(false);
  });
});

describe.skipIf(!fixturesAvailable())('verifyOutput with real ffmpeg', { timeout: 60_000 }, () => {
  let dir = '';
  beforeAll(async () => {
    dir = await tempDir('verify-');
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Where each probe passed to `verify` came from. */
  const sourcePaths = new WeakMap<ProbeResult, string>();

  async function probeSource(path: string): Promise<ProbeResult> {
    const probe = await probeFile(path, toolPaths());
    sourcePaths.set(probe, path);
    return probe;
  }

  function sourceOf(name: FixtureName): Promise<ProbeResult> {
    return probeSource(fixturePath(name));
  }

  /** ffmpeg with `args` (after the binary), quiet; returns the output path (the last arg). */
  async function ffmpeg(args: string[]): Promise<string> {
    await execFileAsync(toolPaths().ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args]);
    return args.at(-1) as string;
  }

  /** Renders `model` from the fixture to `out`, with `edit` applied to the argv first. */
  async function render(
    name: FixtureName,
    model: BuildModel,
    out: string,
    edit: (args: string[]) => string[] = (a) => a,
    coverFiles?: Map<number, string>,
  ): Promise<string> {
    const output = join(dir, out);
    const input = fixturePath(name);
    const args = renderArgs({ model, input, output, ...(coverFiles ? { coverFiles } : {}) });
    await execFileAsync(toolPaths().ffmpegPath, edit(args));
    return output;
  }

  function verify(outputPath: string, model: BuildModel, sourceProbe: ProbeResult) {
    const sourcePath = sourcePaths.get(sourceProbe);
    if (sourcePath === undefined) throw new Error('probe the source with sourceOf/probeSource');
    return verifyOutput({ outputPath, sourcePath, model, sourceProbe, ...toolPaths() });
  }

  /** Replaces the value after option `name` (e.g. `-disposition:1`). */
  function setOption(args: string[], name: string, value: string): string[] {
    const i = args.indexOf(name);
    if (i < 0) throw new Error(`no ${name} in args`);
    return args.map((a, j) => (j === i + 1 ? value : a));
  }

  /** Inserts options right before `-f <format> <output>`. */
  function beforeOutput(args: string[], extra: string[]): string[] {
    return [...args.slice(0, -3), ...extra, ...args.slice(-3)];
  }

  it('a faithful remux of compliant.mkv verifies', async () => {
    const source = await sourceOf('compliant.mkv');
    const model = modelFromProbe(source);
    const out = await render('compliant.mkv', model, 'faithful.mkv');
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it('a truncated output fails duration and decode-end', async () => {
    const source = await sourceOf('compliant.mkv');
    const model = modelFromProbe(source);
    const full = await render('compliant.mkv', model, 'whole.mkv');
    const cut = join(dir, 'truncated.mkv');
    await copyFile(full, cut);
    await truncate(cut, Math.floor((await stat(full)).size * 0.6));
    const result = await verify(cut, model, source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('output-invalid');
    expect(checks(result.failures)).toEqual(expect.arrayContaining(['duration', 'decode-end']));
    expect(result.failures.find((f) => f.check === 'duration')?.message).toMatch(
      /^output #0 \(video #0\) ends at 1\.\d\ds, the source stream at 3\.\d\ds$/,
    );
  });

  it('a wrong default flag fails stream-match', async () => {
    const source = await sourceOf('compliant.mkv');
    const model = modelFromProbe(source);
    expect(model.streams[1]).toMatchObject({ type: 'audio', default: true });
    const out = await render('compliant.mkv', model, 'wrong-default.mkv', (args) =>
      setOption(setOption(args, '-disposition:1', '0'), '-disposition:2', 'default'),
    );
    const result = await verify(out, model, source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toEqual([
      {
        check: 'stream-match',
        message: 'output #1 (audio #1): not default, expected default',
      },
      {
        check: 'stream-match',
        message: 'output #2 (audio #2): default, expected not default',
      },
    ]);
  });

  it('two default audio tracks fail defaults; a file without audio passes the defaults check', async () => {
    const source = await sourceOf('two-defaults.mkv');
    const model = modelFromProbe(source);
    const out = await render('two-defaults.mkv', model, 'two-defaults.mkv');
    const result = await verify(out, model, source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toEqual([
      { check: 'defaults', message: '2 default audio tracks, expected exactly one' },
    ]);

    const compliant = await sourceOf('compliant.mkv');
    const base = modelFromProbe(compliant);
    const videoOnly = {
      ...base,
      streams: base.streams.map((s) => (s.type === 'video' ? s : { ...s, keep: false })),
    };
    const silent = await render('compliant.mkv', videoOnly, 'video-only.mkv');
    const reprobe = await probeFile(silent, toolPaths());
    expect(reprobe.streams.map((s) => s.type)).toEqual(['video']);
    expect(await verify(silent, videoOnly, compliant)).toMatchObject({ ok: true });
  });

  it('a hevc output with targets [chrome] fails targets', async () => {
    const source = await sourceOf('compliant.mkv');
    const model: BuildModel = {
      ...withStream(modelFromProbe(source), 0, {
        mode: 'convert',
        codec: 'hevc',
        encoder: 'libx265',
        quality: 35,
        preset: 'ultrafast',
      }),
      targets: ['chrome'],
    };
    const out = await render('compliant.mkv', model, 'hevc-chrome.mkv');
    const result = await verify(out, model, source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toEqual([
      { check: 'targets', message: 'Chrome (desktop) cannot play video #0: hevc' },
    ]);
  });

  it('a converted stream whose probed level exceeds the target max fails targets', async () => {
    const source = await sourceOf('compliant.mkv');
    const model: BuildModel = {
      ...withStream(modelFromProbe(source), 0, {
        mode: 'convert',
        codec: 'h264',
        encoder: 'libx264',
        quality: 35,
        preset: 'ultrafast',
      }),
      targets: ['chrome'],
    };
    // The model cannot ask for a level; force one the way an encoder default could pick it.
    const out = await render('compliant.mkv', model, 'level.mkv', (args) =>
      beforeOutput(args, ['-level:0', '6.2']),
    );
    const result = await verify(out, model, source);
    expect(result.probe?.streams[0]).toMatchObject({ codec: 'h264', level: 62 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toEqual([
      {
        check: 'targets',
        message: 'Chrome (desktop) cannot play video #0: h264 level 62 (max 51)',
      },
    ]);
  });

  it('tigger-pooh.mp4 remuxed verbatim with targets [android-tv] verifies (the png cover is exempt)', async () => {
    const source = await sourceOf('tigger-pooh.mp4');
    const model: BuildModel = { ...modelFromProbe(source), targets: ['android-tv'] };
    const out = await render('tigger-pooh.mp4', model, 'tigger.mp4');
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.probe.streams.filter((s) => s.attachedPic)).toHaveLength(1);
  });

  it('tigger-pooh.mp4 → mkv verifies with the cover written last as an attachment', async () => {
    const { ffmpegPath } = toolPaths();
    const source = await sourceOf('tigger-pooh.mp4');
    const model: BuildModel = { ...modelFromProbe(source), container: 'mkv' };
    fitToContainer(model);
    const cover = source.streams.find((s) => s.attachedPic);
    if (!cover) throw new Error('tigger-pooh.mp4 has no cover');
    const coverPath = join(dir, `cover-${cover.index}.png`);
    await execFileAsync(
      ffmpegPath,
      coverExtractArgs(fixturePath('tigger-pooh.mp4'), cover.index, coverPath),
    );
    const out = await render(
      'tigger-pooh.mp4',
      model,
      'tigger.mkv',
      undefined,
      new Map([[cover.index, coverPath]]),
    );
    const result = await verify(out, model, source);
    expect(result.ok ? [] : result.failures).toEqual([]);
    if (!result.ok) return;
    expect(result.probe.streams.at(-1)).toMatchObject({ codec: 'png', attachedPic: true });
  });

  it('a non-default track a target cannot play is a warning, not a failure', async () => {
    const source = await sourceOf('compliant.mkv');
    // aac 8ch is over android-tv's 6-channel limit; audio #2 is not the default track.
    const model: BuildModel = {
      ...withStream(modelFromProbe(source), 2, {
        mode: 'convert',
        codec: 'aac',
        encoder: 'aac',
        channels: 8,
      }),
      targets: ['android-tv'],
    };
    const out = await render('compliant.mkv', model, 'warn.mkv');
    const result = await verify(out, model, source);
    expect(result).toMatchObject({
      ok: true,
      warnings: ["audio #2 won't direct-play on Android TV (Google TV / Shield class)"],
    });
  });

  it('an output whose second audio track ends early fails duration', async () => {
    const source = await sourceOf('compliant.mkv');
    const model = modelFromProbe(source);
    const input = fixturePath('compliant.mkv');
    // audio #2 comes from a second input cut at 1.5 s; everything else is the whole file.
    // biome-ignore format: flag/value pairs
    const out = await ffmpeg([
      '-i', input, '-t', '1.5', '-i', input,
      '-map', '0:0', '-map', '0:1', '-map', '1:2', '-map', '0:3', '-map', '0:4',
      '-c', 'copy', '-f', 'matroska', join(dir, 'short-audio.mkv'),
    ]);
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
    if (result.ok) return;
    expect(result.failures).toEqual([
      {
        check: 'duration',
        message: expect.stringMatching(
          /^output #2 \(audio #2\) ends at 1\.\d\ds, the source stream at 3\.\d\ds$/,
        ),
      },
    ]);
  });

  it('a broken second audio track fails decode (every audio stream is decoded)', async () => {
    const source = await sourceOf('compliant.mkv');
    const model = modelFromProbe(source);
    // biome-ignore format: flag/value pairs
    const out = await ffmpeg([
      '-i', fixturePath('compliant.mkv'), '-map', '0', '-c', 'copy', '-bsf:a:1', 'noise=amount=4',
      join(dir, 'broken-audio.mkv'),
    ]);
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(['decode-start', 'decode-end']);
    expect(result.failures[0]?.message).toMatch(/^decoding the first second failed: \[aac/);
  });

  it('an unknown source duration falls back to the stream durations, then to the measured end', async () => {
    const source = await sourceOf('compliant.mkv');
    const model = modelFromProbe(source);
    const out = await render('compliant.mkv', model, 'no-duration.mkv');
    const noFormatDuration = { ...source, durationSeconds: 0 };
    sourcePaths.set(noFormatDuration, fixturePath('compliant.mkv'));
    expect(referenceDuration(noFormatDuration)).toBeCloseTo(3.021, 3);
    expect(await verify(out, model, noFormatDuration)).toMatchObject({ ok: true, warnings: [] });

    const cut = join(dir, 'no-duration-cut.mkv');
    await copyFile(out, cut);
    await truncate(cut, Math.floor((await stat(out)).size * 0.6));
    expect(await verify(cut, model, noFormatDuration)).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.objectContaining({ check: 'duration' })]),
    });

    // Nothing known at all: the source's own measured end is the reference; never skipped.
    const unknown = { ...source, durationSeconds: 0, raw: {} };
    sourcePaths.set(unknown, fixturePath('compliant.mkv'));
    expect(referenceDuration(unknown)).toBeNull();
    expect(await verify(out, model, unknown)).toMatchObject({ ok: true, warnings: [] });
    expect(await verify(cut, model, unknown)).toMatchObject({
      ok: false,
      failures: expect.arrayContaining([expect.objectContaining({ check: 'duration' })]),
    });
  });

  it('a decode failure the source has too is source-damaged', async () => {
    // biome-ignore format: flag/value pairs
    const damaged = await ffmpeg([
      '-i', fixturePath('compliant.mkv'), '-map', '0', '-c', 'copy', '-bsf:a:1', 'noise=amount=4',
      join(dir, 'damaged-source.mkv'),
    ]);
    const source = await probeSource(damaged);
    const model = modelFromProbe(source);
    const output = join(dir, 'from-damaged.mkv');
    await execFileAsync(toolPaths().ffmpegPath, renderArgs({ model, input: damaged, output }));
    const result = await verify(output, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'source-damaged' });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(['decode-start', 'decode-end']);
    expect(result.sourceFailures.map((f) => f.check)).toEqual(['decode-start', 'decode-end']);
    expect(result.sourceFailures[0]?.message).toMatch(
      /^source: stream #2: decoding the first second failed: \[aac/,
    );
  });

  /** A generated source: `video` s of testsrc2 and `audio` s of a sine, written as `format`. */
  function generate(
    name: string,
    o: { video: number; audio: number; format: 'matroska' | 'mpegts'; hevc?: boolean },
  ): Promise<string> {
    const encoder = o.hevc
      ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=50']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25'];
    // biome-ignore format: flag/value pairs
    return ffmpeg([
      '-f', 'lavfi', '-t', String(o.video), '-i', 'testsrc2=size=320x240:rate=25',
      '-f', 'lavfi', '-t', String(o.audio), '-i', 'sine=frequency=440:sample_rate=48000',
      '-map', '0:v', '-map', '1:a', ...encoder, '-c:a', 'aac', '-disposition:a:0', 'default',
      '-f', o.format, join(dir, name),
    ]);
  }

  /** Renders `model` from `input` (any path) to `out` in the temp dir. */
  async function renderFrom(
    input: string,
    model: BuildModel,
    out: string,
    edit: (args: string[]) => string[] = (a) => a,
  ): Promise<string> {
    const output = join(dir, out);
    await execFileAsync(toolPaths().ffmpegPath, edit(renderArgs({ model, input, output })));
    return output;
  }

  /** The same probe without any per-stream duration (no `duration`, no mkv `DURATION` tag). */
  function withoutStreamDurations(probe: ProbeResult, path: string): ProbeResult {
    const raw = probe.raw as { format: unknown; streams: Record<string, unknown>[] };
    const streams = raw.streams.map(({ duration: _d, tags, ...s }) => {
      const { DURATION: _t, ...rest } = (tags ?? {}) as Record<string, unknown>;
      return { ...s, tags: rest };
    });
    const stripped = { ...probe, raw: { ...raw, streams } } as ProbeResult;
    sourcePaths.set(stripped, path);
    return stripped;
  }

  /** mpegts has no default flag: the model makes its audio the default, as Track cleanup would. */
  function tsModel(source: ProbeResult): BuildModel {
    return withStream(modelFromProbe(source), 1, { default: true });
  }

  let hevcTs = '';
  async function hevcMpegts(): Promise<string> {
    hevcTs ||= await generate('hevc.m2ts', { video: 8, audio: 8, format: 'mpegts', hevc: true });
    return hevcTs;
  }

  it('a remux of an mpegts source with a non-zero start_time verifies', async () => {
    const ts = await hevcMpegts();
    const source = await probeSource(ts);
    const start = Number((source.raw as { format: { start_time: string } }).format.start_time);
    expect(start).toBeGreaterThan(1);
    const model = tsModel(source);
    const out = await renderFrom(ts, model, 'from-ts.mkv');
    expect(await verify(out, model, source)).toMatchObject({ ok: true, warnings: [] });
  });

  it('a healthy HEVC mpegts decodes cleanly at its end (decode-end starts at a keyframe)', async () => {
    const ts = await hevcMpegts();
    const source = await probeSource(ts);
    // Verified against itself: only the missing default flag (mpegts has none) may fail.
    const result = await verify(ts, modelFromProbe(source), source);
    expect(result).toMatchObject({
      ok: false,
      failures: [{ check: 'defaults', message: '0 default audio tracks, expected exactly one' }],
    });
  });

  it('a broken audio track in an output from a healthy HEVC mpegts is output-invalid', async () => {
    const ts = await hevcMpegts();
    const source = await probeSource(ts);
    const model = tsModel(source);
    const clean = await renderFrom(ts, model, 'from-ts-clean.mkv');
    // biome-ignore format: flag/value pairs
    const out = await ffmpeg([
      '-i', clean, '-map', '0', '-c', 'copy', '-bsf:a:0', 'noise=amount=4',
      join(dir, 'from-ts-broken.mkv'),
    ]);
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
    if (result.ok) return;
    expect(result.failures.length).toBeGreaterThan(0);
    expect(checks(result.failures).every((c) => c.startsWith('decode-'))).toBe(true);
  });

  it('a stream that ends before the container is compared at its own end', async () => {
    const src = await generate('early-audio.mkv', { video: 8, audio: 3, format: 'matroska' });
    const source = await probeSource(src);
    const model = modelFromProbe(source);
    const faithful = await renderFrom(src, model, 'early-audio-faithful.mkv');
    expect(await verify(faithful, model, source)).toMatchObject({ ok: true, warnings: [] });

    // biome-ignore format: flag/value pairs
    const cut = await ffmpeg([
      '-i', src, '-t', '1.5', '-i', src, '-map', '0:0', '-map', '1:1', '-c', 'copy',
      join(dir, 'early-audio-cut.mkv'),
    ]);
    const message = /^output #1 \(audio #1\) ends at 1\.\d\ds, the source stream at 3\.\d\ds$/;
    const result = await verify(cut, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid' });
    if (result.ok) return;
    expect(result.failures).toEqual([
      { check: 'duration', message: expect.stringMatching(message) },
    ]);

    // Without per-stream durations the audio end is searched for backwards from the file end.
    const bare = withoutStreamDurations(source, src);
    expect(await verify(faithful, model, bare)).toMatchObject({ ok: true, warnings: [] });
    const again = await verify(cut, model, bare);
    expect(again).toMatchObject({ ok: false, kind: 'output-invalid' });
    if (again.ok) return;
    expect(again.failures).toEqual([
      { check: 'duration', message: expect.stringMatching(message) },
    ]);
  });

  it('a stream end mismatch is output-invalid even when the source stream ends before the file', async () => {
    const src = await generate('audio-7.mkv', { video: 8, audio: 7, format: 'matroska' });
    const source = await probeSource(src);
    const model = modelFromProbe(source);
    // biome-ignore format: flag/value pairs
    const cut = await ffmpeg([
      '-i', src, '-t', '6.5', '-i', src, '-map', '0:0', '-map', '1:1', '-c', 'copy',
      join(dir, 'audio-7-cut.mkv'),
    ]);
    const result = await verify(cut, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(['duration']);
  });

  it('a damaged source does not explain an output that also fails another check', async () => {
    // biome-ignore format: flag/value pairs
    const damaged = await ffmpeg([
      '-i', fixturePath('compliant.mkv'), '-map', '0', '-c', 'copy', '-bsf:a:1', 'noise=amount=4',
      join(dir, 'damaged-source-2.mkv'),
    ]);
    const source = await probeSource(damaged);
    const model = modelFromProbe(source);
    const out = await renderFrom(damaged, model, 'damaged-wrong-default.mkv', (args) =>
      setOption(setOption(args, '-disposition:1', '0'), '-disposition:2', 'default'),
    );
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid' });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(
      expect.arrayContaining(['stream-match', 'decode-start', 'decode-end']),
    );
  });

  it('a broken output stream is not explained by damage on a different source stream', async () => {
    // biome-ignore format: flag/value pairs
    const damaged = await ffmpeg([
      '-i', fixturePath('compliant.mkv'), '-map', '0', '-c', 'copy', '-bsf:a:1', 'noise=amount=4',
      join(dir, 'damaged-source-3.mkv'),
    ]);
    const source = await probeSource(damaged);
    const model = modelFromProbe(source);
    // The output's audio #1 is broken; the source's audio #1 is intact (its audio #2 is not).
    // biome-ignore format: flag/value pairs
    const out = await ffmpeg([
      '-i', fixturePath('compliant.mkv'), '-map', '0', '-c', 'copy', '-bsf:a:0', 'noise=amount=4',
      join(dir, 'broken-first-audio.mkv'),
    ]);
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(['decode-start', 'decode-end']);
  });

  /** Overwrites `bytes` bytes at the middle of a copy of `path` with zeros; returns the copy. */
  async function damageMiddle(path: string, name: string, bytes = 30_000): Promise<string> {
    const { open } = await import('node:fs/promises');
    const out = join(dir, name);
    await copyFile(path, out);
    const fh = await open(out, 'r+');
    try {
      const size = (await fh.stat()).size;
      await fh.write(Buffer.alloc(bytes), 0, bytes, Math.floor(size / 2));
    } finally {
      await fh.close();
    }
    return out;
  }

  it('an x265 (open-GOP) re-encode of a 12 s file passes the sampled spots and the full decode', async () => {
    const src = await generate('hevc12.mkv', {
      video: 12,
      audio: 12,
      format: 'matroska',
      hevc: true,
    });
    const source = await probeSource(src);
    const model = withStream(modelFromProbe(source), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      quality: 32,
      preset: 'ultrafast',
      pixelFormat: 'yuv420p',
    });
    const out = await renderFrom(src, model, 'hevc12-out.mkv');
    const result = await verifyOutput({
      outputPath: out,
      sourcePath: src,
      model,
      sourceProbe: source,
      fullDecode: true,
      ...toolPaths(),
    });
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it('damage in the middle of the output fails decode-sample and decode-full (start and end are fine)', async () => {
    const src = await generate('mid12.mkv', { video: 12, audio: 12, format: 'matroska' });
    const source = await probeSource(src);
    const model = modelFromProbe(source);
    const clean = await renderFrom(src, model, 'mid12-out.mkv');
    const out = await damageMiddle(clean, 'mid12-damaged.mkv');
    const result = await verifyOutput({
      outputPath: out,
      sourcePath: src,
      model,
      sourceProbe: source,
      fullDecode: true,
      ...toolPaths(),
    });
    expect(result).toMatchObject({ ok: false, kind: 'output-invalid', sourceFailures: [] });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(['decode-sample', 'decode-full']);
  });

  it('a remux of a source damaged in the middle is source-damaged', async () => {
    const clean = await generate('srcmid12.mkv', { video: 12, audio: 12, format: 'matroska' });
    const src = await damageMiddle(clean, 'srcmid12-damaged.mkv');
    const source = await probeSource(src);
    const model = modelFromProbe(source);
    const out = await renderFrom(src, model, 'srcmid12-out.mkv');
    const result = await verify(out, model, source);
    expect(result).toMatchObject({ ok: false, kind: 'source-damaged' });
    if (result.ok) return;
    expect(checks(result.failures)).toEqual(['decode-sample']);
    expect(result.sourceFailures.map((f) => f.check)).toContain('decode-sample');
  });

  it('a source whose header outlasts its streams verifies with a stale-header warning', async () => {
    const long = await generate('long.mkv', { video: 10, audio: 10, format: 'matroska' });
    const stale = join(dir, 'stale.mkv');
    await copyFile(long, stale);
    await truncate(stale, Math.floor((await stat(long)).size * 0.5));
    const source = await probeSource(stale);
    expect(source.durationSeconds).toBeCloseTo(10, 0);
    const model = modelFromProbe(source);
    const out = await renderFrom(stale, model, 'from-stale.mkv');
    const result = await verify(out, model, source);
    expect(result.ok ? [] : result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^the source header says 10\.\d\ds, but its streams end at [3-7]\.\d\ds$/,
      ),
    ]);
  });
});

describe('streamFailures: the chapter track an mp4 muxer adds (the Devil Wears Prada 2 failure)', () => {
  const mp4 = (streams: Parameters<typeof probeOf>[0]) =>
    probeOf(streams, { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', chapters: 2 });

  it('an extra bin_data track in an mp4 output is the chapter track, not a stream gone wrong', () => {
    const source = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac' },
    ]);
    const out = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac' },
      { type: 'data', codec: 'bin_data' },
    ]);
    expect(streamFailures(modelFromProbe(source), out)).toEqual([]);
  });

  it("with the source's own chapter track and a cover, the streams still line up", () => {
    const source = mp4([
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'eac3' },
      { type: 'data', codec: 'bin_data' },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
    ]);
    const out = mp4([
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'eac3' },
      { type: 'data', codec: 'bin_data' },
      { type: 'data', codec: 'bin_data' },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
    ]);
    expect(streamFailures(modelFromProbe(source), out)).toEqual([]);
  });

  it('a missing audio track in an mp4 still fails, and an mkv keeps counting data streams', () => {
    const source = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac' },
    ]);
    const out = mp4([
      { type: 'video', codec: 'h264' },
      { type: 'data', codec: 'bin_data' },
    ]);
    expect(streamFailures(modelFromProbe(source), out).map((f) => f.check)).toContain(
      'stream-count',
    );
    const mkv = probeOf([{ type: 'video' }, { type: 'audio' }]);
    const mkvOut = probeOf([
      { type: 'video' },
      { type: 'audio' },
      { type: 'data', codec: 'bin_data' },
    ]);
    expect(streamFailures(modelFromProbe(mkv), mkvOut).map((f) => f.check)).toContain(
      'stream-count',
    );
  });
});
