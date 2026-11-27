// Property test (fast-check) for the content hash's sampled chunks: every read lies inside the file,
// a small file is read whole, and a large one at its start, middle and end.
import { fcRuns } from '@transcoda/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunkOffsets } from './content-hash.ts';

const RUNS = fcRuns();

describe('chunkOffsets (property)', () => {
  it('reads inside the file: all of a small one, start, middle and end of a large one', () => {
    const sizes = fc.oneof(fc.nat(200), fc.nat(), fc.maxSafeNat());
    fc.assert(
      fc.property(sizes, fc.integer({ min: 1, max: 64 * 1024 * 1024 }), (size, chunk) => {
        const reads = chunkOffsets(size, chunk);
        for (const r of reads) {
          expect(r.offset).toBeGreaterThanOrEqual(0);
          expect(r.length).toBeGreaterThan(0);
          expect(r.length).toBeLessThanOrEqual(chunk);
          expect(r.offset + r.length).toBeLessThanOrEqual(size);
        }
        if (size <= 3 * chunk) {
          // Back to back from 0 to the end: every byte once.
          let next = 0;
          for (const r of reads) {
            expect(r.offset).toBe(next);
            next += r.length;
          }
          expect(next).toBe(size);
        } else {
          expect(reads.map((r) => r.length)).toEqual([chunk, chunk, chunk]);
          expect(reads[0]?.offset).toBe(0);
          expect(reads[2]?.offset).toBe(size - chunk);
        }
      }),
      RUNS,
    );
  });
});
