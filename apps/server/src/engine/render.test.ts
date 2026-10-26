import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BuildModel } from '@transcoda/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitToContainer, modelFromProbe, outputOrder } from './build-model.ts';
import { fixturePath, fixturesAvailable, tempDir, toolPaths } from './fixtures.ts';
import { probeFile } from './probe.ts';
import {
  coverExtractArgs,
  outputExtension,
  RenderError,
  renderArgs,
  renderCommandLine,
} from './render.ts';
import { probeOf, withSidecar, withStream } from './test-helpers.ts';

const execFileAsync = promisify(execFile);

/** The args after the fixed head (`-nostdin … -map_chapters 0`) and before `-f`. */
function streamArgs(args: string[]): string[] {
  return args.slice(args.indexOf('-map_chapters') + 2, args.lastIndexOf('-f'));
}

const movie = probeOf([
  { type: 'video', codec: 'hevc', default: true },
  { type: 'audio', codec: 'eac3', language: 'eng', title: 'Atmos', channels: 6, default: true },
  { type: 'audio', codec: 'ac3', language: 'deu', channels: 6 },
  { type: 'audio', codec: 'ac3', language: 'tur', channels: 6 },
  { type: 'subtitle', codec: 'subrip', language: 'eng' },
]);

describe('renderArgs snapshots', () => {
  it('(a) identity remux mkv→mp4 with mov_text conversion', () => {
    const model = withStream({ ...modelFromProbe(movie), container: 'mp4' }, 4, {
      mode: 'convert',
      codec: 'mov_text',
    });
    expect(
      renderArgs({ model, input: '/lib/Movie.mkv', output: '/tc/j1/out.mp4' }),
    ).toMatchSnapshot();
  });

  it('(b) drop two audio + set default', () => {
    let model = modelFromProbe(movie);
    model = withStream(model, 1, { keep: false });
    model = withStream(model, 3, { keep: false });
    model = withStream(model, 2, { default: true });
    expect(
      renderArgs({ model, input: '/lib/Movie.mkv', output: '/tc/j1/out.mkv' }),
    ).toMatchSnapshot();
  });

  it('(c) libx265 crf 24 preset medium + aac 160k stereo downmix', () => {
    let model = modelFromProbe(movie);
    model = withStream(model, 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      quality: 24,
      preset: 'medium',
      pixelFormat: 'yuv420p10le',
    });
    model = withStream(model, 1, {
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
    });
    expect(
      renderArgs({ model, input: '/lib/Movie.mkv', output: '/tc/j1/out.mkv' }),
    ).toMatchSnapshot();
  });

  it('(d) hevc_nvenc constqp 24', () => {
    const model = withStream(modelFromProbe(movie), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: 24,
      preset: 'p5',
    });
    expect(
      renderArgs({ model, input: '/lib/Movie.mkv', output: '/tc/j1/out.mkv' }),
    ).toMatchSnapshot();
  });
});

