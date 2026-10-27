import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJob, insertJobResult, updateJob } from '../../db/repos/jobs.ts';
import { tempDir } from '../../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../../engine/fs-ops.ts';
import { logPathFor } from '../../engine/pipeline.ts';
import { FakeSpawner } from '../../engine/process.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { createToken, login } from '../../test-http.ts';
import { chain, node } from '../../workflows/test-helpers.ts';
import { mcpClient } from '../test-client.ts';
import { jobTools } from './jobs.ts';
import { libraryTools } from './library.ts';

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

let base: string;
let root: string;
let t: TestApp;
let spawner: FakeSpawner;
let session: Awaited<ReturnType<typeof login>> | undefined;

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

/** ffprobe answers for a 60 s hevc+aac mkv; ffmpeg runs succeed quietly. */
const exec: Exec = async (_file, args) => {
  if (args.includes('-show_format')) {
    const json = {
      format: { format_name: 'matroska,webm', duration: '60.000000', size: '100', start_time: '0' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
        { index: 1, codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
      ],
    };
    return { stdout: JSON.stringify(json), stderr: '' };
  }
  if (args.includes('packet=pts_time,duration_time')) return { stdout: '59.96,0.04\n', stderr: '' };
  if (args.includes('-read_intervals')) return { stdout: '55.0,1000,K__\n', stderr: '' };
  return { stdout: '', stderr: '' };
};
const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

beforeEach(async () => {
  base = await tempDir('mcp-jobs-');
  root = join(base, 'lib');
  await mkdir(root, { recursive: true });
  for (const f of ['a.mkv', 'b.mkv', 'c.mkv']) await writeFile(join(root, f), Buffer.alloc(100, 7));
  spawner = new FakeSpawner();
  t = createTestApp({
    capabilities: caps,
    spawner,
    fsOps,
    exec,
    config: {
      configDir: join(base, 'config'),
      transcodeDir: join(base, 'transcode'),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
    mcpTools: [...jobTools, ...libraryTools],
  });
  session = undefined;
  await t.deps.engine.start();
});

afterEach(async () => {
  await t.deps.engine.stop();
  await rm(base, { recursive: true, force: true });
});

/** Queues a dry run of each file with the queue paused, so the jobs stay `queued`. */
async function queueFiles(files: string[]): Promise<string[]> {
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
  const lib = await t.deps.engine.queue.createLibrary({ name: 'L', path: root });
  if ('kind' in lib) throw new Error('library');
  t.deps.engine.scheduler.pauseQueue();
  const ids: string[] = [];
  for (const f of files) {
    const r = await t.deps.engine.queue.queue({
      path: join(root, f),
      workflowId: wf,
      dryRun: true,
      force: false,
      priority: 0,
      createdBy: 'u',
    });
    if (r.kind !== 'queued') throw new Error(`queue ${r.kind}`);
    for (const j of r.jobs) ids.push(j.id);
  }
  return ids;
}

async function client(scopes: string[]) {
  session ??= await login(t);
  const s = session;
  const { token } = await createToken(t, s, { name: 'm', scopes });
  return mcpClient(t, token);
}

describe('job tools', () => {
  it('list_jobs pages with nextCursor and filters by state; counts cover the scope', async () => {
    await queueFiles(['a.mkv', 'b.mkv', 'c.mkv']);
    const c = await client(['read']);
    const first = await c.callTool({ name: 'list_jobs', arguments: { limit: 2 } });
    const f = first.structuredContent as {
      jobs: { id: string }[];
      nextCursor: string | null;
      counts: Record<string, number>;
    };
    expect(f.jobs).toHaveLength(2);
    expect(f.nextCursor).toBe(f.jobs[1]?.id);
    expect(f.counts.queued).toBe(3);
    expect(text(first)).toMatch(/^2 of 3 jobs\n/);
    expect(text(first)).toContain(`More: call again with before="${f.nextCursor}"`);

    const second = await c.callTool({
      name: 'list_jobs',
      arguments: { limit: 2, before: f.nextCursor },
    });
    const s2 = second.structuredContent as { jobs: unknown[]; nextCursor: string | null };
    expect(s2.jobs).toHaveLength(1);
    expect(s2.nextCursor).toBeNull();

    const none = await c.callTool({ name: 'list_jobs', arguments: { state: 'done' } });
    const n = none.structuredContent as { jobs: unknown[]; counts: Record<string, number> };
    expect(n.jobs).toEqual([]);
    expect(n.counts.queued).toBe(3);
  });

  it("list_jobs and get_run carry a dry run job's estimate and plan summary; a job without them says null", async () => {
    const [planned, waiting] = await queueFiles(['a.mkv', 'b.mkv']);
    if (!planned || !waiting) throw new Error('jobs');
    const job = findJob(t.db, planned);
    if (!job) throw new Error('job');
    updateJob(t.db, planned, { state: 'dry_run' }, new Date());
    insertJobResult(t.db, {
      jobId: planned,
      fingerprint: 'k1',
      workflowId: job.workflowId,
      workflowVersion: job.workflowVersion,
      outcome: 'dry_run',
      beforeBytes: 100,
      afterBytes: null,
      estimatedBytes: 60,
      command: null,
      plan: {
        container: { from: 'mkv', to: 'mkv' },
        rewrite: true,
        streams: [
          {
            index: 0,
            type: 'video',
            codec: 'hevc',
            language: null,
            title: null,
            isOriginalLanguage: false,
            default: { before: true, after: true },
            forced: false,
            action: 'convert',
            note: '',
          },
        ],
      },
      replacedTo: null,
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      createdAt: '2026-10-18T10:00:00.000Z',
    });
    const c = await client(['read']);
    const res = await c.callTool({ name: 'list_jobs', arguments: {} });
    const jobs = (
      res.structuredContent as {
        jobs: { id: string; estimatedBytes: number | null; planSummary: string | null }[];
      }
    ).jobs;
    expect(jobs.find((j) => j.id === planned)).toMatchObject({
      estimatedBytes: 60,
      planSummary: 'convert 1 video track',
    });
    expect(jobs.find((j) => j.id === waiting)).toMatchObject({
      estimatedBytes: null,
      planSummary: null,
    });
    expect(text(res)).toContain('convert 1 video track');

    type RunFiles = {
      files: { jobId: string; estimatedBytes: number | null; planSummary: string | null }[];
    };
    const runOf = async (jobId: string): Promise<RunFiles> => {
      const runId = findJob(t.db, jobId)?.runId;
      const run = await c.callTool({ name: 'get_run', arguments: { id: runId } });
      return run.structuredContent as RunFiles;
    };
    expect((await runOf(planned)).files[0]).toMatchObject({
      estimatedBytes: 60,
      planSummary: 'convert 1 video track',
    });
    expect((await runOf(waiting)).files[0]).toMatchObject({
      estimatedBytes: null,
      planSummary: null,
    });
  });

  it('get_job on a queued job: state queued, failingNode null, path [], workflow fields set, text ends with the Next line', async () => {
    const [id] = await queueFiles(['a.mkv']);
    const c = await client(['read']);
    const res = await c.callTool({ name: 'get_job', arguments: { id } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      id,
      state: 'queued',
      failingNode: null,
      path: [],
      workflowName: 'Encode',
      workflowVersion: 2,
      dryRun: true,
    });
    expect(text(res)).toMatch(
      /Next: get_job_log for the ffmpeg log; get_workflow \S+ version 2 for the graph\.$/,
    );
  });

  it('get_job_log before the job ran → log "", bytes 0, truncated false; maxBytes bounds a stored log and sets truncated', async () => {
    const [id] = await queueFiles(['a.mkv']);
    const c = await client(['read']);
    const empty = await c.callTool({ name: 'get_job_log', arguments: { id } });
    expect(empty.structuredContent).toEqual({ log: '', bytes: 0, truncated: false });
    expect(text(empty)).toBe('No log yet.');

    const row = findJob(t.db, id as string);
    if (!row) throw new Error('row');
    const path = logPathFor(t.deps.config, row);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'y'.repeat(3000));
    const cut = await c.callTool({ name: 'get_job_log', arguments: { id, maxBytes: 256 } });
    expect(cut.structuredContent).toEqual({ log: 'y'.repeat(256), bytes: 256, truncated: true });
    const whole = await c.callTool({ name: 'get_job_log', arguments: { id, maxBytes: 4096 } });
    expect(whole.structuredContent).toMatchObject({ bytes: 3000, truncated: false });
  });

  it('pause_job/resume_job/cancel_job need jobs:manage (hidden for read); cancel of a cancelled job → isError JOB_NOT_ACTIVE', async () => {
    const [id] = await queueFiles(['a.mkv']);
    const read = await client(['read']);
    const names = (await read.listTools()).tools.map((x) => x.name);
    expect(names).toContain('list_jobs');
    expect(names).not.toContain('pause_job');
    expect(names).not.toContain('cancel_job');

    const manage = await client(['read', 'jobs:manage']);
    const paused = await manage.callTool({ name: 'pause_job', arguments: { id } });
    expect(paused.structuredContent).toEqual({ ok: true, id });
    expect(findJob(t.db, id as string)?.paused).toBe(true);
    const resumed = await manage.callTool({ name: 'resume_job', arguments: { id } });
    expect(resumed.isError).toBeFalsy();
    expect(findJob(t.db, id as string)?.paused).toBe(false);

    const cancelled = await manage.callTool({ name: 'cancel_job', arguments: { id } });
    expect(cancelled.isError).toBeFalsy();
    expect(text(cancelled)).toBe(`Cancelled job ${id}.`);
    const again = await manage.callTool({ name: 'cancel_job', arguments: { id } });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/^JOB_NOT_ACTIVE: /);
  });
  it('get_job_log never starts on half a surrogate pair', async () => {
    const [id] = await queueFiles(['a.mkv']);
    const row = findJob(t.db, id as string);
    if (!row) throw new Error('row');
    const path = logPathFor(t.deps.config, row);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '\u{1F600}'.repeat(200));
    const c = await client(['read']);
    const res = await c.callTool({ name: 'get_job_log', arguments: { id, maxBytes: 257 } });
    const out = res.structuredContent as { log: string; truncated: boolean };
    expect(out.log).toBe('\u{1F600}'.repeat(128));
    expect(out.truncated).toBe(true);
  });

  it('get_job on a real failed job names no failing node for an ffmpeg failure and titles the path from graph labels', async () => {
    const { id: wf } = t.deps.workflows.create({ name: 'Encode', kind: 'workflow' }, 'u');
    t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 1,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node(
            'ev',
            'core:encode-video',
            { codec: 'h264', encoder: 'libx264', skipIf: 'never' },
            {
              label: 'Make it small',
            },
          ),
          node('ro', 'core:replace-original', {}, { label: 'Swap in result' }),
        ),
      },
      'u',
    );
    expect(t.deps.workflows.activate(wf, 2, 'u').kind).toBe('ok');
    const lib = await t.deps.engine.queue.createLibrary({ name: 'L', path: root });
    if ('kind' in lib) throw new Error('library');
    const r = await t.deps.engine.queue.queue({
      path: join(root, 'a.mkv'),
      workflowId: wf,
      dryRun: false,
      force: false,
      priority: 0,
      createdBy: 'u',
    });
    if (r.kind !== 'queued') throw new Error(`queue ${r.kind}`);
    const id = (r.jobs[0] as { id: string }).id;
    const until = async (what: string, pred: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((res) => setTimeout(res, 5));
      }
    };
    // A failed ffmpeg run is retried once; the second failure is final.
    await until('first ffmpeg', () => spawner.calls.length === 1);
    spawner.exit(1);
    await until('retry', () => spawner.calls.length === 2);
    spawner.exit(1);
    await until('failed', () => findJob(t.db, id)?.state === 'failed');

    const c = await client(['read']);
    const res = await c.callTool({ name: 'get_job', arguments: { id } });
    expect(res.isError).toBeFalsy();
    const report = res.structuredContent as {
      state: string;
      failingNode: { nodeId: string; title: string; reason: string } | null;
      path: { nodeId: string; title: string }[];
    };
    expect(report.state).toBe('failed');
    // ffmpeg fails after the walk and no trace entry records it: no node is named.
    expect(report.failingNode).toBeNull();
    expect(report.path.map((p) => p.title)).toEqual([
      'Manual input',
      'Make it small',
      'Render',
      'Swap in result',
    ]);
    expect(text(res)).toMatch(/^Job \S+: failed — ffmpeg exited 1\n/);
    expect(text(res)).toContain(
      'Failed during the ffmpeg encode, not at a workflow node: ffmpeg exited 1',
    );
    expect(text(res)).not.toContain('Failing node');
  });
});
