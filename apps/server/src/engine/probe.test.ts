import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath, fixturesAvailable, toolPaths } from './fixtures.ts';
import { jobProbeOf, languageOf, parseProbe, probeFailure, probeFile } from './probe.ts';

const tigger: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/ffprobe-tigger-pooh.json', import.meta.url), 'utf8'),
);

/** A minimal ffprobe document around the given streams and format fields. */
function doc(streams: Record<string, unknown>[], format: Record<string, unknown> = {}) {
  return {
    streams,
    chapters: [],
    format: {
      format_name: 'matroska,webm',
      duration: '3.000000',
      size: '1000',
      bit_rate: '2667',
      ...format,
    },
  };
}

describe('parseProbe on the captured tigger-pooh output', () => {
  const probe = parseProbe(tigger);

  it('reads the container and every stream', () => {
    expect(probe.container).toBe('mp4');
    expect(probe.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    // 2 video (HEVC + PNG cover), 20 audio, 21 subtitles.
    expect(probe.streams.length).toBe(43);
    expect(probe.chapters).toBe(0);
    expect(probe.durationSeconds).toBeCloseTo(3, 1);
    expect(probe.sizeBytes).toBe(379411);
    expect(probe.raw).toBe(tigger);
  });

  it('maps an audio stream', () => {
    expect(probe.streams[1]).toMatchObject({
      index: 1,
      type: 'audio',
      codec: 'aac',
      language: 'eng',
      default: false,
      profile: 'lc',
      channels: expect.any(Number),
      sampleRate: expect.any(Number),
      width: null,
      hdr: null,
      bitrateKbps: 32.269,
      frameRate: null,
    });
  });

  it('keeps the Turkish audio default', () => {
    const tur = probe.streams.filter((s) => s.type === 'audio' && s.language === 'tur');
    expect(tur).toHaveLength(1);
    expect(tur[0]?.default).toBe(true);
  });

  it('maps the HEVC video stream', () => {
    expect(probe.streams[0]).toMatchObject({
      type: 'video',
      codec: 'hevc',
      language: null,
      default: true,
      attachedPic: false,
      profile: 'main',
      level: 60,
      pixelFormat: 'yuv420p',
      bitDepth: 8,
      hdr: 'none',
      frameRate: 24,
    });
  });

  it('marks the PNG cover as an attached picture', () => {
    const png = probe.streams.find((s) => s.codec === 'png');
    expect(png).toMatchObject({
      type: 'video',
      attachedPic: true,
      level: null,
      profile: null,
      dispositions: [],
    });
  });

  it('reads the untagged subtitle as no language', () => {
    const subs = probe.streams.filter((s) => s.type === 'subtitle');
    expect(subs).toHaveLength(21);
    expect(subs.filter((s) => s.language === null)).toHaveLength(1);
  });
});

describe('parseProbe on hand-written streams', () => {
  it('normalises language and profile and collects other dispositions', () => {
    const probe = parseProbe(
      doc([
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'hevc',
          profile: 'Main 10',
          level: 153,
          width: 3840,
          height: 2160,
          pix_fmt: 'yuv420p10le',
          color_transfer: 'smpte2084',
          avg_frame_rate: '24000/1001',
          tags: { language: 'ger', title: 'Main' },
          disposition: { default: 1, forced: 0, comment: 1, attached_pic: 0, original: 0 },
        },
      ]),
    );
    expect(probe.streams[0]).toMatchObject({
      language: 'deu',
      title: 'Main',
      profile: 'main10',
      level: 153,
      default: true,
      forced: false,
      dispositions: ['comment'],
      width: 3840,
      height: 2160,
      bitDepth: 10,
      hdr: 'hdr10',
    });
    expect(probe.streams[0]?.frameRate).toBeCloseTo(23.976, 3);
  });

  it('an empty title tag is no title (final review M8)', () => {
    const probe = parseProbe(
      doc([{ index: 0, codec_type: 'audio', codec_name: 'aac', tags: { title: '' } }]),
    );
    expect(probe.streams[0]?.title).toBeNull();
  });

  it('detects HLG and Dolby Vision', () => {
    const probe = parseProbe(
      doc([
        { index: 0, codec_type: 'video', codec_name: 'hevc', color_transfer: 'arib-std-b67' },
        {
          index: 1,
          codec_type: 'video',
          codec_name: 'hevc',
          color_transfer: 'smpte2084',
          side_data_list: [{ side_data_type: 'DOVI configuration record' }],
        },
      ]),
    );
    expect(probe.streams.map((s) => s.hdr)).toEqual(['hlg', 'dolby-vision']);
  });

  it('prefers bits_per_raw_sample for bit depth', () => {
    const probe = parseProbe(
      doc([
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          pix_fmt: 'yuv420p',
          bits_per_raw_sample: '10',
        },
        { index: 1, codec_type: 'audio', codec_name: 'flac', bits_per_raw_sample: '24' },
        { index: 2, codec_type: 'audio', codec_name: 'aac' },
      ]),
    );
    expect(probe.streams.map((s) => s.bitDepth)).toEqual([10, 24, null]);
  });

  it('maps attachment and data streams', () => {
    const probe = parseProbe(
      doc([
        { index: 0, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'a.ttf' } },
        { index: 1, codec_type: 'data', codec_name: 'bin_data' },
        { index: 2, codec_type: 'attachment' },
        { index: 3, codec_type: 'unknown', codec_name: 'x' },
      ]),
    );
    expect(probe.streams.map((s) => [s.type, s.codec])).toEqual([
      ['attachment', 'ttf'],
      ['data', 'bin_data'],
      ['attachment', 'unknown'],
      ['data', 'x'],
    ]);
  });

  it.each([
    ['matroska,webm', 'mkv'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'mp4'],
    ['mpegts', 'ts'],
    ['avi', 'avi'],
    ['asf', 'wmv'],
    ['flv', 'flv'],
    ['webm', 'webm'],
    ['ogg', 'ogg'],
    ['mpeg,vob', 'mpeg'],
  ])('maps format_name %s to container %s', (formatName, container) => {
    expect(parseProbe(doc([], { format_name: formatName })).container).toBe(container);
  });

  it('falls back to the mkv statistics tag (BPS, or BPS-<lang>) for a stream bit rate', () => {
    const probe = parseProbe(
      doc([
        { index: 0, codec_type: 'video', codec_name: 'hevc', tags: { BPS: '4934829' } },
        { index: 1, codec_type: 'audio', codec_name: 'ac3', tags: { 'BPS-eng': '640000' } },
        {
          index: 2,
          codec_type: 'audio',
          codec_name: 'aac',
          bit_rate: '128000',
          tags: { BPS: '1' },
        },
        { index: 3, codec_type: 'audio', codec_name: 'aac', tags: { BPS: 'n/a' } },
      ]),
    );
    expect(probe.streams.map((s) => s.bitrateKbps)).toEqual([4934.829, 640, 128, null]);
  });

  it('reads the format bit rate, chapters and missing values', () => {
    const probe = parseProbe({
      streams: [],
      chapters: [{ id: 0 }, { id: 1 }],
      format: { format_name: 'mpegts', duration: '12.5', size: '2048' },
    });
    expect(probe).toMatchObject({
      container: 'ts',
      durationSeconds: 12.5,
      sizeBytes: 2048,
      bitrateKbps: null,
      chapters: 2,
    });
    expect(parseProbe(doc([])).bitrateKbps).toBeCloseTo(2.667, 3);
  });

  it.each([
    ['not an object', 'nope'],
    ['no format', { streams: [] }],
    ['no streams', { format: { format_name: 'avi' } }],
    ['no format name', { streams: [], format: {} }],
    ['a stream that is not an object', doc(['audio' as unknown as Record<string, unknown>])],
    ['a stream without an index', doc([{ codec_type: 'audio', codec_name: 'aac' }])],
  ])('rejects %s', (_name, json) => {
    expect(() => parseProbe(json)).toThrow('unrecognised ffprobe output');
  });
});

