import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asSession, bearer, createToken, send } from '../../app/test-http.ts';
import { updateJob } from '../../db/repos/jobs/jobs.ts';
import { setSetting } from '../../db/repos/settings.ts';
import { chain, node } from '../../workflows/test-helpers.ts';
import {
  base,
  createLibrary,
  encodeWorkflow,
  fedLibrary,
  finishEncode,
  get,
  isFinal,
  json,
  outside,
  queue,
  queued,
  readEvents,
  root,
  row,
  SECRET,
  s,
  spawner,
  t,
  transcodeDir,
  until,
  useRpcApp,
} from './testing.ts';

useRpcApp();

describe('jobs', () => {
  it('jobs.queue: a file in a library → 200 { runId, jobIds: 1 }; outside any library → 400 PATH_REJECTED; plan token may queue a dry run only (403 for a real run); read token → 403', async () => {
    const { wf } = await fedLibrary();
    // Nothing starts while the queue is paused, so the jobs stay queued for this test.
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );

    const ok = await queued({ path: join(root, 'a.mkv') });
    expect(ok.jobIds).toHaveLength(1);
    expect(row(ok.jobIds[0] as string)).toMatchObject({ runId: ok.runId, state: 'queued' });

    await symlink(join(outside, 'x.mkv'), join(root, 'leak.mkv'));
    const leak = await queue({ path: join(root, 'leak.mkv') });
    expect(leak.status).toBe(400);
    expect(await json(leak)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: join(root, 'leak.mkv'), reason: 'symlink escapes root' },
    });

    // fileOnly (Run on a file): a folder is refused; only Scan now runs a whole folder for real.
    const folder = await queue({ path: root, fileOnly: true });
    expect(folder.status).toBe(400);
    expect(await json(folder)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: root, reason: 'not a file' },
    });
    expect(
      (await queued({ path: join(root, 'a.mkv'), fileOnly: true, force: true })).jobIds,
    ).toHaveLength(1);

    const out = await queue({ path: join(outside, 'x.mkv') });
    expect(out.status).toBe(400);
    expect(await json(out)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: join(outside, 'x.mkv'), reason: 'outside library root' },
    });

    const plan = await createToken(t, s, { name: 'diskmap', scopes: ['plan'] });
    const dry = await queue({ path: join(root, 'a.mkv'), dryRun: true }, bearer(plan.token));
    expect(dry.status).toBe(200);
    const dryJob = (await json<{ jobIds: string[] }>(dry)).jobIds[0] as string;
    expect(row(dryJob).dryRun).toBe(true);
    // `plan` is not `read`: it cannot read the job it queued (scopes are exact).
    expect((await get(`/jobs/${dryJob}`, bearer(plan.token))).status).toBe(403);
    const real = await queue({ path: join(root, 'a.mkv'), force: true }, bearer(plan.token));
    expect(real.status).toBe(403);

    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    expect(
      (await queue({ path: join(root, 'a.mkv'), dryRun: true }, bearer(read.token))).status,
    ).toBe(403);
    const create = await createToken(t, s, { name: 'ci', scopes: ['jobs:create'] });
    expect(
      (await queue({ path: join(root, 'a.mkv'), force: true }, bearer(create.token))).status,
    ).toBe(200);

    const noWorkflow = await queue({ path: join(root, 'a.mkv'), workflowId: 'nope' });
    expect(noWorkflow.status).toBe(404);
    expect(t.deps.workflows.deactivate(wf).kind).toBe('ok');
    const noFeeder = await queue({ path: join(root, 'a.mkv') });
    expect(noFeeder.status).toBe(400);
    expect(await json(noFeeder)).toMatchObject({ code: 'NO_FEEDING_WORKFLOW' });
  });

  it('jobs.queue: reports dryRun, note and workflowVersion; a dry run can pin a version; unknown versions are 404; a real run with nothing active becomes a dry run; a blocked active version is 422', async () => {
    const { wf } = await fedLibrary();
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const file = join(root, 'a.mkv');

    const real = await queue({ path: file });
    expect(real.status).toBe(200);
    expect(await json(real)).toMatchObject({ dryRun: false, note: null, workflowVersion: 2 });

    // Version 3 is newer than the active 2; a dry run without a version plans with it.
    t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 2,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('ev', 'core:encode-video', { codec: 'hevc', encoder: 'libx265', skipIf: 'never' }),
          node('ro', 'core:replace-original'),
        ),
      },
      'u',
    );
    const newest = await queue({ path: file, dryRun: true });
    expect(await json(newest)).toMatchObject({ dryRun: true, workflowVersion: 3 });

    const pinned = await queue({ path: file, dryRun: true, workflowVersion: 2 });
    expect(pinned.status).toBe(200);
    const pinnedBody = await json<{ runId: string; workflowVersion: number; dryRun: boolean }>(
      pinned,
    );
    expect(pinnedBody).toMatchObject({ dryRun: true, note: null, workflowVersion: 2 });
    expect(await json(await get(`/runs/${pinnedBody.runId}`))).toMatchObject({
      run: { workflowVersion: 2, dryRun: true },
    });

    const withReal = await queue({ path: file, workflowVersion: 2 });
    expect(withReal.status).toBe(400);
    const unknown = await queue({ path: file, dryRun: true, workflowVersion: 99 });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ message: 'Workflow version not found' });

    // A blocked active version refuses a real run.
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 2')
      .run('{', wf);
    const blocked = await queue({ path: file });
    expect(blocked.status).toBe(422);
    expect(await json(blocked)).toMatchObject({ code: 'WORKFLOW_INVALID' });
    t.db
      .prepare(
        'UPDATE workflow_versions SET graph = (SELECT graph FROM workflow_versions WHERE workflow_id = ? AND version = 3) WHERE workflow_id = ? AND version = 2',
      )
      .run(wf, wf);

    // Nothing active: the real request for that workflow is queued as a dry run and says so.
    expect(t.deps.workflows.deactivate(wf).kind).toBe('ok');
    const none = await queue({ path: file, workflowId: wf });
    expect(none.status).toBe(200);
    expect(await json(none)).toMatchObject({
      dryRun: true,
      note: 'no active version',
      workflowVersion: 3,
    });
  });

  it('jobs.queue: a dry run of one file test-encodes by default, a folder does not; testEncode on a real run is 400; a plan token may test-encode; jobs.get and runs.get carry the flag', async () => {
    await fedLibrary();
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const file = join(root, 'a.mkv');

    const single = await queued({ path: file, dryRun: true });
    expect(single).toMatchObject({ testEncode: true });
    const off = await queued({ path: file, dryRun: true, testEncode: false });
    expect(off).toMatchObject({ testEncode: false });
    const folder = await queued({ path: root, dryRun: true });
    expect(folder).toMatchObject({ testEncode: false });
    const real = await queued({ path: file, force: true });
    expect(real).toMatchObject({ dryRun: false, testEncode: false });

    const refused = await queue({ path: file, dryRun: false, testEncode: true });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await json(refused))).toContain('only a dry run can test-encode');

    const plan = await createToken(t, s, { name: 'planner', scopes: ['plan'] });
    const planned = await queue({ path: file, dryRun: true, testEncode: true }, bearer(plan.token));
    expect(planned.status).toBe(200);
    expect(await json(planned)).toMatchObject({ testEncode: true });

    const jobId = single.jobIds[0] as string;
    expect(await json(await get(`/jobs/${jobId}`))).toMatchObject({ testEncode: true });
    expect(await json(await get(`/runs/${single.runId}`))).toMatchObject({
      run: { testEncode: true },
    });
    expect(await json(await get(`/runs/${folder.runId}`))).toMatchObject({
      run: { testEncode: false },
    });
    const listed = await json<{ jobs: { id: string; testEncode: boolean }[] }>(
      await get(`/jobs?runId=${off.runId}`),
    );
    expect(listed.jobs.map((j) => j.testEncode)).toEqual([false]);
  });

  it('jobs.get: testOutput and testOutputNote (null for a real job)', async () => {
    await fedLibrary();
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const file = join(root, 'a.mkv');
    const test = (await queued({ path: file, dryRun: true })).jobIds[0] as string;
    const zero = (await queued({ path: file, dryRun: true })).jobIds[0] as string;
    const real = (await queued({ path: file, force: true })).jobIds[0] as string;
    const out = join(base, 'out.mkv');
    await writeFile(out, Buffer.alloc(321, 1));
    await t.deps.engine.testOutputs.keep(test, out, 'mkv');
    setSetting(t.db, 'engine.testEncodeKeepHours', 0, t.clock.now());
    await writeFile(out, Buffer.alloc(321, 1));
    await t.deps.engine.testOutputs.keep(zero, out, 'mkv');

    expect(await json(await get(`/jobs/${test}`))).toMatchObject({
      testOutput: {
        container: 'mkv',
        sizeBytes: 321,
        keptUntil: new Date(t.clock.now().getTime() + 2 * 3_600_000).toISOString(),
      },
      testOutputNote: null,
    });
    expect(await json(await get(`/jobs/${zero}`))).toMatchObject({
      testOutput: null,
      testOutputNote: 'not kept: test encodes are kept for 0 hours',
    });
    expect(await json(await get(`/jobs/${real}`))).toMatchObject({
      testOutput: null,
      testOutputNote: null,
    });
  });

  it('jobs.get returns trace, result, probe, the per-stream plan and the pinned graph after the fake run finishes; jobs.list rows carry libraryName, workflowName, reason, result sizes and replacedTo, plus per-state counts; jobs.stats sums saved bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { wf, id: libraryId } = await fedLibrary({ notify: true });
    // Every event of the run, to check none carries the webhook URL.
    const abort = new AbortController();
    const stream = await t.app.request('/api/v1/events', {
      headers: { host: 'localhost:8080', accept: 'text/event-stream', ...asSession(s, false) },
      signal: abort.signal,
    });
    const streamed = readEvents(stream, (ev) =>
      ev.some((e) => e.type === 'job.changed' && (e as { state?: string }).state === 'done'),
    );
    const { runId, jobIds } = await queued({ path: join(root, 'a.mkv') });
    const id = jobIds[0] as string;
    await until('encoding', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('final', () => isFinal(id));
    expect(row(id).state).toBe('done');
    const events = await streamed;
    abort.abort();
    expect(events.some((e) => e.type === 'job.trace')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SECRET);

    const res = await get(`/jobs/${id}`);
    expect(res.status).toBe(200);
    const detail = await json<Record<string, unknown> & { graph: { nodes: { id: string }[] } }>(
      res,
    );
    expect(detail).toMatchObject({
      id,
      runId,
      state: 'done',
      fileName: 'a.mkv',
      libraryId,
      libraryName: 'TV',
      workflowId: wf,
      workflowVersion: 2,
      workflowName: 'Encode',
      reason: null,
      result: {
        outcome: 'done',
        beforeBytes: 1000,
        afterBytes: 600,
        replacedTo: 'recycle',
        sourceDamaged: false,
      },
      probe: { container: 'mkv', durationSeconds: 60 },
      plan: { rewrite: true, container: { from: 'mkv', to: 'mkv' } },
    });
    expect(detail).not.toHaveProperty('replaceJournal');
    expect(detail).not.toHaveProperty('fileId');
    expect(detail.probe).not.toHaveProperty('raw');
    expect((detail.plan as { streams: unknown[] }).streams).toHaveLength(2);
    expect(detail.graph.nodes.map((n) => n.id)).toEqual(['in', 'ev', 'ro', 'nw', 'render-1']);
    expect((detail.trace as { nodeId: string }[]).map((e) => e.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'ro',
      'nw',
      'render-1',
    ]);
    expect((detail.path as { nodeId: string }[]).map((e) => e.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'ro',
      'nw',
    ]);
    // The webhook URL may carry a token: the job API never shows it.
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(JSON.stringify(detail)).toContain('https://hooks.example/…');

    const list = await json<{ jobs: Record<string, unknown>[]; counts: Record<string, number> }>(
      await get(`/jobs?libraryId=${libraryId}`),
    );
    expect(list.jobs).toHaveLength(1);
    expect(list.jobs[0]).toMatchObject({
      id,
      libraryName: 'TV',
      workflowName: 'Encode',
      reason: null,
      result: {
        outcome: 'done',
        beforeBytes: 1000,
        afterBytes: 600,
        replacedTo: 'recycle',
        sourceDamaged: false,
      },
    });
    expect(list.jobs[0]).not.toHaveProperty('trace');
    expect(list.counts).toMatchObject({ done: 1, queued: 0, failed: 0 });
    expect(Object.keys(list.counts)).toHaveLength(15);
    const filtered = await json<{ jobs: unknown[]; counts: Record<string, number> }>(
      await get('/jobs?state=queued&state=failed'),
    );
    expect(filtered.jobs).toEqual([]);
    const single = await json<{ jobs: { id: string }[] }>(await get('/jobs?state=done'));
    expect(single.jobs.map((j) => j.id)).toEqual([id]);
    expect(filtered.counts.done).toBe(1);
    const page = await json<{ jobs: unknown[] }>(await get(`/jobs?before=${id}&limit=10`));
    expect(page.jobs).toEqual([]);

    const stats = await get(`/jobs/stats?since=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`);
    expect(await json(stats)).toEqual({
      files: 1,
      savedBytes: 400,
      failed: 0,
      queued: 0,
      running: 0,
      problems: 0,
    });
    expect((await get('/jobs/stats?since=yesterday')).status).toBe(400);

    expect(await json(await get(`/jobs/${id}/log`))).toEqual({ log: 'frame=1\n' });
    expect((await get('/jobs/nope')).status).toBe(404);
    expect((await get('/jobs/nope/log')).status).toBe(404);

    // Nor does any other jobs or runs answer.
    for (const path of [
      '/jobs',
      `/jobs?runId=${runId}`,
      `/jobs/${id}/log`,
      `/runs/${runId}`,
      '/runs',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(SECRET);
    }
  });

  it('pause/resume/cancel need jobs:manage; cancel of a final job → 409 JOB_NOT_ACTIVE', async () => {
    await fedLibrary();
    await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
    const { jobIds } = await queued({ path: join(root, 'a.mkv') });
    const id = jobIds[0] as string;

    const read = await createToken(t, s, { name: 'ro', scopes: ['read', 'jobs:create'] });
    for (const action of ['pause', 'resume', 'cancel']) {
      expect(
        (await send(t, 'POST', `/jobs/${id}/${action}`, { headers: bearer(read.token) })).status,
      ).toBe(403);
    }
    const manage = await createToken(t, s, { name: 'ops', scopes: ['jobs:manage'] });
    const as = bearer(manage.token);
    expect((await send(t, 'POST', `/jobs/${id}/pause`, { headers: as })).status).toBe(200);
    expect(row(id).paused).toBe(true);
    expect((await send(t, 'POST', `/jobs/${id}/resume`, { headers: as })).status).toBe(200);
    expect(row(id).paused).toBe(false);
    const again = await send(t, 'POST', `/jobs/${id}/resume`, { headers: as });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'JOB_NOT_ACTIVE' });
    expect((await send(t, 'POST', `/jobs/${id}/cancel`, { headers: as })).status).toBe(200);
    expect(row(id).state).toBe('cancelled');

    const final = await send(t, 'POST', `/jobs/${id}/cancel`, { headers: as });
    expect(final.status).toBe(409);
    expect(await json(final)).toMatchObject({ code: 'JOB_NOT_ACTIVE' });
    expect((await send(t, 'POST', '/jobs/nope/cancel', { headers: as })).status).toBe(404);
  });

  it("cancelAll needs jobs:manage and cancels a library's queued, ready, running and user-paused jobs (SIGKILL, temp removed); done, failed, cancelled and other libraries stay; no body means every library", async () => {
    const { id: libraryId } = await fedLibrary();
    for (const f of ['b', 'c', 'd', 'e', 'f', 'q']) {
      await writeFile(join(root, `${f}.mkv`), Buffer.alloc(1000, 7));
    }
    const films = join(base, 'films');
    await mkdir(films, { recursive: true });
    await writeFile(join(films, 'g.mkv'), Buffer.alloc(1000, 7));
    const filmsRes = await createLibrary({ name: 'Films', path: films });
    expect(filmsRes.status).toBe(200);
    const manual = encodeWorkflow();
    const session = asSession(s, true);

    // Final jobs and another library's queued (user-paused) job, set up while nothing starts.
    await send(t, 'POST', '/queue/pause', { headers: session });
    const one = async (path: string, workflowId?: string) =>
      (await queued({ path, ...(workflowId ? { workflowId } : {}) })).jobIds[0] as string;
    const done = await one(join(root, 'd.mkv'));
    const failed = await one(join(root, 'e.mkv'));
    const cancelled = await one(join(root, 'f.mkv'));
    const other = await one(join(films, 'g.mkv'), manual);
    const now = t.clock.now();
    updateJob(t.db, done, { state: 'done' }, now);
    updateJob(t.db, failed, { state: 'failed', reason: 'boom' }, now);
    updateJob(t.db, cancelled, { state: 'cancelled' }, now);
    expect((await send(t, 'POST', `/jobs/${other}/pause`, { headers: session })).status).toBe(200);
    await send(t, 'POST', '/queue/resume', { headers: session });

    // a: running, then user-paused (SIGSTOP, lane freed); b: running in its place; c: ready.
    const a = await one(join(root, 'a.mkv'));
    await until('a encoding', () => spawner.calls.length === 1);
    expect(existsSync(join(transcodeDir, a))).toBe(true);
    expect((await send(t, 'POST', `/jobs/${a}/pause`, { headers: session })).status).toBe(200);
    expect(spawner.signals).toEqual(['SIGSTOP']);
    const b = await one(join(root, 'b.mkv'));
    await until('b encoding', () => spawner.calls.length === 2);
    const c = await one(join(root, 'c.mkv'));
    await until('c ready', () => t.deps.engine.scheduler.status().ready.includes(c));
    // q: whatever phase it reaches; user-paused.
    const q = await one(join(root, 'q.mkv'));
    expect((await send(t, 'POST', `/jobs/${q}/pause`, { headers: session })).status).toBe(200);

    const read = await createToken(t, s, { name: 'ro', scopes: ['read', 'jobs:create'] });
    const refused = await send(t, 'POST', '/jobs/cancel-all', { headers: bearer(read.token) });
    expect(refused.status).toBe(403);
    expect(row(b).state).toBe('encoding');

    const manage = await createToken(t, s, { name: 'ops', scopes: ['jobs:manage'] });
    const as = bearer(manage.token);
    const none = await send(t, 'POST', '/jobs/cancel-all', {
      body: { libraryId: 'no-such-library' },
      headers: as,
    });
    expect(await json(none)).toEqual({ cancelled: 0, writing: 0, failed: 0 });

    const res = await send(t, 'POST', '/jobs/cancel-all', { body: { libraryId }, headers: as });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ cancelled: 4, writing: 0, failed: 0 });
    // Both ffmpeg processes, the user-paused one included, are killed through the single-cancel path.
    expect(spawner.signals.filter((x) => x === 'SIGKILL')).toHaveLength(2);
    await until('cancelled', () => [a, b, c, q].every((id) => row(id).state === 'cancelled'));
    await until('temp removed', () => [a, b, c].every((id) => !existsSync(join(transcodeDir, id))));
    expect(row(done).state).toBe('done');
    expect(row(failed).state).toBe('failed');
    expect(row(cancelled).state).toBe('cancelled');
    expect(row(other)).toMatchObject({ state: 'queued', paused: true });

    // No body at all: every library.
    const all = await send(t, 'POST', '/jobs/cancel-all', { headers: as });
    expect(all.status).toBe(200);
    expect(await json(all)).toEqual({ cancelled: 1, writing: 0, failed: 0 });
    expect(row(other).state).toBe('cancelled');
  });

  it('cancelAll counts a cancel already under way as nothing, a writing job as writing and a throwing cancel as failed (the rest still run); while stopping it is 409 JOB_NOT_ACTIVE', async () => {
    await fedLibrary();
    for (const f of ['b', 'c', 'd']) await writeFile(join(root, `${f}.mkv`), Buffer.alloc(1000, 7));
    await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
    const ids: string[] = [];
    for (const f of ['a', 'b', 'c', 'd']) {
      ids.push((await queued({ path: join(root, `${f}.mkv`) })).jobIds[0] as string);
    }
    const [already, writing, throws, real] = ids as [string, string, string, string];
    const { scheduler } = t.deps.engine;
    const original = scheduler.cancelJob.bind(scheduler);
    const spy = vi.spyOn(scheduler, 'cancelJob').mockImplementation((id, opts) => {
      if (id === already) return 'already';
      if (id === writing) return 'writing';
      if (id === throws) throw new Error('disk I/O error');
      return original(id, opts);
    });
    const as = asSession(s, true);
    const res = await send(t, 'POST', '/jobs/cancel-all', { headers: as });
    expect(await json(res)).toEqual({ cancelled: 1, writing: 1, failed: 1 });
    expect(spy).toHaveBeenCalledWith(real, { beforeWrite: true });
    expect(row(real).state).toBe('cancelled');
    expect(row(throws).state).toBe('queued');

    vi.spyOn(scheduler, 'isStopping', 'get').mockReturnValue(true);
    const stopping = await send(t, 'POST', '/jobs/cancel-all', { headers: as });
    expect(stopping.status).toBe(409);
    expect(await json(stopping)).toMatchObject({
      code: 'JOB_NOT_ACTIVE',
      message: 'The server is stopping; nothing was canceled',
    });
  });
});

