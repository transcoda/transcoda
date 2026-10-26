import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import type { JobState } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../capabilities/ffmpeg.ts';
import {
  findJob,
  findJobResult,
  insertJobResult,
  type JobRow,
  updateJob,
} from '../db/repos/jobs.ts';
import { setSetting } from '../db/repos/settings.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { chain, node } from '../workflows/test-helpers.ts';
import { fingerprintOf } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { FakeSpawner } from './process.ts';

/** How long `until` waits; well above any healthy run, below the raised test timeout. */
const UNTIL_MS = 10_000;
vi.setConfig({ testTimeout: 30_000 });

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

/**
 * ffprobe answers for a 60 s hevc+aac mkv (h264 once encoded into the temp dir), packets that end
 * at 60 s, a keyframe at 55 s; ffmpeg runs succeed quietly.
 */
const exec: Exec = async (_file, args) => {
  const output = (args.at(-1) as string).startsWith(transcodeDir);
  if (args.includes('-show_format')) {
    const json = {
      format: {
        format_name: 'matroska,webm',
        duration: '60.000000',
        size: '1000',
        start_time: '0.000000',
      },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: output ? 'h264' : 'hevc',
          disposition: { default: 1 },
        },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          disposition: { default: 1 },
          tags: { language: 'eng' },
        },
      ],
    };
    return { stdout: JSON.stringify(json), stderr: '' };
  }
  if (args.includes('packet=pts_time,duration_time')) return { stdout: '59.96,0.04\n', stderr: '' };
  if (args.includes('-read_intervals')) return { stdout: '55.0,1000,K__\n', stderr: '' };
  return { stdout: '', stderr: '' };
};

let base: string;
let root: string;
let configDir: string;
let transcodeDir: string;
let spawner: FakeSpawner;
let t: TestApp;
const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };
const apps: TestApp[] = [];