describe('languageOf', () => {
  it('normalises the language tag', () => {
    expect(languageOf({ language: 'ger' })).toBe('deu');
    expect(languageOf({ language: 'eng' })).toBe('eng');
    expect(languageOf({ language: 'und' })).toBeNull();
    expect(languageOf({ title: 'x' })).toBeNull();
    expect(languageOf(undefined)).toBeNull();
  });
});

describe('probeFile with a fake exec', () => {
  it('runs ffprobe with the documented arguments and parses its output', async () => {
    const calls: [string, string[]][] = [];
    const probe = await probeFile('/media/a.mkv', {
      ffprobePath: '/opt/ffprobe',
      exec: async (file, args) => {
        calls.push([file, args]);
        return { stdout: JSON.stringify(doc([])), stderr: '' };
      },
    });
    expect(calls).toEqual([
      [
        '/opt/ffprobe',
        [
          '-v',
          'error',
          '-show_format',
          '-show_streams',
          '-show_chapters',
          '-of',
          'json',
          '/media/a.mkv',
        ],
      ],
    ]);
    expect(probe.container).toBe('mkv');
  });

  it('rejects output that is not JSON', async () => {
    await expect(
      probeFile('/a.mkv', {
        ffprobePath: 'ffprobe',
        exec: async () => ({ stdout: 'garbage', stderr: '' }),
      }),
    ).rejects.toThrow('unrecognised ffprobe output');
  });
});

