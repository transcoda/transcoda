import type { TraceEntry } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import { insertTestJob, now, seededDb } from './testing.ts';
import { appendTrace, listTrace, nextTraceSeq } from './trace.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('trace', () => {
  it('appendTrace stores each entry at its own seq; listTrace returns them in seq order', () => {
    job('a');
    const entry = (nodeId: string, seq: number): TraceEntry => ({
      seq,
      attempt: 1,
      nodeId,
      workflowPath: [],
      phase: 'decide',
      port: 'yes',
      reason: 'why',
      findings: { language: 'jpn' },
      startedAt: now.toISOString(),
      endedAt: now.toISOString(),
    });
    expect(nextTraceSeq(db, 'a')).toBe(1);
    expect(appendTrace(db, 'a', entry('n2', 2))).toBe(2);
    expect(appendTrace(db, 'a', entry('n1', 1))).toBe(1);
    expect(listTrace(db, 'a').map((e) => e.nodeId)).toEqual(['n1', 'n2']);
    expect(nextTraceSeq(db, 'a')).toBe(3);
    expect(() => appendTrace(db, 'a', entry('dup', 2))).toThrow();
  });
});
