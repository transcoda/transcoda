// Property tests (fast-check) for the -progress parser: whatever ffmpeg writes, and however the
// pipe splits it, parsing never throws and every number it reports is one a job page can show.
import { fcRuns } from '@transcoda/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type ProgressSample,
  parseProgressBlock,
  progressReader,
  toJobProgress,
} from './progress.ts';

const RUNS = fcRuns();

const KEYS = [
  'frame',
  'fps',
  'out_time_us',
  'out_time_ms',
  'out_time',
  'total_size',
  'speed',
  'bitrate',
] as const;

/** A value ffmpeg might write, or garbage: numbers, N/A, clocks, suffixes, any text. */
const value = fc.oneof(
  fc.constant('N/A'),
  fc.double().map(String),
  fc.integer().map(String),
  fc.double({ min: 0, max: 100, noNaN: true }).map((n) => `${n}x`),
  fc
    .tuple(fc.boolean(), fc.nat(99), fc.nat(59), fc.nat(59), fc.nat(999_999))
    .map(
      ([neg, h, m, s, us]) =>
        `${neg ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(us).padStart(6, '0')}`,
    ),
  fc.string(),
);

const line = fc.oneof(
  fc.tuple(fc.constantFrom(...KEYS), value).map(([k, v]) => `${k}=${v}`),
  fc.string(),
);

const block = fc
  .tuple(fc.array(line, { maxLength: 10 }), fc.constantFrom('continue', 'end'))
  .map(([lines, state]) => [...lines, `progress=${state}`]);

const finiteOrNull = (n: number | null) => n === null || Number.isFinite(n);

function expectSane(s: ProgressSample): void {
  expect(
    s.outTimeSeconds === null || (Number.isFinite(s.outTimeSeconds) && s.outTimeSeconds >= 0),
  ).toBe(true);
  expect(finiteOrNull(s.speed)).toBe(true);
  expect(finiteOrNull(s.fps)).toBe(true);
  expect(s.sizeBytes === null || (Number.isInteger(s.sizeBytes) && s.sizeBytes >= 0)).toBe(true);
  expect(s.frames === undefined || (Number.isInteger(s.frames) && s.frames >= 0)).toBe(true);
}

describe('parseProgressBlock (property)', () => {
  it('never throws, and reads a sample with sane numbers from any block that ends with progress=', () => {
    fc.assert(
      fc.property(block, (lines) => {
        const s = parseProgressBlock(lines);
        expect(s).not.toBeNull();
        if (s) expectSane(s);
      }),
      RUNS,
    );
  });

  it('never throws on arbitrary lines, and is null without a progress state', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 10 }), (lines) => {
        const s = parseProgressBlock(lines);
        const hasState = lines.some((l) => /^\s*progress\s*=\s*(continue|end)\s*$/.test(l));
        if (!hasState) expect(s).toBeNull();
        if (s) expectSane(s);
      }),
      RUNS,
    );
  });

  it('keeps a block with no out time (N/A) as a sample with a null out time', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (frame, size) => {
        const s = parseProgressBlock([
          `frame=${frame}`,
          `total_size=${size}`,
          'out_time_us=N/A',
          'out_time_ms=N/A',
          'out_time=N/A',
          'progress=continue',
        ]);
        expect(s).toEqual({
          outTimeSeconds: null,
          speed: null,
          fps: null,
          sizeBytes: size,
          frames: frame,
        });
      }),
      RUNS,
    );
  });

  it('reads an hh:mm:ss.micro out time back as the seconds it was written from', () => {
    fc.assert(
      fc.property(fc.nat(999), fc.nat(59), fc.nat(59), fc.nat(999_999), (h, m, s, us) => {
        const text = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(us).padStart(6, '0')}`;
        const sample = parseProgressBlock([`out_time=${text}`, 'progress=continue']);
        expect(sample?.outTimeSeconds).toBeCloseTo(h * 3600 + m * 60 + s + us / 1e6, 6);
      }),
      RUNS,
    );
  });
});

describe('progressReader (property)', () => {
  it('reports the same samples however the stream is split into chunks', () => {
    const stream = fc
      .tuple(fc.array(block, { maxLength: 5 }), fc.boolean())
      .map(([blocks, crlf]) => {
        // Every line ends with \n (or \r\n), the block's last one included.
        const eol = crlf ? '\r\n' : '\n';
        return blocks
          .flat()
          .map((l) => `${l.replace(/[\r\n]/g, ' ')}${eol}`)
          .join('');
      });
    fc.assert(
      fc.property(stream, fc.array(fc.nat(), { maxLength: 8 }), (text, cuts) => {
        const whole: ProgressSample[] = [];
        progressReader((s) => whole.push(s))(text);

        const pieces: ProgressSample[] = [];
        const read = progressReader((s) => pieces.push(s));
        const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
        let from = 0;
        for (const p of [...points, text.length]) {
          read(text.slice(from, p));
          from = p;
        }
        expect(pieces).toEqual(whole);
      }),
      RUNS,
    );
  });
});

describe('toJobProgress (property)', () => {
  const sample = fc.record({
    outTimeSeconds: fc.option(fc.double({ min: 0, noNaN: true, noDefaultInfinity: true })),
    speed: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true })),
    fps: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true })),
    sizeBytes: fc.option(fc.nat()),
  });

  it('gives a percent within 0 to 100 and an ETA that is finite and never negative, or null', () => {
    fc.assert(
      fc.property(sample, fc.double(), (s, duration) => {
        const p = toJobProgress(s, duration);
        expect(p.percent === null || (p.percent >= 0 && p.percent <= 100)).toBe(true);
        expect(p.etaSeconds === null || (Number.isFinite(p.etaSeconds) && p.etaSeconds >= 0)).toBe(
          true,
        );
        expect(Number.isFinite(p.outTimeSeconds) && p.outTimeSeconds >= 0).toBe(true);
        if (s.outTimeSeconds === null) expect(p.percent).toBeNull();
      }),
      RUNS,
    );
  });
});