describe.skipIf(!fixturesAvailable())('probeFile', () => {
  it('probes compliant.mkv', async () => {
    const probe = await probeFile(fixturePath('compliant.mkv'), {
      ffprobePath: toolPaths().ffprobePath,
    });
    expect(probe.container).toBe('mkv');
    const audio = probe.streams.filter((s) => s.type === 'audio');
    expect(audio.map((s) => [s.language, s.default])).toEqual([
      ['eng', true],
      ['deu', false],
    ]);
    const subs = probe.streams.filter((s) => s.type === 'subtitle');
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.codec === 'subrip')).toBe(true);
    expect(Math.abs(probe.durationSeconds - 3)).toBeLessThan(0.2);
  });
});

describe('probeFailure', () => {
  const path = '/media/movies/Broken (2020)/broken-file.mkv';
  /** What node's execFile rejects with: the whole command line, then ffprobe's stderr. */
  const execError = (stderr: string) =>
    Object.assign(
      new Error(
        `Command failed: ffprobe -v error -show_format -show_streams -show_chapters -of json ${path}\n${stderr}`,
      ),
      { code: 1, stderr },
    );

  it("keeps ffprobe's last error line, without the command, the path or the demuxer address", () => {
    const err = execError(
      `[matroska,webm @ 0x90903c000] EBML header parsing failed\n${path}: Invalid data found when processing input\n`,
    );
    expect(probeFailure(err, path)).toBe('Invalid data found when processing input');
  });

  it('reads the stderr out of the message when the error has no stderr field', () => {
    const err = new Error(
      `Command failed: ffprobe -v error -of json ${path}\n${path}: No such file or directory\n`,
    );
    expect(probeFailure(err, path)).toBe('No such file or directory');
  });

  it('names a timeout, a missing ffprobe and output that is not JSON in plain words', () => {
    expect(
      probeFailure(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), path),
    ).toBe('ffprobe took too long and was stopped');
    expect(
      probeFailure(Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' }), path),
    ).toBe('ffprobe was not found');
    expect(probeFailure(new Error('unrecognised ffprobe output'), path)).toBe(
      'unrecognised ffprobe output',
    );
  });

  it('never returns more than one short line', () => {
    const long = 'x'.repeat(500);
    expect(probeFailure(execError(`${long}\n`), path).length).toBeLessThanOrEqual(200);
  });
});

