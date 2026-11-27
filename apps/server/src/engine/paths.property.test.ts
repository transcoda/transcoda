// Property tests (fast-check) for the path helpers the replace step relies on: a file below the
// library root is "within" it, a sibling that only shares a prefix is not, and the recycle and
// temporary paths built from it stay where they belong.
import { dirname, join, sep } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isWithin } from './paths.ts';
import { recyclePathFor, tmpPathFor } from './replace.ts';

const RUNS = { numRuns: 200, seed: 0x7c0da };

/** One path segment: any text without a separator or NUL, and not `.` or `..`. */
const segment = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[/\0]/g, '_'))
  .filter((s) => s !== '.' && s !== '..');
const segments = (min: number) => fc.array(segment, { minLength: min, maxLength: 5 });
const absolute = (parts: string[]) => sep + parts.join(sep);

describe('path helpers (property)', () => {
  it('a file below the root is within it; a sibling sharing its prefix is not', () => {
    fc.assert(
      fc.property(segments(1), segments(1), segment, (root, rel, suffix) => {
        const rootPath = absolute(root);
        expect(isWithin(join(rootPath, ...rel), rootPath)).toBe(true);
        expect(isWithin(rootPath, rootPath)).toBe(true);
        expect(isWithin(`${rootPath}${suffix}`, rootPath)).toBe(false);
        expect(isWithin(join(`${rootPath}${suffix}`, ...rel), rootPath)).toBe(false);
      }),
      RUNS,
    );
  });

  it('the recycle path keeps the file’s place below the root inside the recycle folder', () => {
    fc.assert(
      fc.property(segments(1), segments(1), segments(1), fc.nat(9), (root, rel, recycle, n) => {
        const rootPath = absolute(root);
        const recycleFolder = absolute(recycle);
        const out = recyclePathFor(recycleFolder, rootPath, join(rootPath, ...rel), n);
        expect(isWithin(out, recycleFolder)).toBe(true);
        expect(out).toBe(join(recycleFolder, ...rel) + (n > 0 ? `.${n}` : ''));
      }),
      RUNS,
    );
  });

  it('the temporary file sits in the same folder as the original', () => {
    fc.assert(
      fc.property(segments(1), fc.uuid(), (parts, jobId) => {
        const original = absolute(parts);
        expect(dirname(tmpPathFor(original, jobId))).toBe(dirname(original));
      }),
      RUNS,
    );
  });
});