describe('renderArgs', () => {
  it('starts with the fixed head, model args and input, and ends with the format and output', () => {
    const model = {
      ...modelFromProbe(movie),
      globalArgs: ['-hwaccel', 'cuda'],
      inputArgs: ['-fflags', '+genpts'],
    };
    const args = renderArgs({ model, input: '/in.mkv', output: '/out.mkv' });
    expect(args.slice(0, 16)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-y',
      '-nostats',
      '-progress',
      'pipe:1',
      '-hwaccel',
      'cuda',
      '-fflags',
      '+genpts',
      '-i',
      '/in.mkv',
      '-map_metadata',
      '0',
      '-map_chapters',
      '0',
    ]);
    expect(args.slice(-3)).toEqual(['-f', 'matroska', '/out.mkv']);
    expect(renderArgs({ model, input: '/in.mkv', output: '/out.mkv' })).toEqual(args);
  });

  it('renders -map in model order, not source order', () => {
    let model = modelFromProbe(movie);
    model = withStream(model, 1, { order: 3 });
    model = withStream(model, 3, { order: 1 });
    const args = renderArgs({ model, input: '/in.mkv', output: '/out.mkv' });
    const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:0', '0:3', '0:2', '0:1', '0:4']);
    // Output #1 is the Turkish track: its metadata and disposition follow it.
    const tail = streamArgs(args);
    expect(tail).toContain('language=tur');
    expect(tail.slice(tail.indexOf('-c:1'), tail.indexOf('-c:2'))).toEqual([
      '-c:1',
      'copy',
      '-metadata:s:1',
      'language=tur',
      '-metadata:s:1',
      'title=',
      '-disposition:1',
      '0',
    ]);
  });

  it('null language writes language=und on mkv and mp4, so a source tag is cleared', () => {
    const p = probeOf([{ type: 'video', codec: 'h264', language: 'eng' }]);
    for (const container of ['mkv', 'mp4'] as const) {
      const model = withStream({ ...modelFromProbe(p), container }, 0, { language: null });
      const args = streamArgs(renderArgs({ model, input: '/i', output: `/o.${container}` }));
      expect(args.slice(args.indexOf('-c:0') + 2, args.indexOf('-c:0') + 4)).toEqual([
        '-metadata:s:0',
        'language=und',
      ]);
    }
  });

  it('attached_pic and comment dispositions are rendered, not cleared', () => {
    const p = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', dispositions: ['comment', 'hearing_impaired'] },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
    ]);
    // mp4 maps the cover as a stream (mkv attaches it; see the covers tests).
    const model = { ...modelFromProbe(p), container: 'mp4' as const };
    const args = renderArgs({ model, input: '/i', output: '/o.mp4' });
    const disposition = (i: number) => args[args.indexOf(`-disposition:${i}`) + 1];
    expect(disposition(0)).toBe('default');
    expect(disposition(1)).toBe('comment+hearing_impaired');
    expect(disposition(2)).toBe('attached_pic');
  });

  it('converts subrip to srt on mkv and renders pixel format only for converted streams', () => {
    const p = probeOf([
      { type: 'video', codec: 'h264', pixelFormat: 'yuv420p' },
      { type: 'subtitle', codec: 'mov_text' },
    ]);
    const model = withStream(modelFromProbe(p), 1, { mode: 'convert', codec: 'subrip' });
    const args = streamArgs(renderArgs({ model, input: '/i', output: '/o.mkv' }));
    expect(args).not.toContain('-pix_fmt:0');
    expect(args.slice(args.indexOf('-c:1'), args.indexOf('-c:1') + 2)).toEqual(['-c:1', 'srt']);
  });
});

describe('renderArgs: GPU decode', () => {
  const encode = (encoder: string) =>
    withStream(modelFromProbe(movie), 0, { mode: 'convert', codec: 'hevc', encoder, quality: 24 });
  /** The args just before the source's `-i`. */
  const beforeInput = (args: string[]) => args.slice(0, args.indexOf('-i'));

  it('an NVENC video encode decodes the source on the GPU (ffmpeg decodes on the CPU where the GPU cannot)', () => {
    const args = renderArgs({ model: encode('hevc_nvenc'), input: '/in.mkv', output: '/out.mkv' });
    expect(args.slice(args.indexOf('-i') - 2, args.indexOf('-i') + 2)).toEqual([
      '-hwaccel',
      'cuda',
      '-i',
      '/in.mkv',
    ]);
  });

  it('software and other hardware encoders keep decoding on the CPU', () => {
    for (const encoder of ['libx265', 'hevc_qsv', 'hevc_vaapi']) {
      const args = renderArgs({ model: encode(encoder), input: '/in.mkv', output: '/out.mkv' });
      expect(beforeInput(args)).not.toContain('-hwaccel');
    }
  });

  it('a copied video stream is not decoded, so it gets no GPU decode', () => {
    const args = renderArgs({ model: modelFromProbe(movie), input: '/in.mkv', output: '/out.mkv' });
    expect(beforeInput(args)).not.toContain('-hwaccel');
  });

  it('a model that already chooses a -hwaccel keeps its own and gets no second one', () => {
    for (const key of ['globalArgs', 'inputArgs'] as const) {
      const model = { ...encode('hevc_nvenc'), [key]: ['-hwaccel', 'vaapi'] };
      const args = renderArgs({ model, input: '/in.mkv', output: '/out.mkv' });
      expect(args.filter((a) => a === '-hwaccel')).toHaveLength(1);
      expect(args[args.indexOf('-hwaccel') + 1]).toBe('vaapi');
    }
  });

  it('a CUDA device decodes and encodes on that GPU: -hwaccel_device and NVENC -gpu', () => {
    const device = { kind: 'cuda', index: 1 } as const;
    const args = renderArgs({
      model: encode('hevc_nvenc'),
      input: '/in.mkv',
      output: '/o.mkv',
      device,
    });
    expect(args.slice(args.indexOf('-i') - 4, args.indexOf('-i'))).toEqual([
      '-hwaccel',
      'cuda',
      '-hwaccel_device',
      '1',
    ]);
    const gpu = args.indexOf('-gpu:0');
    expect(args.slice(gpu, gpu + 2)).toEqual(['-gpu:0', '1']);
  });

  it('a CUDA device leaves software encodes and copies alone', () => {
    const device = { kind: 'cuda', index: 1 } as const;
    for (const model of [encode('libx265'), modelFromProbe(movie)]) {
      const args = renderArgs({ model, input: '/in.mkv', output: '/o.mkv', device });
      expect(args).not.toContain('-hwaccel');
      expect(args).not.toContain('-hwaccel_device');
      expect(args.some((a) => a.startsWith('-gpu'))).toBe(false);
    }
  });

  it('without a device (auto, one GPU) the argv is as before: no device index', () => {
    const args = renderArgs({ model: encode('hevc_nvenc'), input: '/in.mkv', output: '/o.mkv' });
    expect(args).not.toContain('-hwaccel_device');
    expect(args.some((a) => a.startsWith('-gpu'))).toBe(false);
  });

  it('a model with its own -hwaccel still encodes on the chosen GPU', () => {
    const model = { ...encode('hevc_nvenc'), inputArgs: ['-hwaccel', 'vaapi'] };
    const device = { kind: 'cuda', index: 2 } as const;
    const args = renderArgs({ model, input: '/in.mkv', output: '/o.mkv', device });
    expect(args).not.toContain('-hwaccel_device');
    expect(args[args.indexOf('-gpu:0') + 1]).toBe('2');
  });
});

