import { describe, expect, it } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { modelFromProbe } from '../model/model.ts';
import { packetRows, probeOf } from '../testing/builders.ts';
import { mediaMaps } from './decode-checks.ts';
import { confirmSourceDamage, verifyOutput } from './verify.ts';

describe('decode passes never map a cover stored as a video track', () => {
  // A cover an earlier encode turned into an ordinary HEVC video track (image tags, no
  // attached_pic). ffmpeg's `0:V?` maps it; the null muxer then queues every decoded frame of the
  // film waiting for the cover's next frame until memory runs out.
  const ffprobeStreams = [
    { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      tags: { language: 'eng' },
      disposition: { default: 1 },
    },
    {
      index: 2,
      codec_type: 'video',
      codec_name: 'hevc',
      width: 640,
      height: 360,
      tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' },
      disposition: { attached_pic: 0 },
    },
  ];
  const source = probeOf(
    [
      { type: 'video', default: true },
      { type: 'audio', language: 'eng', default: true },
      { type: 'video', codec: 'hevc', width: 640, height: 360, imageTrack: true },
    ],
    {
      durationSeconds: 60,
      raw: { format: { duration: '60.000000', start_time: '0.000000' }, streams: ffprobeStreams },
    },
  );

  /** A fake ffprobe/ffmpeg over a file with the streams above; records every ffmpeg argv. */
  function tools() {
    const runs: string[][] = [];
    const exec: Exec = async (file, args) => {
      if (args.includes('-show_format')) {
        const json = {
          format: { format_name: 'matroska,webm', duration: '60.000000', start_time: '0.000000' },
          streams: ffprobeStreams,
        };
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      if (file === 'ffmpeg') runs.push(args);
      if (args.includes('packet=stream_index,pts_time,duration_time')) {
        return { stdout: packetRows('59.960000,0.040000'), stderr: '' };
      }
      if (args.includes('-read_intervals'))
        return { stdout: packetRows('50.000000,1000,K__'), stderr: '' };
      return { stdout: '', stderr: '' };
    };
    return { exec, runs };
  }

  /** The `-map` values of each decode run (the null muxer). */
  const decodeMaps = (runs: string[][]) =>
    runs.filter((a) => a.includes('null')).map((a) => a.filter((_, i) => a[i - 1] === '-map'));

  it('verifyOutput decodes the film and its audio by index, never the cover', async () => {
    const { exec, runs } = tools();
    await verifyOutput({
      outputPath: '/tmp/job/out.mkv',
      sourcePath: '/lib/in.mkv',
      model: modelFromProbe(source),
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      fullDecode: true,
      exec,
    });
    const maps = decodeMaps(runs);
    expect(maps.length).toBeGreaterThanOrEqual(3);
    for (const m of maps) expect(m).toEqual(['0:0', '0:1']);
  });

  it('confirmSourceDamage decodes the film and its audio by index, never the cover', async () => {
    const { exec, runs } = tools();
    await confirmSourceDamage({
      sourcePath: '/lib/in.mkv',
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      times: [30],
      exec,
    });
    const maps = decodeMaps(runs);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toEqual(['0:0', '0:1']);
  });
});

describe('byte-seek sources are mapped by stream id', () => {
  // An mpegts file opened mid-way: the demuxer numbers streams in the order it meets them, so an
  // index from the whole-file probe can name another stream. The id (PID) stays the same.
  const ffprobeStreams = [
    { index: 0, id: '0x100', codec_type: 'video', codec_name: 'h264', disposition: { default: 1 } },
    { index: 1, id: '0x101', codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
    { index: 2, id: '0x102', codec_type: 'audio', codec_name: 'ac3', tags: { language: 'deu' } },
  ];
  const source = probeOf(
    [
      { type: 'video', default: true },
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'deu' },
    ],
    {
      durationSeconds: 60,
      formatName: 'mpegts',
      raw: { format: { duration: '60.000000', start_time: '0.000000' }, streams: ffprobeStreams },
    },
  );

  it('mediaMaps uses ids when asked, and indexes otherwise', () => {
    expect(mediaMaps(source)).toEqual(['0:0', '0:1', '0:2']);
    expect(mediaMaps(source, true)).toEqual(['0:i:0x100', '0:i:0x101', '0:i:0x102']);
  });

  it('mediaMaps keeps streams that share an id apart by index', () => {
    const shared = probeOf(
      [
        { type: 'video', default: true },
        { type: 'audio', language: 'eng' },
        { type: 'audio', language: 'deu' },
      ],
      {
        durationSeconds: 60,
        raw: {
          format: { duration: '60.000000' },
          streams: ffprobeStreams.map((s) => (s.index === 2 ? { ...s, id: '0x101' } : s)),
        },
      },
    );
    expect(mediaMaps(shared, true)).toEqual(['0:i:0x100', '0:1', '0:2']);
  });

  it('confirmSourceDamage maps a byte-seek source by id', async () => {
    const runs: string[][] = [];
    const exec: Exec = async (file, args) => {
      if (args.includes('-show_format')) {
        const json = {
          format: { format_name: 'mpegts', duration: '60.000000', start_time: '0.000000' },
          streams: ffprobeStreams,
        };
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      if (file === 'ffmpeg') runs.push(args);
      if (args.includes('packet=stream_index,pts_time,duration_time')) {
        return { stdout: packetRows('59.960000,0.040000'), stderr: '' };
      }
      if (args.includes('-read_intervals'))
        return { stdout: packetRows('20.000000,1000,K__'), stderr: '' };
      return { stdout: '', stderr: '' };
    };
    await confirmSourceDamage({
      sourcePath: '/lib/in.ts',
      sourceProbe: source,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      times: [30],
      exec,
    });
    const maps = runs
      .filter((a) => a.includes('null'))
      .map((a) => a.filter((_, i) => a[i - 1] === '-map'));
    expect(maps).toEqual([['0:i:0x100', '0:i:0x101', '0:i:0x102']]);
  });
});