describe('jobProbeOf', () => {
  const stream = (index: number, tags: Record<string, string>) => ({
    index,
    codec_type: 'audio',
    codec_name: 'truehd',
    tags,
  });

  it('drops the raw JSON and gives each stream its Matroska statistics bitrate, unchecked', () => {
    const probe = parseProbe(
      doc([
        stream(0, { BPS: '17900000', NUMBER_OF_BYTES: '15200000000' }),
        // Older mkvmerge versions suffix the statistics tags with the language.
        stream(1, { 'BPS-eng': '3460000' }),
        stream(2, { NUMBER_OF_BYTES: '375000', DURATION: '00:00:03.000000000' }),
        stream(3, { language: 'eng' }),
        stream(4, { BPS: 'n/a' }),
      ]),
    );
    const summary = jobProbeOf(probe);
    expect(summary).not.toHaveProperty('raw');
    expect(summary.container).toBe('mkv');
    expect(summary.streams.map((s) => s.tagBitrateKbps)).toEqual([
      17_900,
      3_460,
      1_000,
      null,
      null,
    ]);
  });
});

describe('parseProbe marks images stored as video tracks (imageTrack)', () => {
  const video = (index: number, extra: Record<string, unknown> = {}) => ({
    index,
    codec_type: 'video',
    codec_name: 'hevc',
    disposition: { default: 0, attached_pic: 0 },
    ...extra,
  });
  const audio = { index: 9, codec_type: 'audio', codec_name: 'aac' };
  const marks = (streams: Record<string, unknown>[]) =>
    parseProbe(doc(streams)).streams.map((s) => s.imageTrack === true);

  it('an image MIMETYPE or FILENAME tag marks a video track, in any case, whatever its codec', () => {
    expect(
      marks([
        video(0),
        video(1, { tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' } }),
        video(2, { tags: { mimetype: 'image/png' } }),
        video(3, { tags: { filename: 'Poster.WEBP' } }),
        audio,
      ]),
    ).toEqual([false, true, true, true, false]);
  });

  it('other tags, other types and flagged covers are not marked', () => {
    expect(
      marks([
        video(0, { tags: { FILENAME: 'feature.mkv', MIMETYPE: 'video/x-matroska' } }),
        video(1, { tags: { FILENAME: 'jpg' } }),
        {
          index: 2,
          codec_type: 'attachment',
          codec_name: 'mjpeg',
          tags: { MIMETYPE: 'image/jpeg' },
        },
        video(3, {
          codec_name: 'png',
          disposition: { attached_pic: 1 },
          tags: { MIMETYPE: 'image/png' },
        }),
      ]),
    ).toEqual([false, false, false, false]);
  });

  it('nb_frames 1 next to a video with more (or unknown) frames marks the one-frame track', () => {
    expect(marks([video(0, { nb_frames: '156279' }), video(1, { nb_frames: '1' })])).toEqual([
      false,
      true,
    ]);
    expect(marks([video(0), video(1, { nb_frames: '1' })])).toEqual([false, true]);
  });

  it('a lone one-frame video, two one-frame videos, and a short duration are not marked', () => {
    expect(marks([video(0, { nb_frames: '1' }), audio])).toEqual([false, false]);
    expect(marks([video(0, { nb_frames: '1' }), video(1, { nb_frames: '1' })])).toEqual([
      false,
      false,
    ]);
    // ffprobe's mkv stream durations are not trusted (a 1 ms track reads as the whole file).
    expect(
      marks([
        video(0),
        video(1, { duration: '0.001000', tags: { DURATION: '00:00:00.001000000' } }),
      ]),
    ).toEqual([false, false]);
  });
});