describe('renderArgs: data streams', () => {
  it('copies a data stream even when the model asks to convert it', () => {
    const p = probeOf([
      { type: 'video', codec: 'h264' },
      { type: 'data', codec: 'tmcd' },
    ]);
    const model = withStream({ ...modelFromProbe(p), container: 'mp4' }, 1, {
      mode: 'convert',
      codec: 'h264',
    });
    const args = streamArgs(renderArgs({ model, input: '/i', output: '/o.mp4' }));
    expect(args.slice(args.indexOf('-c:1'), args.indexOf('-c:1') + 2)).toEqual(['-c:1', 'copy']);
  });
});

describe('renderArgs: profiles', () => {
  const src = probeOf([{ type: 'video', codec: 'h264' }]);
  const convert = (encoder: string, profile: string | null, pixelFormat: string | null) =>
    withStream(modelFromProbe(src), 0, {
      mode: 'convert',
      codec: encoder.startsWith('h264') || encoder === 'libx264' ? 'h264' : 'hevc',
      encoder,
      quality: 24,
      preset: null,
      profile,
      pixelFormat,
    });
  const videoArgs = (encoder: string, profile: string | null, pixelFormat: string | null) => {
    const args = streamArgs(
      renderArgs({ model: convert(encoder, profile, pixelFormat), input: '/i', output: '/o.mkv' }),
    );
    return args.slice(args.indexOf('-c:0'), args.indexOf('-metadata:s:0'));
  };

  it('renders the profile in each encoder own syntax', () => {
    expect(videoArgs('libx264', 'high10', 'yuv420p10le')).toEqual([
      '-c:0',
      'libx264',
      '-crf:0',
      '24',
      '-profile:0',
      'high10',
      '-pix_fmt:0',
      'yuv420p10le',
    ]);
    expect(videoArgs('libx264', 'constrained-baseline', 'yuv420p')).toContain('baseline');
    expect(videoArgs('libx265', 'main10', 'yuv420p10le')).toEqual([
      '-c:0',
      'libx265',
      '-crf:0',
      '24',
      '-x265-params:0',
      'profile=main10',
      '-pix_fmt:0',
      'yuv420p10le',
    ]);
    expect(videoArgs('hevc_nvenc', 'main10', 'p010le')).toEqual([
      '-c:0',
      'hevc_nvenc',
      '-rc:0',
      'constqp',
      '-qp:0',
      '24',
      '-profile:0',
      'main10',
      '-pix_fmt:0',
      'p010le',
    ]);
    expect(videoArgs('libx265', null, 'yuv420p')).not.toContain('-x265-params:0');
  });

  it('rejects a profile that does not fit the pixel format or the encoder', () => {
    expect(() => videoArgs('libx265', 'main', 'yuv420p10le')).toThrow(
      new RenderError('profile main (8-bit 4:2:0) does not fit pixel format yuv420p10le'),
    );
    expect(() => videoArgs('libx264', 'high10', 'yuv420p')).toThrow(RenderError);
    expect(() => videoArgs('libx264', 'high', 'yuv422p')).toThrow(RenderError);
    expect(() => videoArgs('libx265', 'main10', null)).toThrow(
      new RenderError('profile main10 needs a pixel format'),
    );
    expect(() => videoArgs('hevc_qsv', 'main', 'nv12')).toThrow(
      new RenderError('profile main is not supported by hevc_qsv'),
    );
    expect(() => videoArgs('h264_nvenc', 'high10', 'yuv420p10le')).toThrow(
      new RenderError('profile high10 is not supported by h264_nvenc'),
    );
  });
});