describe('dry-run savings', () => {
  it('jobs.list, jobs.get and runs.get carry the estimate and a plan summary for dry runs only; no history means null, never a guess', async () => {
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    await fedLibrary();
    const b = join(root, 'Show', 'b.mkv');

    // No finished real run yet: the plan is known, the size is not (plan-only dry runs).
    const first = await queued({ path: b, dryRun: true, testEncode: false });
    await until('first dry run', () => isFinal(first.jobIds[0] as string));
    const early = await json<{ jobs: Record<string, unknown>[] }>(
      await get(`/jobs?runId=${first.runId}`),
    );
    expect(early.jobs[0]).toMatchObject({
      dryRun: true,
      state: 'dry_run',
      estimatedBytes: null,
      planSummary: 'convert 1 video track',
    });

    // One real run that shrinks 1000 to 600 gives the workflow a ratio of 0.6.
    const real = await queued({ path: join(root, 'a.mkv') });
    await until('encoding', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('real final', () => isFinal(real.jobIds[0] as string));
    expect(row(real.jobIds[0] as string).state).toBe('done');

    const second = await queued({ path: b, dryRun: true, testEncode: false, force: true });
    const dryId = second.jobIds[0] as string;
    await until('second dry run', () => isFinal(dryId));
    const list = await json<{ jobs: Record<string, unknown>[] }>(await get('/jobs'));
    expect(list.jobs.find((j) => j.id === dryId)).toMatchObject({
      dryRun: true,
      estimatedBytes: 600,
      planSummary: 'convert 1 video track',
      result: { beforeBytes: 1000, afterBytes: null },
    });
    // The real job's row never claims an estimate.
    expect(list.jobs.find((j) => j.id === real.jobIds[0])).toMatchObject({
      dryRun: false,
      estimatedBytes: null,
      planSummary: null,
    });
    expect(await json(await get(`/jobs/${dryId}`))).toMatchObject({
      estimatedBytes: 600,
      planSummary: 'convert 1 video track',
    });

    const dryRun = await json<{ files: Record<string, unknown>[] }>(
      await get(`/runs/${second.runId}`),
    );
    expect(dryRun.files[0]).toMatchObject({
      state: 'dry_run',
      beforeBytes: 1000,
      afterBytes: null,
      estimatedBytes: 600,
      planSummary: 'convert 1 video track',
    });
    const realRun = await json<{ files: Record<string, unknown>[] }>(
      await get(`/runs/${real.runId}`),
    );
    expect(realRun.files[0]).toMatchObject({ estimatedBytes: null, planSummary: null });
  });
});

it('a job that failed before any result reads with result and plan null', async () => {
  await fedLibrary();
  await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
  const { jobIds } = await queued({ path: join(root, 'a.mkv') });
  const id = jobIds[0] as string;
  updateJob(t.db, id, { state: 'failed', reason: 'boom' }, t.clock.now());
  const detail = await json(await get(`/jobs/${id}`));
  expect(detail).toMatchObject({ state: 'failed', reason: 'boom', result: null, plan: null });
});
