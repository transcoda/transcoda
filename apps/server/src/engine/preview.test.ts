import { execFile } from 'node:child_process';
import nodeFs from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { JobPlan } from '@transcoda/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturePath, fixturesAvailable, tempDir, toolPaths } from './fixtures.ts';
import { buildPreview, previewArgs } from './preview.ts';

const run = promisify(execFile);

type Output = NonNullable<JobPlan['output']>;
const plan = (output?: Output): JobPlan => ({
  container: { from: 'mkv', to: 'mkv' },
  streams: [],
  rewrite: true,
  ...(output ? { output } : {}),
});
const maps = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-map' ? [a] : []));
const has = (args: string[], part: string[]) => args.join(' ').includes(part.join(' '));

describe('previewArgs', () => {
  it('writes a faststart mp4 to the given path, copy only, never fragmented', () => {
    const args = previewArgs(null, '/x/a.preview.mp4.part');
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/x/a.preview.mp4.part']);
    expect(has(args, ['-movflags', '+faststart'])).toBe(true);
    expect(args.join(' ')).not.toMatch(/frag_|empty_moov|default_base_moof/);
    expect(has(args, ['-i', 'pipe:0'])).toBe(true);
    expect(has(args, ['-sn', '-dn'])).toBe(true);
    expect(has(args, ['-c:v', 'copy'])).toBe(true);
    expect(args.join(' ')).not.toMatch(/-c:a (?!copy)|-b:a|-ac /);
  });

  it('without the output tracks in the plan plays the video alone (the audio codec is unknown)', () => {
    for (const p of [null, plan()]) {
      const args = previewArgs(p, 'out');
      expect(maps(args)).toEqual(['0:v:0?']);
      expect(args).toContain('-an');
      expect(args).not.toContain('-tag:v');
    }
  });

  it.each(['aac', 'mp3', 'opus', 'flac', 'alac', 'ac3', 'eac3'])(
    'copies a first audio track in %s',
    (codec) => {
      const args = previewArgs(
        plan([
          { type: 'video', codec: 'h264' },
          { type: 'audio', codec },
          { type: 'audio', codec: 'aac' },
        ]),
        'out',
      );
      expect(maps(args)).toEqual(['0:v:0?', '0:a:0']);
      expect(has(args, ['-c:a', 'copy'])).toBe(true);
      expect(args).not.toContain('-an');
    },
  );

  it.each(['dts', 'truehd', 'pcm_s16le', 'vorbis', 'something-new'])(
    'drops the audio when the first track is %s (never another track, never an encode)',
    (codec) => {
      const args = previewArgs(
        plan([
          { type: 'video', codec: 'hevc' },
          { type: 'subtitle', codec: 'subrip' },
          { type: 'audio', codec },
          { type: 'audio', codec: 'aac' },
        ]),
        'out',
      );
      expect(maps(args)).toEqual(['0:v:0?']);
      expect(args).toContain('-an');
      expect(args).not.toContain('-c:a');
    },
  );

  it('with no audio track plays the video alone', () => {
    const args = previewArgs(plan([{ type: 'video', codec: 'hevc' }]), 'out');
    expect(maps(args)).toEqual(['0:v:0?']);
    expect(args).toContain('-an');
  });

  it('tags HEVC as hvc1 (Safari plays only that) and leaves other video untagged', () => {
    const hevc = previewArgs(
      plan([
        { type: 'video', codec: 'hevc' },
        { type: 'audio', codec: 'aac' },
      ]),
      'out',
    );
    expect(hevc.join(' ')).toContain('-tag:v hvc1');
    const h264 = previewArgs(
      plan([
        { type: 'video', codec: 'h264' },
        { type: 'audio', codec: 'aac' },
      ]),
      'out',
    );
    expect(h264).not.toContain('-tag:v');
  });
});