describe('renderArgs: video bitrate', () => {
  const src = probeOf([{ type: 'video', codec: 'h264' }]);
  /** The rate-control and speed flags of a converted video stream (between encoder and pix_fmt). */
  const rateArgs = (encoder: string, quality: number | null, bitrateKbps: number | null) => {
    const model = withStream(modelFromProbe(src), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder,
      quality,
      bitrateKbps,
      preset: encoder.endsWith('_vaapi') ? null : 'p5',
      pixelFormat: 'yuv420p',
    });
    const args = streamArgs(renderArgs({ model, input: '/i', output: '/o.mkv' }));
    return args.slice(args.indexOf('-c:0') + 2, args.indexOf('-pix_fmt:0'));
  };

  it('a target bitrate (no quality) renders each encoder in its bitrate mode', () => {
    expect(rateArgs('libx265', null, 4000)).toEqual(['-b:0', '4000k', '-preset:0', 'p5']);
    expect(rateArgs('libx264', null, 4000)).toEqual(['-b:0', '4000k', '-preset:0', 'p5']);
    expect(rateArgs('libsvtav1', null, 4000)).toEqual(['-b:0', '4000k', '-preset:0', 'p5']);
    expect(rateArgs('libaom-av1', null, 4000)).toEqual(['-b:0', '4000k', '-cpu-used:0', 'p5']);
    expect(rateArgs('hevc_nvenc', null, 4000)).toEqual([
      '-rc:0',
      'vbr',
      '-b:0',
      '4000k',
      '-preset:0',
      'p5',
    ]);
    expect(rateArgs('hevc_qsv', null, 4000)).toEqual(['-b:0', '4000k', '-preset:0', 'p5']);
    expect(rateArgs('hevc_vaapi', null, 4000)).toEqual(['-b:0', '4000k']);
  });

  it('a quality with a bitrate is capped quality: the bitrate is the ceiling', () => {
    const vbv = ['-maxrate:0', '4000k', '-bufsize:0', '8000k'];
    expect(rateArgs('libx265', 24, 4000)).toEqual(['-crf:0', '24', ...vbv, '-preset:0', 'p5']);
    expect(rateArgs('libx264', 24, 4000)).toEqual(['-crf:0', '24', ...vbv, '-preset:0', 'p5']);
    expect(rateArgs('libsvtav1', 30, 4000)).toEqual(['-crf:0', '30', ...vbv, '-preset:0', 'p5']);
    // libaom's constrained-quality mode: crf with a nonzero bitrate as its ceiling.
    expect(rateArgs('libaom-av1', 30, 4000)).toEqual([
      '-crf:0',
      '30',
      '-b:0',
      '4000k',
      '-cpu-used:0',
      'p5',
    ]);
    // NVENC's constqp ignores a maxrate: VBR with a constant-quality target instead.
    expect(rateArgs('hevc_nvenc', 24, 4000)).toEqual([
      '-rc:0',
      'vbr',
      '-cq:0',
      '24',
      '-b:0',
      '0',
      ...vbv,
      '-preset:0',
      'p5',
    ]);
    // QSV picks QVBR for a quality with a bitrate below the maxrate (equal ones mean CBR).
    expect(rateArgs('hevc_qsv', 24, 4000)).toEqual([
      '-global_quality:0',
      '24',
      '-b:0',
      '3999k',
      ...vbv,
      '-preset:0',
      'p5',
    ]);
    // VAAPI tries QVBR for a quality with a bitrate (ICQ, then CQP, where the driver lacks it).
    expect(rateArgs('hevc_vaapi', 24, 4000)).toEqual([
      '-global_quality:0',
      '24',
      '-b:0',
      '4000k',
      '-maxrate:0',
      '4000k',
    ]);
  });

  it('a quality without a bitrate renders as before', () => {
    expect(rateArgs('libx265', 24, null)).toEqual(['-crf:0', '24', '-preset:0', 'p5']);
    expect(rateArgs('libaom-av1', 30, null)).toEqual([
      '-crf:0',
      '30',
      '-b:0',
      '0',
      '-cpu-used:0',
      'p5',
    ]);
    expect(rateArgs('hevc_nvenc', 24, null)).toEqual([
      '-rc:0',
      'constqp',
      '-qp:0',
      '24',
      '-preset:0',
      'p5',
    ]);
    expect(rateArgs('hevc_qsv', 24, null)).toEqual(['-global_quality:0', '24', '-preset:0', 'p5']);
    expect(rateArgs('hevc_vaapi', 24, null)).toEqual(['-rc_mode:0', 'CQP', '-qp:0', '24']);
  });
});

