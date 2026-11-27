import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import { asSession, login, type Session, send } from '../../app/testing/http.ts';
import { insertJob } from '../../db/repos/jobs/jobs.ts';
import { insertLibrary } from '../../db/repos/libraries.ts';
import { insertRun } from '../../db/repos/runs.ts';
import { insertWorkflow } from '../../db/repos/workflows.ts';

const now = new Date('2026-10-26T00:04:00.000Z');

let t: TestApp;
let s: Session;
beforeEach(async () => {
  t = createTestApp({ start: now });
  s = await login(t);
  insertWorkflow(
    t.db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  insertLibrary(
    t.db,
    { id: 'l1', name: 'TV', path: '/media/tv', recycleFolder: null, processHardlinked: false },
    now,
  );
  insertRun(
    t.db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/media/tv',
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
});
afterEach(async () => {
  await t.close();
});

const media = (posterPath: string | null) => ({
  kind: 'movie' as const,
  title: 'The Gardener',
  year: 1926,
  season: null,
  episode: null,
  episodeTitle: null,
  source: 'sidecar' as const,
  posterPath,
});

function add(id: string, posterPath: string | null | undefined): void {
  insertJob(
    t.db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: `/media/tv/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'queued',
      priority: 0,
      ...(posterPath === undefined ? {} : { media: media(posterPath) }),
    },
    now,
  );
}

describe('job media over RPC', () => {
  it('jobs.list and jobs.get return media with poster, never posterPath', async () => {
    add('with', '/media/tv/poster.jpg');
    add('without', null);
    add('plain', undefined);
    const list = (await (
      await send(t, 'GET', '/jobs', { headers: asSession(s, false) })
    ).json()) as {
      jobs: { id: string; media: Record<string, unknown> }[];
    };
    const by = Object.fromEntries(list.jobs.map((j) => [j.id, j.media]));
    const expected = {
      kind: 'movie',
      title: 'The Gardener',
      year: 1926,
      season: null,
      episode: null,
      episodeTitle: null,
      source: 'sidecar',
    };
    expect(by.with).toEqual({ ...expected, poster: true });
    expect(by.without).toEqual({ ...expected, poster: false });
    expect(by.plain).toMatchObject({
      kind: 'unknown',
      title: 'plain',
      source: 'filename',
      poster: false,
    });
    for (const m of Object.values(by)) expect(m).not.toHaveProperty('posterPath');

    const res = await send(t, 'GET', '/jobs/with', { headers: asSession(s, false) });
    const one = (await res.json()) as { media: Record<string, unknown> };
    expect(one.media).toEqual({ ...expected, poster: true });
    expect(JSON.stringify(one)).not.toContain('posterPath');
  });
});
