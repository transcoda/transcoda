import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSession, bearer, createToken, send } from '../../app/testing/http.ts';
import { updateJob } from '../../db/repos/jobs/jobs.ts';
import {
  fedLibrary,
  finishEncode,
  get,
  isFinal,
  json,
  queued,
  root,
  row,
  s,
  spawner,
  t,
  until,
  useRpcApp,
} from './testing.ts';

useRpcApp();

describe('runs', () => {
  it('problems: jobs.list filters and counts jobs with problems whatever the state filter, jobs.get carries them, jobs.stats counts them', async () => {
    await fedLibrary();
    await writeFile(join(root, 'b.mkv'), Buffer.alloc(1000, 7));
    const a = (await queued({ path: join(root, 'a.mkv') })).jobIds[0] as string;
    await until('first encode', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('first final', () => isFinal(a));
    const b = (await queued({ path: join(root, 'b.mkv') })).jobIds[0] as string;
    await until('second encode', () => spawner.calls.length === 2);
    await finishEncode(600);
    await until('second final', () => isFinal(b));
    t.db
      .prepare('UPDATE job_results SET problems_json = ? WHERE job_id = ?')
      .run(JSON.stringify(['finished with a problem: room b did not answer']), b);

    const only = await json<{
      jobs: { id: string; problems: string[] }[];
      problemCount: number;
      counts: Record<string, number>;
    }>(await get('/jobs?problems=true'));
    expect(only.jobs.map((j) => j.id)).toEqual([b]);
    expect(only.jobs[0]?.problems).toEqual(['finished with a problem: room b did not answer']);
    expect(only.problemCount).toBe(1);
    expect(only.counts.done).toBe(2);
    const all = await json<{ jobs: { id: string; problems: string[] }[]; problemCount: number }>(
      await get('/jobs'),
    );
    expect(all.jobs).toHaveLength(2);
    expect(all.jobs.find((j) => j.id === a)?.problems).toEqual([]);
    // The state filter does not change the count.
    const queuedOnly = await json<{ jobs: unknown[]; problemCount: number }>(
      await get('/jobs?state=queued'),
    );
    expect(queuedOnly).toMatchObject({ jobs: [], problemCount: 1 });

    const detail = await json<{ problems: string[]; result: { problems: string[] } }>(
      await get(`/jobs/${b}`),
    );
    expect(detail.problems).toEqual(['finished with a problem: room b did not answer']);
    expect(detail.result.problems).toEqual(detail.problems);
    const stats = await json<{ problems: number; files: number }>(
      await get(`/jobs/stats?since=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`),
    );
    expect(stats).toMatchObject({ files: 2, problems: 1 });
  });

  it('runs.get counts reconcile: total === sum of outcome counts + in_progress; its jobs list carries result sizes', async () => {
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    await fedLibrary();
    const { runId, jobIds } = await queued({ path: root });
    expect(jobIds).toHaveLength(2);
    await until('first encode', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('second encode', () => spawner.calls.length === 2);
    const second = jobIds.find((j) => row(j).state === 'encoding') as string;
    expect(
      (await send(t, 'POST', `/jobs/${second}/cancel`, { headers: asSession(s, true) })).status,
    ).toBe(200);
    await until('both final', () => jobIds.every(isFinal));

    const detail = await json<{
      run: { id: string; note: string | null };
      workflowName: string;
      libraryName: string;
      counts: Record<string, number>;
      files: Record<string, unknown>[];
    }>(await get(`/runs/${runId}`));
    expect(detail).toMatchObject({ run: { id: runId }, workflowName: 'Encode', libraryName: 'TV' });
    const { counts } = detail;
    const outcomes = [
      'done',
      'nothing_to_do',
      'kept_original',
      'failed',
      'cancelled',
      'dry_run',
      'skipped',
      'already_processed',
    ];
    expect(counts.total).toBe(2);
    expect(
      outcomes.reduce((n, k) => n + (counts[k] ?? 0), 0) +
        (counts.queued ?? 0) +
        (counts.in_progress ?? 0),
    ).toBe(counts.total);
    expect(counts).toMatchObject({ done: 1, cancelled: 1, queued: 0, in_progress: 0 });
    expect(detail.files).toHaveLength(2);
    expect(detail.run).toMatchObject({ note: null });
    expect(detail.files.map((f) => f.workflowVersion)).toEqual([2, 2]);
    // Both files prepare at once, so either may take the encode lane first.
    expect(detail.files.find((f) => f.state === 'done')).toMatchObject({
      fileName: expect.stringMatching(/^[ab]\.mkv$/),
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: 'recycle',
    });

    const list = await json<{ runs: { run: { id: string } }[] }>(await get('/runs?limit=5'));
    expect(list.runs.map((r) => r.run.id)).toEqual([runId]);
    expect(list.runs[0]).not.toHaveProperty('files');
    expect((await get('/runs/nope')).status).toBe(404);
  });

  it("runs.processAgain (a person's session only): queues the run's already-processed files with force as a new run, leaves the rest; a dry run plans the run's version; nothing to process or no run is 404; any token is 403", async () => {
    const b = join(root, 'Show', 'b.mkv');
    await writeFile(b, Buffer.alloc(1000, 7));
    await fedLibrary();
    // Nothing starts while the queue is paused, so the jobs stay where the test puts them.
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const { runId, jobIds } = await queued({ path: root });
    expect(jobIds).toHaveLength(2);
    const seen = jobIds.find((j) => row(j).path === b) as string;
    updateJob(t.db, seen, { state: 'already_processed', reason: 'already done' }, new Date());

    const again = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
      send(t, 'POST', `/runs/${runId}/process-again`, { body, headers });

    const all = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const token = await again(bearer(all.token));
    expect(token.status).toBe(403);
    expect(await json(token)).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Process again is a UI action',
    });
    expect((await again({})).status).toBe(401);
    expect((await again(asSession(s, false))).status).toBe(403);

    const res = await again(asSession(s, true));
    expect(res.status).toBe(200);
    const out = await json<{ runId: string; jobIds: string[]; dryRun: boolean }>(res);
    expect(out).toMatchObject({ dryRun: false, workflowVersion: 2, testEncode: false });
    expect(out.runId).not.toBe(runId);
    expect(out.jobIds).toHaveLength(1);
    expect(row(out.jobIds[0] as string)).toMatchObject({
      runId: out.runId,
      path: b,
      state: 'queued',
    });
    expect(await json(await get(`/runs/${out.runId}`))).toMatchObject({
      run: { force: true, dryRun: false, requestedPath: root },
      counts: { total: 1, queued: 1 },
    });

    const dry = await json<{ jobIds: string[]; dryRun: boolean; workflowVersion: number }>(
      await again(asSession(s, true), { dryRun: true }),
    );
    expect(dry).toMatchObject({ dryRun: true, workflowVersion: 2 });
    expect(dry.jobIds).toHaveLength(1);

    // The new run has no already-processed file; an unknown run is 404 too.
    const none = await send(t, 'POST', `/runs/${out.runId}/process-again`, {
      body: {},
      headers: asSession(s, true),
    });
    expect(none.status).toBe(404);
    expect(await json(none)).toMatchObject({ message: 'This run has no already-processed files' });
    const missing = await send(t, 'POST', '/runs/nope/process-again', {
      body: {},
      headers: asSession(s, true),
    });
    expect(missing.status).toBe(404);
  });
});
