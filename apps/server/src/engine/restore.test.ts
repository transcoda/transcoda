import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import {
  alreadyProcessedReason,
  findJob,
  findPriorRun,
  findRecycled,
  insertJob,
  insertJobResult,
  insertRecycled,
  type JobResultRow,
  listRecycled,
  updateJob,
} from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { findActiveRestore } from '../db/repos/restores.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { fingerprintKey, fingerprintOf } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';
import { failingAt, nodeFsOps } from './fs-ops.ts';
import { type RestoreDeps, recycleFolderOf, restoreRecycled } from './restore.ts';

const now = new Date('2026-03-01T12:00:00.000Z');

let tmp: string;
let root: string;
let bin: string;
let db: Database;
let logged: unknown[];
let deps: RestoreDeps;
const input = (): { path: string; userId: string } => ({ path: `${bin}/Show/a.mkv`, userId: 'u1' });

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );
const size = async (p: string): Promise<number> => (await stat(p)).size;
const key = async (p: string): Promise<string> => fingerprintKey(await fingerprintOf(p));

function result(extra: Partial<JobResultRow> = {}): JobResultRow {
  return {
    jobId: 'j1',
    fingerprint: 'k',
    workflowId: 'w1',
    workflowVersion: 1,
    outcome: 'done',
    beforeBytes: 1000,
    afterBytes: 300,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    outputFingerprint: null,
    sourceHash: null,
    outputHash: null,
    createdAt: now.toISOString(),
    ...extra,
  };
}

function job(id: string, state: 'done' | 'queued', path: string): void {
  insertJob(
    db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state,
      priority: 0,
    },
    now,
  );
}