describe('renderArgs: unsafe input', () => {
  const model = modelFromProbe(probeOf([{ type: 'video', codec: 'h264' }]));

  it('requires absolute input and output paths', () => {
    expect(() => renderArgs({ model, input: 'in.mkv', output: '/o.mkv' })).toThrow(
      new RenderError('input path is not absolute: in.mkv'),
    );
    expect(() => renderArgs({ model, input: '/in.mkv', output: 'tmp/o.mkv' })).toThrow(
      new RenderError('output path is not absolute: tmp/o.mkv'),
    );
  });

  it('rejects a NUL byte in any argument', () => {
    expect(() => renderArgs({ model, input: '/in\0.mkv', output: '/o.mkv' })).toThrow(RenderError);
    const titled = withStream(model, 0, { title: 'a\0b' });
    expect(() => renderArgs({ model: titled, input: '/i', output: '/o.mkv' })).toThrow(
      new RenderError('argument contains a NUL byte: "title=a\\u0000b"'),
    );
  });

  it('passes a title with =, a newline and quotes as one argument', () => {
    const title = `Director's "Cut" = 2\nnd take`;
    const titled = withStream(model, 0, { title });
    const args = renderArgs({ model: titled, input: '/i', output: '/o.mkv' });
    expect(args).toContain(`title=${title}`);
    expect(renderCommandLine('ffmpeg', [`title=${title}`])).toBe(
      `ffmpeg 'title=Director'\\''s "Cut" = 2\nnd take'`,
    );
  });

  it('accepts options with values in globalArgs/inputArgs and rejects positional tokens and -i', () => {
    const ok = { ...model, globalArgs: ['-hwaccel', 'cuda', '-threads', '4'], inputArgs: ['-re'] };
    expect(() => renderArgs({ model: ok, input: '/i', output: '/o.mkv' })).not.toThrow();
    expect(() =>
      renderArgs({
        model: { ...model, globalArgs: ['-hwaccel', 'cuda', 'extra'] },
        input: '/i',
        output: '/o.mkv',
      }),
    ).toThrow(new RenderError('globalArgs has a stray argument "extra"'));
    expect(() =>
      renderArgs({
        model: { ...model, inputArgs: ['/etc/passwd'] },
        input: '/i',
        output: '/o.mkv',
      }),
    ).toThrow(new RenderError('inputArgs has a stray argument "/etc/passwd"'));
    expect(() =>
      renderArgs({ model: { ...model, inputArgs: ['-i', '/x'] }, input: '/i', output: '/o.mkv' }),
    ).toThrow(new RenderError('inputArgs must not add an input (-i)'));
    expect(() =>
      renderArgs({
        model: { ...model, inputArgs: ['-re', '/etc/passwd'] },
        input: '/i',
        output: '/o.mkv',
      }),
    ).toThrow(new RenderError('inputArgs has a stray argument "/etc/passwd"'));
    expect(() =>
      renderArgs({
        model: { ...model, globalArgs: ['-y', '-hide_banner', '-loglevel', 'error'] },
        input: '/i',
        output: '/o.mkv',
      }),
    ).not.toThrow();
  });
});

