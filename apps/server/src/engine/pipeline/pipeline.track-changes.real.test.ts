// A size gate that writes the track changes, with the real spawner, ffprobe and ffmpeg: the remux
// copies the video packet for packet, carries the planned default track, and passes verify.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { JobState } from '@transcoda/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import { findJob, findJobResult, type JobRow } from '../../db/repos/jobs/jobs.ts';
import { type FsOps, nodeFsOps } from '../../platform/fs-ops.ts';
import { chain, node } from '../../workflows/testing.ts';
import { defaultRecycleFolder } from '../files/recycle.ts';
import { fixturesAvailable, realCapabilities, tempDir, toolPaths } from '../testing/fixtures.ts';

const execFileAsync = promisify(execFile);
const FINAL: JobState[] = ['done', 'kept_original', 'failed', 'cancelled', 'skipped'];

describe.skipIf(!fixturesAvailable())('size gate track changes with real ffmpeg', () => {
  let base = '';
  let t: TestApp | null = null;
  // The replace wants 5 GB of headroom on the library's filesystem; the test disk may not.
  const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

  beforeAll(async () => {
    base = await tempDir('track-changes-real-');
  });
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });
  afterEach(async () => {
    await t?.deps.engine.stop();
    t = null;
  });

  async function ffmpeg(args: string[]): Promise<void> {
    await execFileAsync(toolPaths().ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args]);
  }

  type Probe = {
    streams: {
      codec_type: string;
      codec_name: string;
      tags?: { language?: string };
      disposition: { default: number };
    }[];
  };
  async function probe(path: string): Promise<Probe> {
    const { stdout } = await execFileAsync(toolPaths().ffprobePath, [
      '-v',
      'error',
      '-show_streams',
      '-of',
      'json',
      path,
    ]);
    return JSON.parse(stdout) as Probe;
  }

  /** The video packets' sizes, in order: equal lists mean the video was copied, not encoded. */
  async function videoPackets(path: string): Promise<string> {
    const { stdout } = await execFileAsync(toolPaths().ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=size',
      '-of',
      'csv=p=0',
      path,
    ]);
    return stdout;
  }

  it('saves too little: the original is replaced by a remux with the video copied and French as the default audio', async () => {
    const lib = join(base, 'lib');
    await mkdir(lib, { recursive: true });
    const file = join(lib, 'otter.mkv');
    // A small h264 source with English (default) and French audio.
    const lavfi = (source: string) => ['-f', 'lavfi', '-t', '4', '-i', source];
    await ffmpeg([
      ...lavfi('testsrc2=size=320x240:rate=25'),
      ...lavfi('sine=frequency=440:sample_rate=48000'),
      ...lavfi('sine=frequency=660:sample_rate=48000'),
      ...['-map', '0:v', '-map', '1:a', '-map', '2:a'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-b:a', '96k'],
      ...['-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fre'],
      ...['-disposition:a:0', 'default', '-disposition:a:1', '0'],
      file,
    ]);
    const sourcePackets = await videoPackets(file);

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
    const { id: wf } = a.deps.workflows.create({ name: 'tracks', kind: 'workflow' }, 'u');
    a.deps.workflows.save(
      {
        id: wf,
        baseVersion: 1,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('sd', 'core:set-default-track', { audioLanguages: ['fr'] }),
          node('ev', 'core:encode-video', {
            codec: 'hevc',
            encoder: 'libx265',
            preset: 'ultrafast',
            skipIf: 'never',
          }),
          // No encode saves 99%: the gate always falls back to the track changes.
          node('sg', 'core:size-gate', {
            minSavingPercent: 99,
            belowMinimum: 'write-track-changes',
          }),
          node('ro', 'core:replace-original'),
        ),
      },
      'u',
    );
    expect(a.deps.workflows.activate(wf, 2, 'u').kind).toBe('ok');
    const library = await a.deps.engine.queue.createLibrary({ name: 'L', path: lib });
    if ('kind' in library) throw new Error('library');

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
    expect(job).toMatchObject({ state: 'done' });
    expect(job?.reason).toMatch(
      /^saved only -?\d+\.\d%, below 99% → wrote track changes without re-encoding$/,
    );

    // The file is the remux: the same h264 packets, French (its code normalised) the default audio.
    const after = await probe(file);
    expect(
      after.streams.map((s) => [s.codec_type, s.codec_name, s.tags?.language ?? null]),
    ).toEqual([
      ['video', 'h264', null],
      ['audio', 'aac', 'eng'],
      ['audio', 'aac', 'fra'],
    ]);
    expect(
      after.streams.filter((s) => s.codec_type === 'audio').map((s) => s.disposition.default),
    ).toEqual([0, 1]);
    expect(await videoPackets(file)).toBe(sourcePackets);
    expect(findJobResult(a.db, id)).toMatchObject({
      outcome: 'done',
      afterBytes: (await stat(file)).size,
    });
    // The original is in the recycle folder, as after any replace.
    expect(await readdir(defaultRecycleFolder(lib))).toHaveLength(1);
  }, 120_000);
});
