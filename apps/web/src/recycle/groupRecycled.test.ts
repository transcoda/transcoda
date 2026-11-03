import type { RecycledEntry } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { groupRecycled } from './groupRecycled.ts';

const e = (path: string, kind: RecycledEntry['kind'], jobId: string): RecycledEntry => ({
  path,
  relativePath: path,
  kind,
  sizeBytes: 1,
  jobId,
  recycledAt: '2026-11-01T00:00:00.000Z',
  deletesAt: '2026-11-08T00:00:00.000Z',
});

describe('groupRecycled', () => {
  it("puts a sidecar under its job's original and keeps an orphan sidecar on its own", () => {
    const a = e('a.mkv', 'original', 'j1');
    const aSrt = e('a.de.srt', 'sidecar', 'j1');
    const orphan = e('b.en.srt', 'sidecar', 'j2');
    const out = e('c.mkv.1', 'restored-output', 'j3');
    const aSrt2 = e('a.en.srt', 'sidecar', 'j1');
    expect(groupRecycled([aSrt, a, orphan, out, aSrt2])).toEqual([
      { entry: a, sidecars: [aSrt, aSrt2] },
      { entry: orphan, sidecars: [] },
      { entry: out, sidecars: [] },
    ]);
  });

  it('a sidecar of a job whose original is a restored output stays on its own', () => {
    const out = e('c.mkv.1', 'restored-output', 'j3');
    const srt = e('c.de.srt', 'sidecar', 'j3');
    expect(groupRecycled([out, srt])).toEqual([
      { entry: out, sidecars: [] },
      { entry: srt, sidecars: [] },
    ]);
  });
});