async function setup(opts: { outputFingerprint?: boolean } = {}): Promise<void> {
  tmp = await tempDir('restore-');
  root = join(tmp, 'lib');
  bin = join(root, '.transcoda-recycle');
  await mkdir(join(root, 'Show'), { recursive: true });
  await mkdir(join(bin, 'Show'), { recursive: true });
  await writeFile(join(root, 'Show', 'a.mkv'), randomBytes(300));
  await writeFile(join(bin, 'Show', 'a.mkv'), randomBytes(1000));
  await writeFile(join(bin, 'Show', 'a.de.srt'), 'subs');
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  insertLibrary(
    db,
    { id: 'l1', name: 'TV', path: root, recycleFolder: null, processHardlinked: false },
    now,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: root,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
  job('j1', 'done', join(root, 'Show', 'a.mkv'));
  insertJobResult(
    db,
    result({
      fingerprint: await key(join(bin, 'Show', 'a.mkv')),
      outputFingerprint:
        opts.outputFingerprint === false ? null : await key(join(root, 'Show', 'a.mkv')),
    }),
  );
  insertRecycled(db, {
    path: join(bin, 'Show', 'a.mkv'),
    libraryId: 'l1',
    jobId: 'j1',
    sizeBytes: 1000,
    recycledAt: now.toISOString(),
    kind: 'original',
    originalPath: join(root, 'Show', 'a.mkv'),
  });
  insertRecycled(db, {
    path: join(bin, 'Show', 'a.de.srt'),
    libraryId: 'l1',
    jobId: 'j1',
    sizeBytes: 4,
    recycledAt: now.toISOString(),
    kind: 'sidecar',
    originalPath: join(root, 'Show', 'a.de.srt'),
  });
  logged = [];
  const log: Logger = { info: () => {}, warn: (e) => logged.push(e), error: (e) => logged.push(e) };
  deps = { db, fs: nodeFsOps, now: () => now, log };
}

afterEach(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('restoreRecycled', () => {
  beforeEach(() => setup());

  it('restores the original and its sidecar, recycles the output, records the restore', async () => {
    const r = await restoreRecycled(deps, input());
    expect(r).toEqual({
      kind: 'restored',
      jobId: 'j1',
      restoreId: expect.any(String),
      notRestored: [],
    });
    expect(await size(`${root}/Show/a.mkv`)).toBe(1000);
    expect(await exists(`${root}/Show/a.de.srt`)).toBe(true);
    expect(listRecycled(db, 'l1')).toEqual([
      expect.objectContaining({
        path: `${bin}/Show/a.mkv.1`,
        kind: 'restored-output',
        sizeBytes: 300,
        originalPath: `${root}/Show/a.mkv`,
        restoreId: (r as { restoreId: string }).restoreId,
      }),
    ]);
    expect(findActiveRestore(db, 'j1')).toMatchObject({
      restoredBy: 'u1',
      sidecarPaths: [`${root}/Show/a.de.srt`],
    });
    expect(findJob(db, 'j1')?.restoreJournal).toBeNull();
  });

  it('the restored file is already_processed for every version of the workflow', async () => {
    await restoreRecycled(deps, input());
    const prior = findPriorRun(db, await key(`${root}/Show/a.mkv`), 'w1', 2);
    expect(prior).toMatchObject({ outcome: 'done', workflowVersion: 1 });
    if (prior === null) throw new Error('no prior run');
    expect(alreadyProcessedReason(prior)).toMatch(/^already done by v1 on /);
  });

  it('undo puts the output back and recycles the original and the sidecars again', async () => {
    await restoreRecycled(deps, input());
    const r = await restoreRecycled(deps, { path: `${bin}/Show/a.mkv.1`, userId: 'u2' });
    expect(r).toEqual({
      kind: 'undone',
      jobId: 'j1',
      restoreId: expect.any(String),
      notRestored: [],
    });
    expect(await size(`${root}/Show/a.mkv`)).toBe(300);
    expect(await exists(`${root}/Show/a.de.srt`)).toBe(false);
    expect(listRecycled(db, 'l1')).toEqual([
      expect.objectContaining({ path: `${bin}/Show/a.mkv`, kind: 'original', sizeBytes: 1000 }),
      expect.objectContaining({
        path: `${bin}/Show/a.de.srt`,
        kind: 'sidecar',
        originalPath: `${root}/Show/a.de.srt`,
      }),
    ]);
    expect(findActiveRestore(db, 'j1')).toBeNull();
    expect(findJob(db, 'j1')?.restoreJournal).toBeNull();
  });

  it('undo leaves a subtitle file that changed since the restore where it is and says so', async () => {
    await restoreRecycled(deps, input());
    await writeFile(`${root}/Show/a.de.srt`, 'edited subs');
    const r = await restoreRecycled(deps, { path: `${bin}/Show/a.mkv.1`, userId: 'u2' });
    expect(r).toMatchObject({
      kind: 'undone',
      notRestored: ['a.de.srt (changed since the restore, left in place)'],
    });
    expect(await size(`${root}/Show/a.de.srt`)).toBe(11);
    expect(findRecycled(db, `${bin}/Show/a.de.srt`)).toBeNull();
  });

  it('refuses when the file at the path is not the output', async () => {
    await writeFile(`${root}/Show/a.mkv`, randomBytes(500));
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason:
        "The file at this path isn't the one the job wrote (another program changed or moved it), so restoring could lose that change.",
    });
  });

  it('refuses and drops the row when the original is gone from the recycle folder', async () => {
    await unlink(`${bin}/Show/a.mkv`);
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason: 'The original is no longer in the recycle folder (removed by hand).',
    });
    expect(findRecycled(db, `${bin}/Show/a.mkv`)).toBeNull();
  });

  it('a missing original past its cleanup date names that date', async () => {
    await unlink(`${bin}/Show/a.mkv`);
    const later = { ...deps, retentionDays: 7, now: () => new Date('2026-03-09T12:00:00.000Z') };
    expect(await restoreRecycled(later, input())).toEqual({
      kind: 'refused',
      reason: 'The original is no longer in the recycle folder (removed on 2026-03-08 or by hand).',
    });
  });

  it('a file set aside by a restore that stopped part-way has no restore to undo, and says so', async () => {
    await writeFile(`${bin}/Show/a.mkv.1`, randomBytes(300));
    insertRecycled(db, {
      path: `${bin}/Show/a.mkv.1`,
      libraryId: 'l1',
      jobId: 'j1',
      sizeBytes: 300,
      recycledAt: now.toISOString(),
      kind: 'restored-output',
      originalPath: `${root}/Show/a.mkv`,
      restoreId: null,
    });
    expect(await restoreRecycled(deps, { path: `${bin}/Show/a.mkv.1`, userId: 'u1' })).toEqual({
      kind: 'refused',
      reason:
        "This file was set aside when a restore stopped part-way, so there's no restore to undo. Move it back by hand or delete it.",
    });
  });

  it('refuses when the recycled copy has another size', async () => {
    await writeFile(`${bin}/Show/a.mkv`, randomBytes(999));
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason: 'The file in the recycle folder is not the original any more (its size changed).',
    });
  });

  it('refuses a sidecar row, a job that is not done, and a job with a replace journal', async () => {
    expect(await restoreRecycled(deps, { path: `${bin}/Show/a.de.srt`, userId: 'u1' })).toEqual({
      kind: 'refused',
      reason: "A subtitle file comes back with its video's original; restore that instead.",
    });
    const running = { kind: 'refused', reason: 'This job is still running or replacing its file.' };
    updateJob(
      db,
      'j1',
      {
        replaceJournal: {
          step: 'cleaning',
          originalPath: `${root}/Show/a.mkv`,
          tmpPath: 'x',
          outputPath: 'o',
          copyPath: 'y',
          libraryRoot: root,
          recycling: true,
          fingerprint: { sizeBytes: 1, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 },
          outputBytes: 1,
        },
      },
      now,
    );
    expect(await restoreRecycled(deps, input())).toEqual(running);
    updateJob(db, 'j1', { replaceJournal: null, state: 'encoding' }, now);
    expect(await restoreRecycled(deps, input())).toEqual(running);
  });

  it('refuses a library that deletes originals', async () => {
    db.prepare("UPDATE job_results SET replaced_to = 'deleted'").run();
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason:
        "This library deletes originals instead of recycling them, so there's nothing to restore.",
    });
  });

  it('an unknown path is not-found', async () => {
    expect(await restoreRecycled(deps, { path: `${bin}/nope.mkv`, userId: 'u1' })).toEqual({
      kind: 'not-found',
    });
  });

  it('a sidecar whose path is taken is listed, the restore goes ahead', async () => {
    await writeFile(`${root}/Show/a.de.srt`, 'mine');
    const r = await restoreRecycled(deps, input());
    expect(r).toMatchObject({ kind: 'restored', notRestored: ['a.de.srt (its place is taken)'] });
    expect(findRecycled(db, `${bin}/Show/a.de.srt`)).not.toBeNull();
    expect(findActiveRestore(db, 'j1')?.sidecarPaths).toEqual([]);
  });

  it('a sidecar that is gone from the recycle folder is listed, the restore goes ahead', async () => {
    await unlink(`${bin}/Show/a.de.srt`);
    const r = await restoreRecycled(deps, input());
    expect(r).toMatchObject({
      kind: 'restored',
      notRestored: ['a.de.srt (gone from the recycle folder)'],
    });
  });

  it('a failed move rolls back every move before it', async () => {
    const fs = failingAt(nodeFsOps, 'link', 2, Object.assign(new Error('io'), { code: 'EIO' }));
    const rowsBefore = listRecycled(db, 'l1');
    expect(await restoreRecycled({ ...deps, fs }, input())).toEqual({
      kind: 'failed',
      reason: 'Restoring failed and nothing was changed: EIO',
    });
    expect(await size(`${root}/Show/a.mkv`)).toBe(300);
    expect(await size(`${bin}/Show/a.mkv`)).toBe(1000);
    expect(await exists(`${bin}/Show/a.mkv.1`)).toBe(false);
    expect(listRecycled(db, 'l1')).toEqual(rowsBefore);
    expect(findJob(db, 'j1')?.restoreJournal).toBeNull();
    expect(findActiveRestore(db, 'j1')).toBeNull();
  });

  it('another program writing the file between the moves: the restore stops, keeps both files and never wedges the job', async () => {
    const foreign = randomBytes(77);
    const fs = {
      ...nodeFsOps,
      unlink: async (p: string) => {
        await nodeFsOps.unlink(p);
        if (p === `${root}/Show/a.mkv`) await writeFile(p, foreign);
      },
    };
    const r = await restoreRecycled({ ...deps, fs }, input());
    expect(r).toEqual({
      kind: 'failed',
      reason:
        'Restoring stopped because another program wrote to the same place meanwhile. Nothing was lost; the recycle folder holds both versions.',
    });
    expect(await size(`${root}/Show/a.mkv`)).toBe(77);
    expect(await size(`${bin}/Show/a.mkv`)).toBe(1000);
    expect(await size(`${bin}/Show/a.mkv.1`)).toBe(300);
    expect(findJob(db, 'j1')?.restoreJournal).toBeNull();
    expect(findRecycled(db, `${bin}/Show/a.mkv.1`)).toMatchObject({
      kind: 'restored-output',
      sizeBytes: 300,
      originalPath: `${root}/Show/a.mkv`,
      restoreId: null,
    });
    expect(findRecycled(db, `${bin}/Show/a.mkv`)).not.toBeNull();
    expect(findActiveRestore(db, 'j1')).toBeNull();
  });

  it('a file appearing at the recycle name before the first move: nothing moved, the stranger is left alone', async () => {
    let made = false;
    const fs = {
      ...nodeFsOps,
      link: async (a: string, b: string) => {
        if (!made && b === `${bin}/Show/a.mkv.1`) {
          made = true;
          await writeFile(b, 'stranger');
        }
        await nodeFsOps.link(a, b);
      },
    };
    const r = await restoreRecycled({ ...deps, fs }, input());
    expect(r).toMatchObject({ kind: 'failed' });
    expect((r as { reason: string }).reason).toMatch(/^Restoring failed and nothing was changed/);
    expect(await size(`${root}/Show/a.mkv`)).toBe(300);
    expect(await size(`${bin}/Show/a.mkv.1`)).toBe(8);
    expect(findRecycled(db, `${bin}/Show/a.mkv.1`)).toBeNull();
    expect(findJob(db, 'j1')?.restoreJournal).toBeNull();
  });

  // Review Focus 1
  it('two restores of one job at once: one wins, the other is refused', async () => {
    const [a, b] = await Promise.all([
      restoreRecycled(deps, input()),
      restoreRecycled(deps, input()),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['refused', 'restored']);
    expect(await size(`${root}/Show/a.mkv`)).toBe(1000);
    expect(listRecycled(db, 'l1').map((r) => r.kind)).toEqual(['restored-output']);
  });

  // Review Focus 2
  it('refuses while a job for the same path is queued or running', async () => {
    job('j2', 'queued', `${root}/Show/a.mkv`);
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason: 'A job for this file is queued or running; restore it once that job ends.',
    });
  });

  // Review Focus 3
  it('an unreachable library refuses and keeps the row', async () => {
    await rm(join(root, 'Show'), { recursive: true });
    await rm(bin, { recursive: true });
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason: "The library's folder can't be reached (is the share mounted?).",
    });
    expect(findRecycled(db, `${bin}/Show/a.mkv`)).not.toBeNull();
  });

  // Review Focus 4
  it('restore, undo, restore again never clobbers', async () => {
    const outIno = (await stat(`${root}/Show/a.mkv`)).ino;
    const origIno = (await stat(`${bin}/Show/a.mkv`)).ino;

    expect(await restoreRecycled(deps, input())).toMatchObject({ kind: 'restored' });
    expect(await size(`${root}/Show/a.mkv`)).toBe(1000);
    expect(await size(`${bin}/Show/a.mkv.1`)).toBe(300);
    expect(await exists(`${bin}/Show/a.mkv`)).toBe(false);
    expect((await stat(`${root}/Show/a.mkv`)).ino).toBe(origIno);
    expect((await stat(`${bin}/Show/a.mkv.1`)).ino).toBe(outIno);

    expect(
      await restoreRecycled(deps, { path: `${bin}/Show/a.mkv.1`, userId: 'u1' }),
    ).toMatchObject({ kind: 'undone' });
    expect(await size(`${root}/Show/a.mkv`)).toBe(300);
    expect(await size(`${bin}/Show/a.mkv`)).toBe(1000);
    expect(await exists(`${bin}/Show/a.mkv.1`)).toBe(false);
    expect((await stat(`${root}/Show/a.mkv`)).ino).toBe(outIno);
    expect((await stat(`${bin}/Show/a.mkv`)).ino).toBe(origIno);

    expect(await restoreRecycled(deps, input())).toMatchObject({ kind: 'restored' });
    expect(await size(`${root}/Show/a.mkv`)).toBe(1000);
    expect(await size(`${bin}/Show/a.mkv.1`)).toBe(300);
    expect((await stat(`${root}/Show/a.mkv`)).ino).toBe(origIno);
    expect((await stat(`${bin}/Show/a.mkv.1`)).ino).toBe(outIno);
  });

  it('an undo after the restored file changed is refused', async () => {
    await restoreRecycled(deps, input());
    await writeFile(`${root}/Show/a.mkv`, randomBytes(1000));
    expect(await restoreRecycled(deps, { path: `${bin}/Show/a.mkv.1`, userId: 'u1' })).toEqual({
      kind: 'refused',
      reason:
        "This file changed after the restore (another program wrote it), so putting Transcoda's version back could lose that change.",
    });
  });
});

describe('restoreRecycled without an output fingerprint', () => {
  beforeEach(() => setup({ outputFingerprint: false }));

  it('refuses a job without an output fingerprint', async () => {
    expect(await restoreRecycled(deps, input())).toEqual({
      kind: 'refused',
      reason:
        "Transcoda can't tell whether the file at this path is still its output, so it won't replace it.",
    });
  });
});

describe('recycleFolderOf', () => {
  it('strips the library-relative path and any .N', () => {
    expect(recycleFolderOf('/m/.r/Show/a.mkv.2', '/m', '/m/Show/a.mkv')).toBe('/m/.r');
    expect(recycleFolderOf('/m/.r/Show/a.mkv', '/m', '/m/Show/a.mkv')).toBe('/m/.r');
    expect(recycleFolderOf('/m/.r/Other/a.mkv', '/m', '/m/Show/a.mkv')).toBeNull();
  });
});
