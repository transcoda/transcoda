import type { ProbeResult } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { MemoryLimitError } from '../../platform/memory-guard.ts';
import { modelFromProbe } from '../model/model.ts';
import { packetRows, probeOf } from '../testing/builders.ts';
import { confirmSourceDamage, type VerifyProgress, verifyOutput } from './verify.ts';

/** How a source decode can fail without saying anything about the file's content. */
const UNSURE: [string, object][] = [
  ['killed (the verify timeout)', { killed: true, signal: 'SIGKILL', code: null }],
  ['stopped by the memory guard', { ...new MemoryLimitError(2 ** 32, '[hevc @ 0x1] x\n') }],
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
      if (at >= 0 && args.includes('packet=stream_index,pts_time,duration_time')) {
        const n = count.get(path) ?? 0;
        count.set(path, n + 1);
        reads.push(`${path} ${args[at + 1]}`);
        return { stdout: packetRows(ends(path, n)), stderr: '' };
      }
      if (at >= 0) return { stdout: packetRows('7190.000000,1000,K__'), stderr: '' };
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
  it('reads stream ends without selecting a stream, keeping only the asked-for stream', async () => {
    // A Matroska file indexes only its video: `-select_streams 1` makes ffprobe seek by the audio
    // stream and read the whole file from its start, past the verify timeout on a large remux.
    const streams = [
      { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
      { index: 1, codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
    ];
    const source = probeOf(
      [
        { type: 'video', default: true },
        { type: 'audio', default: true },
      ],
      {
        durationSeconds: 60,
        raw: { format: { duration: '60.000000', start_time: '0.000000' }, streams },
      },
    );
    const probes: string[][] = [];
    const exec: Exec = async (file, args) => {
      const path = args.at(-1) as string;
      if (args.includes('-show_format')) {
        const json = {
          format: { format_name: 'matroska,webm', duration: '60.000000', start_time: '0.000000' },
          streams,
        };
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      if (file === 'ffprobe') probes.push(args);
      if (args.includes('packet=stream_index,pts_time,duration_time')) {
        // The output's audio stops at 30 s; its video row alone would pass.
        const audio = path === '/lib/in.mkv' ? '59.980000,0.020000' : '30.000000,0.020000';
        return { stdout: `0,59.960000,0.040000\n1,${audio}\n`, stderr: '' };
      }
      if (args.includes('-read_intervals'))
        return { stdout: packetRows('50.000000,1000,K__'), stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const result = await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      exec,
    });
    expect(probes.filter((a) => a.includes('-read_intervals')).length).toBeGreaterThan(0);
    for (const args of probes) expect(args).not.toContain('-select_streams');
    expect(result).toMatchObject({
      ok: false,
      failures: [
        {
          check: 'duration',
          message: 'output #1 (audio #1) ends at 30.02s, the source stream at 60.00s',
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