describe('buildPreview', () => {
  it('rejects when ffmpeg cannot be started', async () => {
    await expect(
      buildPreview({
        ffmpegPath: '/nonexistent/ffmpeg',
        input: nodeFs.createReadStream(import.meta.filename),
        outPath: '/nonexistent/out.part',
        plan: null,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

async function probe(file: string): Promise<{
  format: { format_name: string; duration?: string };
  streams: { codec_name: string; codec_tag_string: string; channels?: number }[];
}> {
  const { stdout } = await run(toolPaths().ffprobePath, [
    ...['-v', 'error', '-show_entries'],
    'format=format_name,duration:stream=codec_name,codec_tag_string,channels',
    ...['-of', 'json', file],
  ]);
  return JSON.parse(stdout);
}

describe.skipIf(!fixturesAvailable())('buildPreview (real ffmpeg)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir('preview-');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('an hevc mkv with E-AC-3 5.1 becomes a seekable mp4: hvc1, the E-AC-3 copied, finite duration', async () => {
    const ff = toolPaths().ffmpegPath;
    const src = join(dir, 'eac3.mkv');
    await run(ff, [
      ...['-y', '-hide_banner', '-loglevel', 'error'],
      ...['-i', fixturePath('two-defaults.mkv')],
      ...['-f', 'lavfi', '-i', 'sine=d=2,aformat=channel_layouts=5.1'],
      ...['-map', '0:v:0', '-map', '1:a', '-c:v', 'copy', '-c:a', 'eac3', '-shortest', src],
    ]);
    const out = join(dir, 'eac3.preview.mp4.part');
    const fd = nodeFs.openSync(src, 'r');
    await buildPreview({
      ffmpegPath: ff,
      input: nodeFs.createReadStream('', { fd, autoClose: true }),
      outPath: out,
      plan: plan([
        { type: 'video', codec: 'hevc' },
        { type: 'audio', codec: 'eac3' },
      ]),
    });
    expect(nodeFs.readFileSync(out).subarray(4, 8).toString('latin1')).toBe('ftyp');
    const got = await probe(out);
    expect(got.format.format_name).toMatch(/^mov,mp4/);
    const duration = Number(got.format.duration);
    expect(Number.isFinite(duration) && duration > 0).toBe(true);
    expect(got.streams.map((s) => s.codec_name)).toEqual(['hevc', 'eac3']);
    expect(got.streams[0]?.codec_tag_string).toBe('hvc1');
    expect(got.streams[1]?.channels).toBe(6);
  });

  it('an h264+aac mkv without a plan: the video alone, copied', async () => {
    const out = join(dir, 'h264.preview.mp4.part');
    await buildPreview({
      ffmpegPath: toolPaths().ffmpegPath,
      input: nodeFs.createReadStream(fixturePath('two-defaults-h264.mkv')),
      outPath: out,
      plan: null,
    });
    const got = await probe(out);
    expect(got.streams.map((s) => s.codec_name)).toEqual(['h264']);
    expect(Number(got.format.duration)).toBeGreaterThan(0);
  });

  it('an h264+aac mkv with its plan: both tracks copied', async () => {
    const out = join(dir, 'h264-plan.preview.mp4.part');
    await buildPreview({
      ffmpegPath: toolPaths().ffmpegPath,
      input: nodeFs.createReadStream(fixturePath('two-defaults-h264.mkv')),
      outPath: out,
      plan: plan([
        { type: 'video', codec: 'h264' },
        { type: 'audio', codec: 'aac' },
      ]),
    });
    expect((await probe(out)).streams.map((s) => s.codec_name)).toEqual(['h264', 'aac']);
  });

  it('rejects when reading the input fails, even if ffmpeg exits 0 with what it got', async () => {
    const bytes = nodeFs.readFileSync(fixturePath('two-defaults-h264.mkv'));
    async function* broken() {
      yield bytes.subarray(0, Math.floor(bytes.length / 2));
      throw new Error('EIO: i/o error, read');
    }
    await expect(
      buildPreview({
        ffmpegPath: toolPaths().ffmpegPath,
        input: Readable.from(broken()),
        outPath: join(dir, 'broken.preview.mp4.part'),
        plan: null,
      }),
    ).rejects.toThrow('reading the output failed: EIO: i/o error, read');
  });

  it('rejects with a reason when ffmpeg fails', async () => {
    await expect(
      buildPreview({
        ffmpegPath: toolPaths().ffmpegPath,
        input: nodeFs.createReadStream(fixturePath('two-defaults-h264.mkv'), { end: 99 }),
        outPath: join(dir, 'bad.preview.mp4.part'),
        plan: null,
      }),
    ).rejects.toThrow(/\S/);
  });
});
