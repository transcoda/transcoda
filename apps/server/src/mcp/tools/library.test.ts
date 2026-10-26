import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJob } from '../../db/repos/jobs.ts';
import { findRun } from '../../db/repos/runs.ts';
import { tempDir } from '../../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../../engine/fs-ops.ts';
import { FakeSpawner } from '../../engine/process.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, createToken, login, type Session, send } from '../../test-http.ts';
import { chain, node } from '../../workflows/test-helpers.ts';
import { mcpClient } from '../test-client.ts';
import { libraryTools, type RunBrief, runLine } from './library.ts';

vi.setConfig({ testTimeout: 30_000 });

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
      format: {
        format_name: 'matroska,webm',
        duration: '60.000000',
        size: '1000',
        start_time: '0.000000',
      },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
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

const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

let base: string;
let root: string;
let outside: string;
let t: TestApp;
let s: Session;
let libraryId: string;
let workflowId: string;

beforeEach(async () => {
  base = await tempDir('mcp-library-');
  root = join(base, 'lib');
  outside = join(base, 'outside');
  await mkdir(join(root, 'Show', 'Season 1'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'a.mkv'), Buffer.alloc(1000, 7));
  await writeFile(join(root, 'b.mkv'), Buffer.alloc(1000, 7));
  await writeFile(join(outside, 'x.mkv'), Buffer.alloc(1000, 7));
  await symlink(outside, join(root, 'link'));
  t = createTestApp({
    config: {
      configDir: join(base, 'config'),
      transcodeDir: join(base, 'transcode'),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
    capabilities: caps,
    spawner: new FakeSpawner(),
    fsOps,
    exec,
    heartbeatMs: 10,
    mcpTools: libraryTools,
  });
  await t.deps.engine.start();
  s = await login(t);
  const created = await send(t, 'POST', '/libraries', {
    body: { name: 'TV', path: root },
    headers: asSession(s, true),
  });
  expect(created.status).toBe(200);
  const lib = (await created.json()) as { id: string; path: string };
  libraryId = lib.id;
  // The library stores the root's realpath (macOS temp dirs are symlinks).
  root = lib.path;
  workflowId = validWorkflow();
});

afterEach(async () => {
  await t.deps.engine.stop();
  await rm(base, { recursive: true, force: true });
});

function validWorkflow(): string {
  const { id } = t.deps.workflows.create({ name: 'Replace', kind: 'workflow' }, 'u');
  t.deps.workflows.save(
    {
      id,
      baseVersion: 1,
      graph: chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
      ),
    },
    'u',
  );
  return id;
}

async function clientFor(scopes: ('read' | 'plan' | 'jobs:create')[]) {
  const { token } = await createToken(t, s, { name: scopes.join('+'), scopes });
  return mcpClient(t, token);
}