function app(db?: TestApp['db']): TestApp {
  spawner = new FakeSpawner();
  const a = createTestApp({
    config: { configDir, transcodeDir, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
    capabilities: caps,
    spawner,
    fsOps,
    exec,
    ...(db ? { db } : {}),
  });
  apps.push(a);
  return a;
}

/**
 * Polls `pred` every 5 ms for up to {@link UNTIL_MS} (a fast run costs nothing; a loaded machine,
 * e.g. `pnpm check` with the real-ffmpeg suites in parallel, gets time). The test timeout is raised
 * to match (vi.setConfig below).
 */
async function until(what: string, pred: () => boolean): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const row = (id: string): JobRow => findJob(t.db, id) as JobRow;

/** A library at `root` with an enabled encode workflow, and one job queued for `a.mkv`. */
async function queued(): Promise<{ id: string; file: string }> {
  const { id: wf } = t.deps.workflows.create({ name: 'Encode', kind: 'workflow' }, 'u');
  t.deps.workflows.save(
    {
      id: wf,
      baseVersion: 1,
      graph: chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
    },
    'u',
  );
  expect(t.deps.workflows.activate(wf, 2, 'u').kind).toBe('ok');
  const lib = await t.deps.engine.queue.createLibrary({ name: 'L', path: root });
  if ('kind' in lib) throw new Error('library');
  const file = join(root, 'a.mkv');
  const r = await t.deps.engine.queue.queue({
    path: file,
    workflowId: wf,
    dryRun: false,
    force: false,
    priority: 0,
    createdBy: 'u',
  });
  if (r.kind !== 'queued') throw new Error('queue');
  return { id: (r.jobs[0] as JobRow).id, file };
}

beforeEach(async () => {
  base = await tempDir('engine-');
  root = join(base, 'lib');
  configDir = join(base, 'config');
  transcodeDir = join(base, 'transcode');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.mkv'), Buffer.alloc(1000, 7));
  t = app();
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.deps.engine.stop();
  await rm(base, { recursive: true, force: true });
});

describe('EngineService', () => {
  it('start() on a db with an encoding job and stray temp requeues it once; a persisted queue pause keeps it from starting', async () => {
    const { id } = await queued();
    updateJob(t.db, id, { state: 'encoding', lane: 'encode' }, t.clock.now());
    await mkdir(join(transcodeDir, id), { recursive: true });
    await writeFile(join(transcodeDir, id, 'out.mkv'), 'partial');
    await writeFile(join(root, '.transcoda-stray.tmp'), 'tmp');
    setSetting(t.db, 'queue.paused', true, t.clock.now());

    const sweep = await t.deps.engine.start();
    expect(sweep.interrupted).toEqual([id]);
    expect(sweep.tempRemoved).toBe(2);
    expect(row(id)).toMatchObject({ state: 'queued', requeues: 1, reason: 'interrupted' });
    expect(await readdir(transcodeDir)).toEqual([]);
    expect(await readdir(root)).toEqual(['a.mkv']);
    await new Promise((r) => setTimeout(r, 30));
    expect(row(id).state).toBe('queued');
    expect(t.deps.engine.scheduler.status().paused).toBe(true);

    // Resuming starts it; interrupted again, the next start fails it instead of requeueing twice.
    t.deps.engine.scheduler.resumeQueue();
    await until('encoding', () => spawner.calls.length === 1);
    await t.deps.engine.stop();
    expect(row(id).state).toBe('encoding');
    const t2 = app(t.db);
    const again = await t2.deps.engine.start();
    expect(again.interrupted).toEqual([id]);
    expect(row(id)).toMatchObject({ state: 'failed', reason: 'interrupted', requeues: 1 });
  });

  it('start() with a replacing job whose journal says cleaning records done (the .orig removed)', async () => {
    const { id, file } = await queued();
    // On disk: the replacement installed at the path, the original kept as .orig.
    const orig = `${file}.transcoda-${id}.orig`;
    await writeFile(orig, Buffer.alloc(1000, 7));
    const fp = await fingerprintOf(orig);
    await writeFile(file, Buffer.alloc(600, 1));
    setSetting(t.db, 'queue.paused', true, t.clock.now());
    updateJob(
      t.db,
      id,
      {
        state: 'replacing',
        replaceJournal: {
          step: 'cleaning',
          originalPath: file,
          tmpPath: join(root, `.transcoda-${id}.tmp`),
          outputPath: join(transcodeDir, id, 'out.mkv'),
          copyPath: orig,
          libraryRoot: root,
          recycling: false,
          fingerprint: fp,
          outputBytes: 600,
        },
      },
      t.clock.now(),
    );
    // The job had recorded a failure before the restart; the finished replace replaces it.
    insertJobResult(t.db, {
      jobId: id,
      fingerprint: 'k',
      workflowId: row(id).workflowId,
      workflowVersion: row(id).workflowVersion,
      outcome: 'failed',
      beforeBytes: 1000,
      afterBytes: null,
      estimatedBytes: 500,
      command: 'ffmpeg …',
      plan: null,
      replacedTo: null,
      logPath: '/x.log',
      warnings: ['earlier'],
      problems: [],
      outputProbe: null,
      createdAt: t.clock.now().toISOString(),
    });
    const sweep = await t.deps.engine.start();
    expect(sweep.completed).toEqual([id]);
    expect(row(id)).toMatchObject({ state: 'done', replaceJournal: null, reason: null });
    expect(findJobResult(t.db, id)).toMatchObject({
      estimatedBytes: 500,
      command: 'ffmpeg …',
      logPath: '/x.log',
      warnings: ['earlier', 'replace finished by the startup sweep'],
    });
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'done',
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: 'deleted',
    });
    expect(await readdir(root)).toEqual(['a.mkv']);
    expect((await stat(file)).size).toBe(600);
  });

  it('start deletes expired test outputs and keeps current ones across a restart', async () => {
    const { id: first } = await queued();
    await writeFile(join(root, 'b.mkv'), Buffer.alloc(1000, 8));
    const r = await t.deps.engine.queue.queue({
      path: join(root, 'b.mkv'),
      workflowId: row(first).workflowId,
      dryRun: false,
      force: false,
      priority: 0,
      createdBy: 'u',
    });
    if (r.kind !== 'queued') throw new Error('queue');
    const second = (r.jobs[0] as JobRow).id;
    setSetting(t.db, 'queue.paused', true, t.clock.now());
    for (const id of [first, second]) {
      await mkdir(join(transcodeDir, id), { recursive: true });
      await writeFile(join(transcodeDir, id, 'out.mkv'), Buffer.alloc(600, 1));
      await t.deps.engine.testOutputs.keep(id, join(transcodeDir, id, 'out.mkv'), 'mkv');
    }
    await t.deps.engine.start();
    expect(t.deps.engine.testOutputs.find(first)).not.toBeNull();
    await t.deps.engine.stop();
    t.db
      .prepare('UPDATE test_outputs SET kept_until = ? WHERE job_id = ?')
      .run('2000-01-01T00:00:00.000Z', first);
    const t2 = app(t.db);
    await t2.deps.engine.start();
    expect(t2.deps.engine.testOutputs.find(first)).toBeNull();
    expect(t2.deps.engine.testOutputs.find(second)).not.toBeNull();
    expect(await readdir(join(transcodeDir, 'test-outputs'))).toEqual([`${second}.mkv`]);
    expect(t2.deps.engine.jobDetail(first)).toMatchObject({
      testOutput: null,
      testOutputNote: 'expired',
    });
    expect(t2.deps.engine.jobDetail(second)?.testOutput).toMatchObject({
      container: 'mkv',
      sizeBytes: 600,
    });
    expect(await t2.deps.engine.sweepTestOutputs()).toBe(0);
  });

  it('stop() kills an attached fake process and leaves the row as it was', async () => {
    const { id } = await queued();
    await t.deps.engine.start();
    await until('encoding', () => spawner.calls.length === 1);
    const before = row(id);
    expect(before.state).toBe('encoding');
    await t.deps.engine.stop();
    expect(spawner.signals).toEqual(['SIGKILL']);
    expect(row(id)).toEqual(before);
  });

  it('jobDetail, listJobs, jobStats and jobLog serve the read side', async () => {
    const { id } = await queued();
    await t.deps.engine.start();
    await until('encoding', () => spawner.calls.length === 1);
    const call = spawner.calls[0];
    if (!call) throw new Error('no spawn');
    await writeFile(call.args.at(-1) as string, Buffer.alloc(600, 1));
    await writeFile(call.logPath, '[libx264 @ 0x1] [warning] something\n');
    spawner.exit(0);
    await until('done', () => (['done', 'failed'] as JobState[]).includes(row(id).state));
    expect(row(id).state).toBe('done');

    const detail = t.deps.engine.jobDetail(id);
    expect(detail).toMatchObject({
      job: { id, fileName: 'a.mkv', libraryName: 'L', workflowName: 'Encode' },
      result: { outcome: 'done', afterBytes: 600 },
      probe: { container: 'mkv' },
      plan: { rewrite: true },
    });
    expect(detail?.probe).not.toHaveProperty('raw');
    // The job keeps its own probe: a later probe of the (replaced) file does not change it.
    t.db.prepare('UPDATE files SET last_probe = ?').run(JSON.stringify({ container: 'mp4' }));
    expect(t.deps.engine.jobDetail(id)?.probe).toMatchObject({ container: 'mkv' });
    expect(detail?.graph?.nodes.map((n) => n.id)).toEqual(['in', 'ev', 'ro']);
    expect(detail?.trace.map((e) => e.nodeId)).toEqual(['in', 'ev', 'ro']);
    expect(detail?.path.map((s) => s.nodeId)).toEqual(['in', 'ev', 'ro']);
    expect(t.deps.engine.jobDetail('nope')).toBeNull();

    const list = t.deps.engine.listJobs({});
    expect(list.jobs.map((j) => j.id)).toEqual([id]);
    expect(list.counts.done).toBe(1);
    expect(t.deps.engine.jobStats('2000-01-01T00:00:00.000Z')).toMatchObject({
      files: 1,
      savedBytes: 400,
    });
    expect(await t.deps.engine.jobLog(id)).toBe('[libx264 @ 0x1] [warning] something\n');
    expect(await t.deps.engine.jobLog('nope')).toBeNull();
  });
});