describe('renderArgs: covers and container fit', () => {
  const withCover = probeOf(
    [
      { type: 'video', codec: 'hevc' },
      { type: 'video', codec: 'png', attachedPic: true },
      { type: 'audio', codec: 'aac', language: 'eng' },
    ],
    { container: 'mp4' },
  );

  it('an mkv output attaches the extracted cover after the mapped streams', () => {
    const model = { ...modelFromProbe(withCover), container: 'mkv' as const };
    const args = renderArgs({
      model,
      input: '/in.mp4',
      output: '/out.mkv',
      coverFiles: new Map([[1, '/tmp/job/cover-1.png']]),
    });
    expect(args.filter((_a, i) => args[i - 1] === '-map')).toEqual(['0:0', '0:2']);
    const attach = args.indexOf('-attach');
    expect(args.slice(attach, attach + 6)).toEqual([
      '-attach',
      '/tmp/job/cover-1.png',
      '-metadata:s:2',
      'mimetype=image/png',
      '-metadata:s:2',
      'filename=cover.png',
    ]);
    expect(args).toContain('-c:1');
    expect(args).not.toContain('-c:2');
  });

  it('an mkv cover without its extracted file is a RenderError; mp4 maps the cover', () => {
    const model = { ...modelFromProbe(withCover), container: 'mkv' as const };
    expect(() => renderArgs({ model, input: '/in.mp4', output: '/out.mkv' })).toThrow(
      new RenderError('cover video #1 needs its extracted image file'),
    );
    const mp4 = renderArgs({ model: modelFromProbe(withCover), input: '/i.mp4', output: '/o.mp4' });
    expect(mp4).toContain('0:1');
    expect(mp4).not.toContain('-attach');
  });

  it('refuses a kept stream the container cannot hold', () => {
    const data = probeOf([{ type: 'video' }, { type: 'data', codec: 'tmcd' }]);
    expect(() =>
      renderArgs({ model: modelFromProbe(data), input: '/i.mkv', output: '/o.mkv' }),
    ).toThrow(new RenderError("mkv can't hold data #1 (tmcd); drop it from the model"));
  });

  it('coverExtractArgs copies one stream into an image file', () => {
    expect(coverExtractArgs('/in.mp4', 42, '/tmp/job/cover-42.png')).toEqual([
      '-nostdin',
      '-hide_banner',
      '-y',
      '-v',
      'error',
      '-i',
      '/in.mp4',
      '-map',
      '0:42',
      '-c',
      'copy',
      '-frames:v',
      '1',
      '-f',
      'image2',
      '/tmp/job/cover-42.png',
    ]);
  });
});

