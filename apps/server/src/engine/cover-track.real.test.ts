// An image stored as a one-frame video track, with the real ffmpeg: the probe marks it, the plan
// copies it instead of encoding it, and the job writes its output. Encoded, the lone frame never
// reaches the muxer until the input ends (the decoder and encoder hold it), so the muxer keeps
// every other packet in memory: no progress is reported and nothing is written (the test watches
// the first seconds of a real-time encode). The stall guard stops such an encode.
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { JobState } from '@transcoda/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeExec } from '../capabilities/ffmpeg.ts';
import { findJob, findJobResult, type JobRow } from '../db/repos/jobs.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { chain, node } from '../workflows/test-helpers.ts';
import { realCapabilities, tempDir, toolPaths } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { probeFile } from './probe.ts';
import { nodeSpawner } from './process.ts';
import { OutputStallGuard, watchForStall } from './stall-guard.ts';

const execFileAsync = promisify(execFile);
const { ffmpegPath, ffprobePath } = toolPaths();
const exec = makeExec({ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
const FINAL: JobState[] = ['done', 'kept_original', 'failed', 'cancelled', 'skipped', 'dry_run'];

/** ffmpeg and ffprobe run, with libx264, libx265 and aac. */
function toolsAvailable(): boolean {
  const encoders = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const probe = spawnSync(ffprobePath, ['-version'], { encoding: 'utf8' });
  return (
    encoders.status === 0 &&
    / libx264 /.test(encoders.stdout) &&
    / libx265 /.test(encoders.stdout) &&
    / aac /.test(encoders.stdout) &&
    probe.status === 0
  );
}

describe.skipIf(!toolsAvailable())('an image stored as a video track, with real ffmpeg', () => {
  let base = '';
  let t: TestApp | null = null;
  // The replace wants 5 GiB of headroom on the library's filesystem; the test disk may not.
  const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

  beforeAll(async () => {
    base = await tempDir('cover-track-real-');
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });
  afterEach(async () => {
    await t?.deps.engine.stop();
    t = null;
  });

  async function ffmpeg(args: string[]): Promise<void> {
    await execFileAsync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args]);
  }

  /**
   * 4 s of h264 testsrc2, then a one-frame hevc track (1000 fps, 1 ms) tagged as `cover.jpg`
   * `image/jpeg` (an attachment an earlier ffmpeg pass turned into video), then aac audio; mkv.
   * Backdated, so the settle window never sees it as still growing.
   */
  async function sample(dir: string): Promise<string> {
    const cover = join(base, 'cover.mkv');
    // biome-ignore format: flag/value pairs
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=1000:duration=0.001',
      '-frames:v', '1', '-c:v', 'libx265', '-x265-params', 'log-level=error', cover,
    ]);
    const out = join(dir, 'sample.mkv');
    // biome-ignore format: flag/value pairs
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=4',
      '-i', cover,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
      '-map', '0:v', '-map', '1:v', '-map', '2:a',
      '-c:v:0', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:v:1', 'copy', '-c:a', 'aac',
      '-metadata:s:v:1', 'FILENAME=cover.jpg', '-metadata:s:v:1', 'MIMETYPE=image/jpeg',
      out,
    ]);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(out, past, past);
    return out;
  }

  it('the probe marks the track and the job copies it, encodes the real video and finishes', async () => {
    const lib = join(base, 'lib');
    await mkdir(lib, { recursive: true });
    const file = await sample(lib);

    const probe = await probeFile(file, { ffprobePath, exec });
    expect(probe.streams.map((s) => [s.type, s.codec, s.imageTrack === true])).toEqual([
      ['video', 'h264', false],
      ['video', 'hevc', true],
      ['audio', 'aac', false],
    ]);

    const a = createTestApp({
      config: {
        configDir: join(base, 'config'),
        transcodeDir: join(base, 'transcode'),
        ...toolPaths(),
      },
      capabilities: await realCapabilities(),
      fsOps,
    });
    t = a;
    const { id: wf } = a.deps.workflows.create({ name: 'hevc', kind: 'workflow' }, 'u');
    a.deps.workflows.save(
      {
        id: wf,
        baseVersion: 1,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          // skipIf never: every video stream the node accepts is encoded.
          node('ev', 'core:encode-video', {
            codec: 'hevc',
            encoder: 'libx265',
            preset: 'ultrafast',
            quality: 30,
            skipIf: 'never',
          }),
          node('ro', 'core:replace-original'),
        ),
      },
      'u',
    );
    expect(a.deps.workflows.activate(wf, 2, 'u').kind).toBe('ok');
    const created = await a.deps.engine.queue.createLibrary({ name: 'L', path: lib });
    if ('kind' in created) throw new Error('library');

    const r = await a.deps.engine.queue.queue({
      path: file,
      workflowId: wf,
      dryRun: false,
      force: false,
      priority: 0,
      createdBy: 'u',
    });
    if (r.kind !== 'queued') throw new Error(JSON.stringify(r));
    const id = (r.jobs[0] as JobRow).id;
    await a.deps.engine.start();
    let job: JobRow | null = null;
    for (let i = 0; i < 2400 && !(job && FINAL.includes(job.state)); i += 1) {
      await new Promise((res) => setTimeout(res, 25));
      job = findJob(a.db, id);
    }
    expect([job?.state, job?.reason]).toEqual(['done', null]);

    const command = findJobResult(a.db, id)?.command ?? '';
    // The real video is encoded; the image track is copied, never given to an encoder.
    expect(command).toMatch(/ -c:0 libx265 /);
    expect(command).toMatch(/ -c:1 copy /);
    expect(command).not.toMatch(/ -(crf|maxrate|preset|pix_fmt):1 /);

    const out = await probeFile(file, { ffprobePath, exec });
    expect(out.streams.map((s) => [s.type, s.codec])).toEqual([
      ['video', 'hevc'],
      ['video', 'hevc'],
      ['audio', 'aac'],
    ]);
    expect((await stat(file)).size).toBeGreaterThan(0);
    expect(out.durationSeconds).toBeGreaterThan(3.5);
  }, 120_000);

  it('encoding the image track: no progress and an empty file for the first 1.5 s, then the stall guard stops it', async () => {
    const dir = join(base, 'stall');
    await mkdir(dir, { recursive: true });
    const file = await sample(dir);
    /**
     * The sample through ffmpeg at real time (the `realtime` filter on the main video: about 4 s),
     * with the image track encoded or copied, watched by a 1.5 s stall guard.
     */
    const encode = async (imageTrack: 'libx265' | 'copy') => {
      const output = join(dir, `out-${imageTrack}.mkv`);
      const limitMs = 1500;
      const guard = new OutputStallGuard(limitMs, Date.now);
      let samples = 0;
      let stalled = false;
      // biome-ignore format: flag/value pairs
      const proc = nodeSpawner.spawn(ffmpegPath, [
        '-nostdin', '-v', 'error', '-y', '-stats_period', '0.1', '-progress', 'pipe:1',
        '-i', file, '-map', '0',
        '-filter:v:0', 'realtime', '-c:v:0', 'libx265', '-preset:v:0', 'ultrafast',
        '-x265-params', 'log-level=error',
        '-c:v:1', imageTrack, '-c:a', 'aac', output,
      ], {
        logPath: join(dir, `${imageTrack}.log`),
        onProgress: (s) => {
          samples += 1;
          guard.sample(s);
        },
      });
      const watch = watchForStall(proc, guard, limitMs, () => {
        stalled = true;
      });
      const result = await proc.done;
      watch.stop();
      return { result, stalled, samples, size: (await stat(output)).size };
    };

    const stuck = await encode('libx265');
    expect(stuck).toMatchObject({ stalled: true, samples: 0, size: 0 });
    expect(stuck.result.signal).toBe('SIGKILL');

    const copied = await encode('copy');
    expect(copied.stalled).toBe(false);
    expect(copied.result.code).toBe(0);
    expect(copied.samples).toBeGreaterThan(10);
    expect(copied.size).toBeGreaterThan(0);
  }, 120_000);
});
