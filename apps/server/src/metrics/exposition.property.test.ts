// Property tests (fast-check) for the Prometheus text writer: any help text, label value and sample
// value reads back unchanged through the strict reader the other exposition tests use.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderExposition, type ScalarFamily } from './exposition.ts';
import { parseExposition } from './parse-exposition.ts';

const RUNS = { numRuns: 200, seed: 0x7c0da };

// Backslashes, quotes and newlines weighted in, plus any text at all.
const text = fc.oneof(
  fc.string({ unit: fc.constantFrom('\\', '"', '\n', 'n', ' ', 'a', '{', '}', ',', '=', '#') }),
  fc.string(),
);

const labelName = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,8}$/);

const family: fc.Arbitrary<ScalarFamily> = fc.record({
  name: fc.stringMatching(/^transcoda_[a-z_]{1,12}$/),
  type: fc.constantFrom('gauge' as const, 'counter' as const),
  help: text,
  samples: fc.array(
    fc.record({
      labels: fc.dictionary(labelName, text, { maxKeys: 3 }),
      value: fc.double(),
    }),
    { maxLength: 4 },
  ),
});

describe('renderExposition (property)', () => {
  it('writes help, labels and values that read back unchanged', () => {
    fc.assert(
      fc.property(family, (f) => {
        const parsed = parseExposition(renderExposition([f]));
        expect(parsed.help.get(f.name)).toBe(f.help);
        expect(parsed.types.get(f.name)).toBe(f.type);
        expect(parsed.samples).toEqual(
          // -0 is written as 0, which is the same value to Prometheus.
          f.samples.map((s) => ({
            name: f.name,
            labels: s.labels,
            value: s.value === 0 ? 0 : s.value,
          })),
        );
      }),
      RUNS,
    );
  });
});