describe('renderArgs: sidecar inputs', () => {
  const src = probeOf([
    { type: 'video', codec: 'hevc' },
    { type: 'audio', codec: 'aac', language: 'eng' },
  ]);
  const copies = new Map([
    [1, '/tc/j1/sidecar-1.srt'],
    [2, '/tc/j1/sidecar-2.srt'],
  ]);

  it('renders sidecar inputs after the source, from their copies, and maps them by input', () => {
    let model = withSidecar(modelFromProbe(src), 1, 'Show.de.srt', { forced: true });
    model = withSidecar(model, 2, 'Show.en.srt', { language: 'eng' });
    // Only the stream from input 2 is kept; input 1 is still listed so the numbers stay stable.
    model = withStream(model, -1, { keep: false });
    const args = renderArgs({
      model,
      input: '/lib/Show.mkv',
      output: '/tc/j1/out.mkv',
      extraInputFiles: copies,
    });
    const i = args.indexOf('-i');
    expect(args.slice(i, i + 8)).toEqual([
      '-i',
      '/lib/Show.mkv',
      '-f',
      'srt',
      '-i',
      '/tc/j1/sidecar-1.srt',
      '-f',
      'srt',
    ]);
    const inputs = args.flatMap((a, n) => (a === '-i' ? [args[n + 1]] : []));
    expect(inputs).toEqual(['/lib/Show.mkv', '/tc/j1/sidecar-1.srt', '/tc/j1/sidecar-2.srt']);
    expect(args.join(' ')).not.toContain('/lib/Show.de.srt');
    const maps = args.flatMap((a, n) => (a === '-map' ? [args[n + 1]] : []));
    expect(maps).toEqual(['0:0', '0:1', '2:0']);
    const tail = streamArgs(args);
    expect(tail.slice(tail.indexOf('-c:2'))).toEqual([
      '-c:2',
      'copy',
      '-metadata:s:2',
      'language=eng',
      '-metadata:s:2',
      'title=',
      '-disposition:2',
      '0',
    ]);
  });

  it('names the demuxer from the sidecar codec', () => {
    const cases: [string, string][] = [
      ['subrip', 'srt'],
      ['ass', 'ass'],
      ['ssa', 'ass'],
      ['webvtt', 'webvtt'],
      ['hdmv_pgs_subtitle', 'sup'],
    ];
    for (const [codec, demuxer] of cases) {
      const model = withSidecar(modelFromProbe(src), 1, 'Show.xx.sub', { codec, keep: false });
      const args = renderArgs({
        model,
        input: '/in.mkv',
        output: '/out.mkv',
        extraInputFiles: new Map([[1, '/tc/j1/sidecar-1.sub']]),
      });
      const at = args.indexOf('/tc/j1/sidecar-1.sub');
      expect(args.slice(at - 3, at + 1)).toEqual(['-f', demuxer, '-i', '/tc/j1/sidecar-1.sub']);
    }
  });

  it('an unknown sidecar codec is a RenderError', () => {
    const model = withSidecar(modelFromProbe(src), 1, 'Show.xx.sub', { codec: 'dvd_subtitle' });
    expect(() =>
      renderArgs({ model, input: '/in.mkv', output: '/out.mkv', extraInputFiles: copies }),
    ).toThrow(new RenderError('extra input 1 has an unsupported subtitle codec: dvd_subtitle'));
  });

  it('a sidecar stream keeps its place by order and converts to srt on mkv', () => {
    let model = withSidecar(modelFromProbe(src), 1, 'Show.de.srt', { order: 0, mode: 'convert' });
    model = withStream(model, 0, { order: 1 });
    model = withStream(model, 1, { order: 2 });
    const args = renderArgs({
      model,
      input: '/in.mkv',
      output: '/out.mkv',
      extraInputFiles: copies,
    });
    expect(args.flatMap((a, n) => (a === '-map' ? [args[n + 1]] : []))).toEqual([
      '1:0',
      '0:0',
      '0:1',
    ]);
    expect(args).toContain('srt');
  });

  it('a model without extraInputs renders no extra -i', () => {
    const args = renderArgs({ model: modelFromProbe(src), input: '/in.mkv', output: '/out.mkv' });
    expect(args.filter((a) => a === '-i')).toEqual(['-i']);
  });

  it('a sidecar without its copied file is a RenderError (the original is never rendered)', () => {
    const model = withSidecar(modelFromProbe(src), 1, 'Show.de.srt');
    expect(() => renderArgs({ model, input: '/in.mkv', output: '/out.mkv' })).toThrow(
      new RenderError('extra input 1 needs its copied file'),
    );
  });

  it('relative sidecar path or copy path is a RenderError', () => {
    const model = withSidecar(modelFromProbe(src), 1, 'Show.de.srt');
    expect(() =>
      renderArgs({
        model,
        input: '/in.mkv',
        output: '/out.mkv',
        extraInputFiles: new Map([[1, 'sidecar-1.srt']]),
      }),
    ).toThrow(new RenderError('extra input copy is not absolute: sidecar-1.srt'));
    (model.extraInputs?.[0] as { path: string }).path = 'Show.de.srt';
    expect(() =>
      renderArgs({ model, input: '/in.mkv', output: '/out.mkv', extraInputFiles: copies }),
    ).toThrow(new RenderError('extra input path is not absolute: Show.de.srt'));
  });

  it('an extra stream pointing at a missing input is a RenderError', () => {
    const model = withSidecar(modelFromProbe(src), 1, 'Show.de.srt');
    const stream = model.streams.at(-1) as { input?: number };
    stream.input = 3;
    expect(() =>
      renderArgs({ model, input: '/in.mkv', output: '/out.mkv', extraInputFiles: copies }),
    ).toThrow(new RenderError('stream #-1 reads extra input 3, which the model does not list'));
  });

  it('an extra input that is not a subtitle is a RenderError', () => {
    const model = withSidecar(modelFromProbe(src), 1, 'Show.de.srt');
    (model.extraInputs?.[0] as { kind: string }).kind = 'audio';
    expect(() =>
      renderArgs({ model, input: '/in.mkv', output: '/out.mkv', extraInputFiles: copies }),
    ).toThrow(new RenderError('extra input 1 has an unsupported kind: audio'));
  });
});

