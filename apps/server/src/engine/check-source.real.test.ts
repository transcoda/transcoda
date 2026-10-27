// Check source with the real ffmpeg on files it makes: errors are placed in media time, not by
// when they were read (a few seconds of audio read in milliseconds).
import { execFile, spawnSync } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeExec } from '../capabilities/ffmpeg.ts';
import { checkSource } from './check-source.ts';
import { tempDir, toolPaths } from './fixtures.ts';
import { probeFile } from './probe.ts';
import { confirmSourceDamage } from './verify.ts';

const execFileAsync = promisify(execFile);
const { ffmpegPath, ffprobePath } = toolPaths();

/** ffmpeg and ffprobe run, and ffmpeg has the ac3 encoder. */
function toolsAvailable(): boolean {
  const encoders = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const probe = spawnSync(ffprobePath, ['-version'], { encoding: 'utf8' });
  return encoders.status === 0 && / ac3 /.test(encoders.stdout) && probe.status === 0;
}

describe.skipIf(!toolsAvailable())('checkSource with real ffmpeg', () => {
  let base = '';
  const exec = makeExec({ timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });

  beforeAll(async () => {
    base = await tempDir('check-source-real-');
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  /** 20 s of a 440 Hz sine as ac3 (one frame per 32 ms) in mkv. */
  async function clean(name: string): Promise<string> {
    const out = join(base, name);
    // biome-ignore format: flag/value pairs
    await execFileAsync(ffmpegPath, [
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20:sample_rate=48000',
      '-ac', '2', '-c:a', 'ac3', '-b:a', '192k', out,
    ]);
    return out;
  }

  /** Overwrites the payload of the audio packets numbered `from` to `to` (past the sync word). */
  async function corrupt(path: string, from: number, to: number): Promise<void> {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'packet=pos,size',
      '-of',
      'json',
      path,
    ]);
    const packets = (
      JSON.parse(stdout) as { packets: { pos: string; size: string }[] }
    ).packets.map((p) => [Number(p.pos), Number(p.size)] as const);
    const f = await open(path, 'r+');
    try {
      for (const [pos, size] of packets.slice(from, to + 1)) {
        const junk = Buffer.alloc(Math.min(256, size - 8), 0xa5);
        await f.write(junk, 0, junk.length, pos + 8);
      }
    } finally {
      await f.close();
    }
  }

  async function check(path: string) {
    const probe = await probeFile(path, { ffprobePath, exec });
    return checkSource({
      path,
      probe,
      ffmpegPath,
      decodeVideo: false,
      sizeBytes: probe.sizeBytes,
      exec,
      confirm: ({ at, seconds }) =>
        confirmSourceDamage({
          sourcePath: path,
          sourceProbe: probe,
          ffmpegPath,
          ffprobePath,
          times: [at],
          seconds,
          exec,
        }),
    });
  }

  it('errors in the middle → damaged; in the first packet only → ok with a warning; clean → ok', async () => {
    const middle = await clean('middle.mkv');
    await corrupt(middle, 300, 320); // 9.6 s to 10.2 s
    const first = await clean('first.mkv');
    await corrupt(first, 0, 0);
    const intact = await clean('clean.mkv');

    expect(await check(middle)).toMatchObject({ kind: 'damaged', stream: 'audio #0 (AC3)' });
    const head = await check(first);
    expect(head).toMatchObject({ kind: 'ok' });
    expect(head.kind === 'ok' && head.warnings).toEqual([
      expect.stringMatching(/^ignored \d+ decoder error\(s\) before the first output frame$/),
    ]);
    expect(await check(intact)).toEqual({ kind: 'ok', warnings: [] });
  }, 60_000);
});