describe('library tools', () => {
  it('list_libraries and browse_library return absolute paths under the root; "..", an absolute path and a symlink out of the root are PATH_REJECTED', async () => {
    const client = await clientFor(['read']);

    const libs = await client.callTool({ name: 'list_libraries', arguments: {} });
    expect(libs.structuredContent).toMatchObject({
      libraries: [{ id: libraryId, name: 'TV', path: root, feeds: null, namedByInactive: [] }],
    });
    expect(
      (libs.structuredContent as { libraries: Record<string, unknown>[] }).libraries[0],
    ).not.toHaveProperty('defaultWorkflowId');
    expect(text(libs)).toBe(`TV (${libraryId}): ${root}, no workflow takes files from it`);

    const top = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId, path: '' },
    });
    const topData = top.structuredContent as {
      root: string;
      dirs: { name: string; path: string }[];
      files: { name: string; path: string }[];
    };
    expect(topData.root).toBe(root);
    expect(topData.dirs).toContainEqual({ name: 'Show', path: join(root, 'Show') });
    expect(topData.files[0]?.path).toBe(join(root, 'a.mkv'));
    expect(text(top)).toContain(
      `${root}: ${topData.dirs.length} folders, ${topData.files.length} media files`,
    );
    expect(text(top)).toContain(`d ${join(root, 'Show')}`);

    const show = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId, path: 'Show' },
    });
    expect(show.structuredContent).toMatchObject({
      dirs: [{ name: 'Season 1', path: join(root, 'Show', 'Season 1') }],
    });

    const dotdot = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId, path: '..' },
    });
    expect(dotdot.isError).toBe(true);
    expect(text(dotdot)).toMatch(/^PATH_REJECTED: /);
    expect(text(dotdot)).toContain('outside library root');

    const insideAbsolute = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId, path: join(root, 'Show') },
    });
    expect(insideAbsolute.isError).toBe(true);
    expect(text(insideAbsolute)).toMatch(/^PATH_REJECTED: /);

    const absolute = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId, path: outside },
    });
    expect(text(absolute)).toMatch(/^PATH_REJECTED: /);

    const link = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId, path: 'link' },
    });
    expect(text(link)).toMatch(/^PATH_REJECTED: /);
    expect(text(link)).toContain('symlink escapes root');

    const nope = await client.callTool({
      name: 'browse_library',
      arguments: { libraryId: 'nope' },
    });
    expect(text(nope)).toMatch(/^NOT_FOUND: /);
  });

  it('dry_run queues a dry run only: the run row has dryRun true and a call carrying dryRun:false (or any unknown key) is refused; a plan token may call it; a read token cannot see it; paths outside a library are PATH_REJECTED', async () => {
    const read = await clientFor(['read']);
    expect((await read.listTools()).tools.map((x) => x.name)).not.toContain('dry_run');
    const denied = await read.callTool({ name: 'dry_run', arguments: { path: root } });
    expect(denied.isError).toBe(true);

    const plan = await clientFor(['plan', 'read']);
    // Unknown keys are refused (never silently dropped), and nothing is queued.
    for (const extra of [{ dryRun: false }, { workflowVersion: 1 }, { mode: 'enabled' }]) {
      const refused = await plan.callTool({
        name: 'dry_run',
        arguments: { path: join(root, 'a.mkv'), workflowId, ...extra },
      });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/Input validation error/);
      expect(text(refused)).toContain(Object.keys(extra)[0] as string);
    }
    const none = await send(t, 'GET', '/jobs', { headers: asSession(s, false) });
    expect(((await none.json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
    const res = await plan.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'a.mkv'), workflowId },
    });
    expect(res.isError).not.toBe(true);
    const data = res.structuredContent as { runId: string; jobIds: string[]; dryRun: boolean };
    expect(data.dryRun).toBe(true);
    expect(data.jobIds).toHaveLength(1);
    expect(text(res)).toBe(
      `Dry run ${data.runId} of v2 queued: 1 file(s). Nothing on disk changes. ` +
        `Next: get_job ${data.jobIds[0]} for the plan and decisions (poll until its state is final: done, failed, cancelled, skipped, nothing_to_do, kept_original, dry_run or already_processed).`,
    );
    const run = await plan.callTool({ name: 'get_run', arguments: { id: data.runId } });
    expect(run.structuredContent).toMatchObject({ id: data.runId, dryRun: true });
    const jobs = await send(t, 'GET', `/jobs?runId=${data.runId}`, {
      headers: asSession(s, false),
    });
    expect(((await jobs.json()) as { jobs: { dryRun: boolean }[] }).jobs[0]?.dryRun).toBe(true);

    const create = await clientFor(['jobs:create']);
    expect((await create.listTools()).tools.map((x) => x.name)).toEqual(['dry_run']);
    const viaCreate = await create.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'b.mkv'), workflowId },
    });
    const createData = viaCreate.structuredContent as { runId: string; dryRun: boolean };
    expect(createData.dryRun).toBe(true);
    const runs = await send(t, 'GET', `/runs/${createData.runId}`, {
      headers: asSession(s, false),
    });
    expect(((await runs.json()) as { run: { dryRun: boolean } }).run.dryRun).toBe(true);

    const outsideRes = await plan.callTool({
      name: 'dry_run',
      arguments: { path: join(outside, 'x.mkv'), workflowId },
    });
    expect(outsideRes.isError).toBe(true);
    expect(text(outsideRes)).toMatch(/^PATH_REJECTED: /);
  });

  it("the instructions say the active version's Library input is the binding", async () => {
    const client = await clientFor(['read']);
    expect(client.getInstructions()).toContain(
      "A workflow takes files from a library through its Library input; the active version's Library input is the binding, and only one active workflow can feed a library. dry_run without workflowId uses that workflow.",
    );
  });

  it("list_libraries names the feeder (fed by Downsize v1); dry_run without workflowId plans the feeder's newest version", async () => {
    const fromLibrary = () =>
      chain(
        'workflow',
        node('in', 'core:input-library', { libraryId }),
        node('ro', 'core:replace-original'),
      );
    const { id: feeder } = t.deps.workflows.create(
      { name: 'Downsize', kind: 'workflow', graph: fromLibrary() },
      'u',
    );
    const named = await (await clientFor(['read'])).callTool({
      name: 'list_libraries',
      arguments: {},
    });
    expect(text(named)).toBe(
      `TV (${libraryId}): ${root}, no workflow takes files from it; named by Downsize v1 (not active)`,
    );
    expect(named.structuredContent).toMatchObject({
      libraries: [
        { id: libraryId, feeds: null, namedByInactive: [{ workflowId: feeder, version: 1 }] },
      ],
    });
    expect(t.deps.workflows.activate(feeder, 1, 'u').kind).toBe('ok');
    const client = await clientFor(['read', 'plan']);
    const libs = await client.callTool({ name: 'list_libraries', arguments: {} });
    expect(text(libs)).toBe(`TV (${libraryId}): ${root}, fed by Downsize v1`);
    expect(libs.structuredContent).toMatchObject({
      libraries: [
        {
          id: libraryId,
          feeds: { workflowId: feeder, name: 'Downsize', version: 1 },
          namedByInactive: [],
        },
      ],
    });

    t.deps.workflows.save({ id: feeder, baseVersion: 1, graph: fromLibrary() }, 'u');
    const res = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'a.mkv') },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as { runId: string; version: number };
    expect(data.version).toBe(2);
    const run = await client.callTool({ name: 'get_run', arguments: { id: data.runId } });
    expect(run.structuredContent).toMatchObject({ workflowId: feeder, workflowVersion: 2 });
  });

  it('dry_run without a workflow on a library nobody feeds → NO_FEEDING_WORKFLOW; with an invalid workflow → WORKFLOW_INVALID listing issues', async () => {
    const client = await clientFor(['plan']);
    const none = await client.callTool({ name: 'dry_run', arguments: { path: root } });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/^NO_FEEDING_WORKFLOW: /);

    const { id: broken } = t.deps.workflows.create({ name: 'Broken', kind: 'workflow' }, 'u');
    t.deps.workflows.save(
      { id: broken, baseVersion: 1, graph: chain('workflow', node('in', 'core:input-manual')) },
      'u',
    );
    const invalid = await client.callTool({
      name: 'dry_run',
      arguments: { path: root, workflowId: broken },
    });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toMatch(/^WORKFLOW_INVALID: /);
    expect(text(invalid)).toMatch(/^WORKFLOW_INVALID: /);
  });

  it('dry_run plans the newest version by default, the named one with version, and refuses an unknown one', async () => {
    t.deps.workflows.save(
      {
        id: workflowId,
        baseVersion: 2,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('ro', 'core:replace-original', {}, { label: 'Swap' }),
        ),
      },
      'u',
    );
    const client = await clientFor(['plan', 'read']);
    const newest = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'a.mkv'), workflowId },
    });
    expect(newest.structuredContent).toMatchObject({ version: 3, dryRun: true });
    expect(text(newest)).toContain('of v3 queued');
    const picked = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'a.mkv'), workflowId, version: 2 },
    });
    const pickedData = picked.structuredContent as { runId: string; version: number };
    expect(pickedData.version).toBe(2);
    expect(text(picked)).toContain(`Dry run ${pickedData.runId} of v2 queued`);
    const run = await client.callTool({ name: 'get_run', arguments: { id: pickedData.runId } });
    expect(run.structuredContent).toMatchObject({ workflowVersion: 2, dryRun: true });
    const missing = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'a.mkv'), workflowId, version: 9 },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^NOT_FOUND: /);
  });

  it('dry_run test-encodes only when testEncode is true: default false on a single file, true when asked; test_encode is refused', async () => {
    const client = await clientFor(['plan']);
    const res = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'a.mkv'), workflowId },
    });
    const data = res.structuredContent as { runId: string; jobIds: string[]; testEncode: boolean };
    expect(data.jobIds).toHaveLength(1);
    expect(data.testEncode).toBe(false);
    expect(text(res)).toMatch(/^Dry run /);
    expect(findRun(t.deps.db, data.runId)?.testEncode).toBe(false);
    expect(findJob(t.deps.db, data.jobIds[0] ?? '')?.testEncode).toBe(false);

    const refused = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'b.mkv'), workflowId, test_encode: true },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/Input validation error[\s\S]*test_encode/);

    const enc = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'b.mkv'), workflowId, testEncode: true },
    });
    expect(enc.isError).not.toBe(true);
    const encData = enc.structuredContent as {
      runId: string;
      jobIds: string[];
      dryRun: boolean;
      testEncode: boolean;
    };
    expect(encData).toMatchObject({ dryRun: true, testEncode: true });
    expect(text(enc)).toMatch(
      new RegExp(`^Test-encode dry run ${encData.runId} of v2 queued: 1 file\\(s\\)\\.`),
    );
    expect(findRun(t.deps.db, encData.runId)?.testEncode).toBe(true);
    expect(findRun(t.deps.db, encData.runId)?.dryRun).toBe(true);
    expect(findJob(t.deps.db, encData.jobIds[0] ?? '')?.testEncode).toBe(true);
  });

  it('dry_run describes testEncode and says nothing in the library is written either way', async () => {
    const client = await clientFor(['plan']);
    const tool = (await client.listTools()).tools.find((x) => x.name === 'dry_run');
    expect(tool?.description).toContain(
      'With testEncode the dry run encodes and verifies the file and reports the measured size; nothing in the library is written either way.',
    );
    if (!tool) throw new Error('dry_run is not listed');
    const props = (tool.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.testEncode?.description).toBe(
      'Also encode, verify and measure for real (slow; uses the encode lane); still writes nothing to the library',
    );
  });

  it('dry_run on a folder with no media files queues nothing and does not name a job', async () => {
    const client = await clientFor(['plan']);
    const res = await client.callTool({
      name: 'dry_run',
      arguments: { path: join(root, 'Show', 'Season 1'), workflowId },
    });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toMatchObject({ jobIds: [], dryRun: true });
    expect(text(res)).toContain('nothing was queued');
    expect(text(res)).not.toContain('undefined');
  });

  it('list_runs and get_run: the queued dry run shows counts, files and the "shows N of M" line with limit 1 on a 2-file run', async () => {
    const client = await clientFor(['read', 'plan']);
    const queued = await client.callTool({
      name: 'dry_run',
      arguments: { path: root, workflowId },
    });
    const { runId, jobIds } = queued.structuredContent as { runId: string; jobIds: string[] };
    expect(jobIds).toHaveLength(2);

    const list = await client.callTool({ name: 'list_runs', arguments: {} });
    const runs = (list.structuredContent as { runs: { id: string; counts: { total: number } }[] })
      .runs;
    expect(runs[0]).toMatchObject({ id: runId, counts: { total: 2 } });
    expect(text(list)).toContain(`${runId} [dry run] Replace v2 on ${root}: 2 files,`);

    const run = await client.callTool({ name: 'get_run', arguments: { id: runId, limit: 1 } });
    const data = run.structuredContent as {
      files: { jobId: string }[];
      total: number;
      counts: RunBrief['counts'];
    };
    expect(data.total).toBe(2);
    expect(data.files).toHaveLength(1);
    expect(text(run)).toContain('The list shows 1 of 2 files.');

    const all = await client.callTool({ name: 'get_run', arguments: { id: runId } });
    expect((all.structuredContent as { files: unknown[] }).files).toHaveLength(2);
    expect(text(all)).not.toContain('The list shows');

    const missing = await client.callTool({ name: 'get_run', arguments: { id: 'nope' } });
    expect(text(missing)).toMatch(/^NOT_FOUND: /);
  });
});