describe.skipIf(!fixturesAvailable())('renderArgs with real ffmpeg', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await tempDir('render-');
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function run(model: BuildModel, output: string) {
    const { ffmpegPath, ffprobePath } = toolPaths();
    const input = fixturePath('compliant.mkv');
    await execFileAsync(ffmpegPath, renderArgs({ model, input, output }));
    return probeFile(output, { ffprobePath });
  }

  it('a cleared language reprobes as und (null) in mkv and mp4', async () => {
    const source = await probeFile(fixturePath('compliant.mkv'), toolPaths());
    expect(source.streams[1]?.language).toBe('eng');
    const model = withStream(modelFromProbe(source), 1, { language: null });
    const mkv = await run(model, join(dir, 'lang.mkv'));
    expect(mkv.streams[1]?.language).toBeNull();
    expect(mkv.streams[2]?.language).toBe('deu');
    const mp4 = await run(
      {
        ...model,
        container: 'mp4',
        streams: model.streams.map((s) =>
          s.type === 'subtitle' ? { ...s, mode: 'convert', codec: 'mov_text' } : s,
        ),
      },
      join(dir, 'lang.mp4'),
    );
    expect(mp4.streams[1]?.language).toBeNull();
  });

  it('tigger-pooh.mp4 → mkv writes the png cover as an attachment that reprobes as attached_pic', async () => {
    const { ffmpegPath, ffprobePath } = toolPaths();
    const input = fixturePath('tigger-pooh.mp4');
    const source = await probeFile(input, { ffprobePath });
    const model = { ...modelFromProbe(source), container: 'mkv' as const };
    fitToContainer(model);
    const cover = source.streams.find((s) => s.attachedPic);
    if (!cover) throw new Error('tigger-pooh.mp4 has no cover');
    const coverPath = join(dir, `cover-${cover.index}.png`);
    await execFileAsync(ffmpegPath, coverExtractArgs(input, cover.index, coverPath));
    const output = join(dir, 'tigger.mkv');
    await execFileAsync(
      ffmpegPath,
      renderArgs({ model, input, output, coverFiles: new Map([[cover.index, coverPath]]) }),
    );
    const out = await probeFile(output, { ffprobePath });
    expect(out.streams).toHaveLength(source.streams.length);
    expect(out.streams.map((s) => s.codec)).toEqual(outputOrder(model).map((s) => s.codec));
    expect(out.streams.at(-1)).toMatchObject({ type: 'video', codec: 'png', attachedPic: true });
    expect(out.streams.filter((s) => s.attachedPic)).toHaveLength(1);
  });

  it('a main10 libx265 render reprobes as main10', async () => {
    const source = await probeFile(fixturePath('compliant.mkv'), toolPaths());
    const model = withStream(modelFromProbe(source), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      quality: 30,
      preset: 'ultrafast',
      profile: 'main10',
      pixelFormat: 'yuv420p10le',
    });
    const out = await run(model, join(dir, 'main10.mkv'));
    expect(out.streams[0]).toMatchObject({ codec: 'hevc', profile: 'main10', bitDepth: 10 });
  });
});

describe('renderCommandLine / outputExtension', () => {
  it('shell-quotes arguments that need it', () => {
    expect(
      renderCommandLine('/usr/bin/ffmpeg', [
        '-i',
        "/lib/Bob's Movie (2001).mkv",
        '-metadata:s:1',
        'title=',
        '-c:0',
        'copy',
        '',
      ]),
    ).toBe(
      "/usr/bin/ffmpeg -i '/lib/Bob'\\''s Movie (2001).mkv' -metadata:s:1 title= -c:0 copy ''",
    );
  });

  it('maps containers to extensions', () => {
    expect(outputExtension('mkv')).toBe('.mkv');
    expect(outputExtension('mp4')).toBe('.mp4');
  });
});
