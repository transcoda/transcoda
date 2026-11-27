import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import { updateJob } from './jobs.ts';
import { findJobListRow } from './list.ts';
import { findJobResult, insertJobResult, recentRatios } from './results.ts';
import { at, insertTestJob, now, result, seededDb } from './testing.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('source damaged results', () => {
  it('a result stores and reads back sourceDamaged, on the result and the list row', () => {
    job('dmg');
    updateJob(db, 'dmg', { state: 'kept_original', finishedAt: at(1).toISOString() }, at(1));
    insertJobResult(
      db,
      result('dmg', {
        outcome: 'kept_original',
        afterBytes: null,
        replacedTo: null,
        sourceDamaged: true,
      }),
    );
    job('ok');
    insertJobResult(db, result('ok'));
    expect(findJobResult(db, 'dmg')?.sourceDamaged).toBe(true);
    expect(findJobResult(db, 'ok')?.sourceDamaged).toBe(false);
    expect(findJobListRow(db, 'dmg')?.result).toMatchObject({
      outcome: 'kept_original',
      sourceDamaged: true,
    });
    expect(findJobListRow(db, 'ok')?.result?.sourceDamaged).toBe(false);
  });
});

describe('results', () => {
  it('findJobResult reads a result; recentRatios uses done results only', () => {
    job('a');
    job('b');
    job('c');
    insertJobResult(db, result('a', { outcome: 'failed', createdAt: at(1).toISOString() }));
    const nodeProblems = [
      {
        workflowPath: [],
        nodeId: 'nw',
        severity: 'warning' as const,
        message: 'notify https://hooks.example/… failed: fetch failed',
      },
    ];
    insertJobResult(
      db,
      result('b', { outcome: 'done', createdAt: at(2).toISOString(), nodeProblems }),
    );
    insertJobResult(db, result('c', { outcome: 'dry_run', createdAt: at(3).toISOString() }));
    expect(findJobResult(db, 'b')).toEqual(
      result('b', { createdAt: at(2).toISOString(), nodeProblems }),
    );
    expect(recentRatios(db, 'w1', 20)).toEqual([0.6]);
  });
});
