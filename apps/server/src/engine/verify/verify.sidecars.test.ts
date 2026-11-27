import type { BuildModel } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { modelFromProbe } from '../model/model.ts';
import { packetRows, probeOf, withSidecar } from '../testing/builders.ts';
import { verifyOutput } from './verify.ts';

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
      if (args.includes('packet=stream_index,pts_time,duration_time')) {
        return { stdout: packetRows('59.960000,0.040000'), stderr: '' };
      }
      if (args.includes('-read_intervals'))
        return { stdout: packetRows('50.000000,1000,K__'), stderr: '' };
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