describe('runLine', () => {
  const counts = (over: Partial<RunBrief['counts']>): RunBrief['counts'] => ({
    done: 0,
    nothing_to_do: 0,
    kept_original: 0,
    failed: 0,
    cancelled: 0,
    dry_run: 0,
    skipped: 0,
    already_processed: 0,
    queued: 0,
    in_progress: 0,
    total: 0,
    beforeBytes: 0,
    afterBytes: 0,
    dependsOnSize: 0,
    ...over,
  });
  const brief = (dryRun: boolean, c: RunBrief['counts']): RunBrief => ({
    id: 'r1',
    libraryName: 'TV',
    workflowId: 'w1',
    workflowName: 'Shrink',
    workflowVersion: 2,
    requestedPath: '/media',
    dryRun,
    force: false,
    createdAt: '2026-10-21T18:00:00.000Z',
    counts: c,
  });

  it('a dry run counts would replace, depend on size and nothing to do apart (#41)', () => {
    expect(
      runLine(
        brief(
          true,
          counts({ dry_run: 5, dependsOnSize: 2, kept_original: 1, nothing_to_do: 1, total: 7 }),
        ),
      ),
    ).toBe(
      'r1 [dry run] Shrink v2 on /media: 7 files, 0 queued, 0 in progress, 3 would replace, 2 depend on size, 1 would keep original, 1 nothing to do, 0 failed',
    );
  });

  it('a dry run with nothing depending on size leaves that count out', () => {
    expect(runLine(brief(true, counts({ dry_run: 2, total: 2 })))).toBe(
      'r1 [dry run] Shrink v2 on /media: 2 files, 0 queued, 0 in progress, 2 would replace, 0 would keep original, 0 nothing to do, 0 failed',
    );
  });

  it('a real run says replaced', () => {
    expect(runLine(brief(false, counts({ done: 2, total: 2 })))).toBe(
      'r1 Shrink v2 on /media: 2 files, 0 queued, 0 in progress, 2 replaced, 0 failed',
    );
  });
});
