// Poster thumbnails with the real ffmpeg: a JPEG and a PNG piped in with a forced demuxer come out
// as JPEGs 208 px wide.
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../logger.ts';
import { tempDir, toolPaths } from './fixtures.ts';
import { PosterStore, runThumb } from './poster-store.ts';

const execFileAsync = promisify(execFile);
const { ffmpegPath, ffprobePath } = toolPaths();
const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** ffmpeg and ffprobe run. */
function toolsAvailable(): boolean {
  const ffmpeg = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8' });
  const probe = spawnSync(ffprobePath, ['-version'], { encoding: 'utf8' });
  return ffmpeg.status === 0 && probe.status === 0;
}

describe.skipIf(!toolsAvailable())('poster thumbnails with real ffmpeg', () => {
  let base = '';
  let lib = '';

  beforeAll(async () => {
    base = await tempDir('poster-real-');
    lib = join(base, 'lib', 'The General (1926)');
    await mkdir(lib, { recursive: true });
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  async function image(name: string, size = '600x900'): Promise<string> {
    const out = join(lib, name);
    // biome-ignore format: flag/value pairs
    await execFileAsync(ffmpegPath, [
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=navy:size=${size}`, '-frames:v', '1', out,
    ]);
    return out;
  }

  async function probe(p: string): Promise<{ codec_name: string; width: number }> {
    // biome-ignore format: flag/value pairs
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width', '-of', 'json', p,
    ]);
    return JSON.parse(stdout).streams[0];
  }

  it.each(['poster.jpg', 'folder.png'])('makes a 208 px JPEG from %s', async (name) => {
    const src = await image(name);
    const store = new PosterStore({
      dir: join(base, 'posters'),
      ffmpegPath,
      now: () => new Date(),
      log,
    });
    const thumb = await store.thumbnail(src, join(base, 'lib'));
    expect(thumb).not.toBeNull();
    expect(thumb?.size).toBeGreaterThan(0);
    expect(await probe(thumb?.path ?? '')).toEqual({ codec_name: 'mjpeg', width: 208 });
  });

  it('makes no thumbnail from an image over 40 megapixels', async () => {
    const src = await image('huge.png', '8000x5004');
    const store = new PosterStore({
      dir: join(base, 'posters'),
      ffmpegPath,
      now: () => new Date(),
      log,
    });
    expect(await store.thumbnail(src, join(base, 'lib'))).toBeNull();
  });

  it('kills ffmpeg when it runs past the timeout', async () => {
    const input = new PassThrough(); // never ends: ffmpeg waits for the rest of the image
    input.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await expect(
      runThumb({
        ffmpegPath,
        demuxer: 'jpeg_pipe',
        input,
        outPath: join(base, 'stuck.jpg'),
        timeoutMs: 300,
      }),
    ).rejects.toThrow('ffmpeg ran longer than 0.3 s');
    expect(input.destroyed).toBe(true);
  });
});
