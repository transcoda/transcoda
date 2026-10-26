// The pipeline with the real spawner, ffprobe and ffmpeg: in-pass error handling on real streams.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { JobState } from '@transcoda/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { findJob, findJobResult, type JobRow } from '../db/repos/jobs.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { chain, node } from '../workflows/test-helpers.ts';
import { fixturesAvailable, realCapabilities, tempDir, toolPaths } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { defaultRecycleFolder } from './recycle.ts';

const execFileAsync = promisify(execFile);
const FINAL: JobState[] = ['done', 'kept_original', 'failed', 'cancelled', 'skipped', 'dry_run'];

describe.skipIf(!fixturesAvailable())('pipeline with real ffmpeg', () => {
  let base = '';
  let t: TestApp | null = null;
  // The replace wants 5 GiB of headroom on the library's filesystem; the test disk may not.
  const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

  beforeAll(async () => {
    base = await tempDir('pipeline-real-');
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

  /**
   * 8 s of testsrc2 as mpegts (video only: mpegts carries no default flag, so audio would fail
   * verify's one-default-audio rule), `hevc` (x265, open GOP) or h264, keyframe every 2 s.
   */
  async function source(name: string, codec: 'hevc' | 'h264'): Promise<string> {
    const out = join(base, `src-${name}`);
    const v =
      codec === 'hevc'
        ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=50']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50'];
    // biome-ignore format: flag/value pairs
    await ffmpeg([
      '-f', 'lavfi', '-t', '8', '-i', 'testsrc2=size=320x240:rate=25',
      ...v, '-f', 'mpegts', out,
    ]);
    return out;
  }

  /** The file from 40 % on, cut at a 188-byte packet boundary: it starts mid-GOP. */
  async function cutMidGop(src: string, dest: string): Promise<void> {
    const data = await readFile(src);
    const off = Math.floor((data.length * 0.4) / 188) * 188;
    await writeFile(dest, data.subarray(off));
  }

  async function app(
    libRoot: string,
    preset = 'ultrafast',
    steps?: ReturnType<typeof node>[],
    after: ReturnType<typeof node>[] = [],
  ): Promise<{ app: TestApp; wf: string; transcodeDir: string }> {
    const transcodeDir = join(base, `transcode-${Math.random()}`);
    const a = createTestApp({
      config: {
        configDir: join(base, `config-${Math.random()}`),
        transcodeDir,
        ...toolPaths(),
      },
      capabilities: await realCapabilities(),
      fsOps,
    });
    t = a;
    const { id: wf } = a.deps.workflows.create({ name: 'h264', kind: 'workflow' }, 'u');
    a.deps.workflows.save(
      {
        id: wf,
        baseVersion: 1,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          ...(steps ?? [
            node('ev', 'core:encode-video', {
              codec: 'h264',
              encoder: 'libx264',
              preset,
              quality: 30,
              skipIf: 'never',
            }),
          ]),
          node('ro', 'core:replace-original'),
          ...after,
        ),
      },
      'u',
    );
    expect(a.deps.workflows.activate(wf, 2, 'u').kind).toBe('ok');
    const lib = await a.deps.engine.queue.createLibrary({ name: 'L', path: libRoot });
    if ('kind' in lib) throw new Error('library');
    return { app: a, wf, transcodeDir };
  }

  async function run(
    a: TestApp,
    wf: string,
    path: string,
    opts: { dryRun?: boolean; testEncode?: boolean } = {},
  ): Promise<JobRow> {
    const r = await a.deps.engine.queue.queue({
      path,
      workflowId: wf,
      dryRun: opts.dryRun ?? false,
      ...(opts.testEncode !== undefined ? { testEncode: opts.testEncode } : {}),
      force: false,
      priority: 0,
      createdBy: 'u',
    });
    if (r.kind !== 'queued') throw new Error(JSON.stringify(r));
    const id = (r.jobs[0] as JobRow).id;
    await a.deps.engine.start();
    for (let i = 0; i < 1200; i += 1) {
      const row = findJob(a.db, id);
      if (row && FINAL.includes(row.state)) return row;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('job did not finish');
  }

  for (const codec of ['hevc', 'h264'] as const) {
    it(`a ${codec} mpegts cut mid-GOP encodes: its decoder errors before the first frame are ignored`, async () => {
      const lib = join(base, `lib-cut-${codec}`);
      await mkdir(lib, { recursive: true });
      const file = join(lib, 'cut.ts');
      await cutMidGop(await source(`${codec}.ts`, codec), file);
      const before = (await stat(file)).size;
      const { app: a, wf } = await app(lib);
      const job = await run(a, wf, file);
      expect([job.state, job.reason]).toEqual(['done', null]);
      expect(findJobResult(a.db, job.id)?.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^ignored \d+ decoder error\(s\) before the first output frame$/),
        ]),
      );
      expect((await stat(file)).size).not.toBe(before);
    }, 60_000);
  }

  it('a source damaged in the middle: the source reproduces the decoder errors there → kept_original', async () => {
    const lib = join(base, 'lib-damaged');
    await mkdir(lib, { recursive: true });
    const file = join(lib, 'damaged.mkv');
    // biome-ignore format: flag/value pairs
    await ffmpeg([
      '-f', 'lavfi', '-t', '30', '-i', 'testsrc2=size=1280x720:rate=25',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', file,
    ]);
    const size = (await stat(file)).size;
    const fh = await open(file, 'r+');
    await fh.write(Buffer.alloc(20_000), 0, 20_000, Math.floor(size * 0.6));
    await fh.close();
    const original = await readFile(file);
    // A slower preset: the damage is reached after the first progress report, as in a real file.
    const { app: a, wf } = await app(lib, 'veryfast');
    const job = await run(a, wf, file);
    expect([job.state, job.reason, job.attempt]).toEqual([
      'kept_original',
      'source has decode errors; nothing was replaced',
      1,
    ]);
    expect(findJobResult(a.db, job.id)?.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/^decode-sample: source: decoding /)]),
    );
    expect((await readFile(file)).equals(original)).toBe(true);
  }, 60_000);

  it('a test-encode dry run writes nothing to the library dir and runs no finish step', async () => {
    const lib = join(base, 'lib-test-encode');
    await mkdir(lib, { recursive: true });
    const file = join(lib, 'clip.mkv');
    // biome-ignore format: flag/value pairs
    await ffmpeg([
      '-f', 'lavfi', '-t', '2', '-i', 'testsrc2=size=320x240:rate=25',
      '-c:v', 'libx264', '-preset', 'ultrafast', file,
    ]);
    /** Every entry under the library root: name, size, mtime and (for files) a sha256. */
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(lib, { recursive: true, withFileTypes: true })) {
        const p = join(e.parentPath, e.name);
        const st = await stat(p);
        const sum = e.isFile()
          ? createHash('sha256')
              .update(await readFile(p))
              .digest('hex')
          : '-';
        out.push(`${relative(lib, p)} ${st.size} ${st.mtimeMs} ${sum}`);
      }
      return out.sort();
    };
    const before = await snapshot();
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const {
        app: a,
        wf,
        transcodeDir,
      } = await app(lib, 'ultrafast', undefined, [
        node('nw', 'core:notify-webhook', { url: 'https://hooks.example.com/x', method: 'POST' }),
      ]);
      const job = await run(a, wf, file, { dryRun: true, testEncode: true });
      expect([job.state, job.reason]).toEqual(['dry_run', null]);
      expect(findJobResult(a.db, job.id)?.afterBytes).toBeGreaterThan(0);
      expect(await snapshot()).toEqual(before);
      expect(
        await access(defaultRecycleFolder(lib)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        await access(join(transcodeDir, job.id)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      // The verified output is kept under test-outputs, and it is a real h264 file.
      const keptFile = join(transcodeDir, 'test-outputs', `${job.id}.mkv`);
      const { stdout } = await execFileAsync(toolPaths().ffprobePath, [
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        keptFile,
      ]);
      const streams = (
        JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string }[] }
      ).streams;
      expect(streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name)).toEqual([
        'h264',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  describe('embedding subtitle files', () => {
    const SRT = (text: string) => `1\n00:00:00,500 --> 00:00:01,500\n${text}\n\n`;

    async function videoWithSidecars(name: string): Promise<{ lib: string; file: string }> {
      const lib = join(base, `lib-subs-${name}`);
      await mkdir(lib, { recursive: true });
      const file = join(lib, 'Show.mkv');
      // biome-ignore format: flag/value pairs
      await ffmpeg([
        '-f', 'lavfi', '-t', '2', '-i', 'testsrc2=size=320x240:rate=25',
        '-c:v', 'libx264', '-preset', 'ultrafast', file,
      ]);
      await writeFile(join(lib, 'Show.de.srt'), SRT('Grüße aus München'));
      await writeFile(join(lib, 'Show.en.forced.srt'), SRT('Hello'));
      return { lib, file };
    }

    async function subtitles(
      file: string,
    ): Promise<{ codec: string; language: string; forced: number }[]> {
      const { stdout } = await execFileAsync(toolPaths().ffprobePath, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        file,
      ]);
      const streams = (
        JSON.parse(stdout) as {
          streams: {
            codec_type: string;
            codec_name: string;
            tags?: { language?: string };
            disposition?: { forced?: number };
          }[];
        }
      ).streams;
      return streams
        .filter((s) => s.codec_type === 'subtitle')
        .map((s) => ({
          codec: s.codec_name,
          language: s.tags?.language ?? 'und',
          forced: s.disposition?.forced ?? 0,
        }));
    }

    const gone = async (p: string) =>
      access(p).then(
        () => false,
        () => true,
      );

    it('mkv: two sidecars become subtitle tracks (deu, eng forced) and are recycled', async () => {
      const { lib, file } = await videoWithSidecars('mkv');
      const { app: a, wf } = await app(lib, 'ultrafast', [
        node('es', 'core:embed-sidecar-subtitles'),
      ]);
      const job = await run(a, wf, file);
      expect([job.state, job.reason]).toEqual(['done', null]);
      expect(await subtitles(file)).toEqual([
        { codec: 'subrip', language: 'deu', forced: 0 },
        { codec: 'subrip', language: 'eng', forced: 1 },
      ]);
      const recycle = defaultRecycleFolder(lib);
      expect(await readFile(join(recycle, 'Show.de.srt'), 'utf8')).toContain('München');
      expect(await gone(join(lib, 'Show.de.srt'))).toBe(true);
      expect(await gone(join(lib, 'Show.en.forced.srt'))).toBe(true);
      expect(await gone(join(recycle, 'Show.en.forced.srt'))).toBe(false);
    }, 60_000);

    it('mp4 (remux first): the sidecars become mov_text tracks', async () => {
      const { lib, file } = await videoWithSidecars('mp4');
      const { app: a, wf } = await app(lib, 'ultrafast', [
        node('rm', 'core:remux', { container: 'mp4' }),
        node('es', 'core:embed-sidecar-subtitles'),
      ]);
      const job = await run(a, wf, file);
      expect([job.state, job.reason]).toEqual(['done', null]);
      const subs = await subtitles(file);
      expect(subs.map((s) => [s.codec, s.language, s.forced])).toEqual([
        ['mov_text', 'deu', 0],
        ['mov_text', 'eng', 1],
      ]);
      expect(await gone(join(lib, 'Show.de.srt'))).toBe(true);
    }, 60_000);
  });
});
