import { describe, expect, it } from 'vitest';
import { escapeHelp, escapeLabelValue, formatValue, renderExposition } from './exposition.ts';
import { parseExposition } from './parse-exposition.ts';

describe('formatValue', () => {
  it('writes integers plainly, keeps decimals and spells the special values', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(12345678901)).toBe('12345678901');
    expect(formatValue(0.25)).toBe('0.25');
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatValue(Number.NaN)).toBe('NaN');
  });
});

describe('escaping', () => {
  it('escapes backslash, double quote and newline in label values', () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it('escapes backslash and newline in help text, not quotes', () => {
    expect(escapeHelp('x\\y\n"z"')).toBe('x\\\\y\\n"z"');
  });
});

describe('renderExposition', () => {
  it('writes HELP and TYPE once per family, then one line per sample, and ends with a newline', () => {
    const text = renderExposition([
      {
        name: 'transcoda_jobs',
        type: 'gauge',
        help: 'Jobs not yet finished.',
        samples: [
          { labels: { state: 'queued', library: 'Movies' }, value: 3 },
          { labels: { state: 'encoding', library: 'Movies' }, value: 1 },
        ],
      },
      {
        name: 'transcoda_queue_paused',
        type: 'gauge',
        help: 'Queue paused.',
        samples: [{ labels: {}, value: 0 }],
      },
    ]);
    expect(text).toBe(
      [
        '# HELP transcoda_jobs Jobs not yet finished.',
        '# TYPE transcoda_jobs gauge',
        'transcoda_jobs{state="queued",library="Movies"} 3',
        'transcoda_jobs{state="encoding",library="Movies"} 1',
        '# HELP transcoda_queue_paused Queue paused.',
        '# TYPE transcoda_queue_paused gauge',
        'transcoda_queue_paused 0',
        '',
      ].join('\n'),
    );
  });

  it('escapes label values so a library name with quotes round-trips', () => {
    const text = renderExposition([
      {
        name: 'transcoda_library_files',
        type: 'gauge',
        help: 'Files.',
        samples: [{ labels: { library: 'Kids "Shows"\\new\nline' }, value: 7 }],
      },
    ]);
    const parsed = parseExposition(text);
    expect(parsed.samples).toEqual([
      { name: 'transcoda_library_files', labels: { library: 'Kids "Shows"\\new\nline' }, value: 7 },
    ]);
  });

  it('writes a family with no samples as HELP and TYPE only', () => {
    const text = renderExposition([
      { name: 'transcoda_x', type: 'counter', help: 'X.', samples: [] },
    ]);
    expect(text).toBe('# HELP transcoda_x X.\n# TYPE transcoda_x counter\n');
  });

  it('writes a histogram as cumulative _bucket lines with le, a +Inf bucket, _sum and _count', () => {
    const text = renderExposition([
      {
        name: 'transcoda_job_duration_seconds',
        type: 'histogram',
        help: 'Duration.',
        buckets: [10, 60],
        samples: [{ labels: { lane: 'encode' }, counts: [1, 2], count: 4, sum: 300.5 }],
      },
    ]);
    expect(text).toBe(
      [
        '# HELP transcoda_job_duration_seconds Duration.',
        '# TYPE transcoda_job_duration_seconds histogram',
        'transcoda_job_duration_seconds_bucket{lane="encode",le="10"} 1',
        'transcoda_job_duration_seconds_bucket{lane="encode",le="60"} 3',
        'transcoda_job_duration_seconds_bucket{lane="encode",le="+Inf"} 4',
        'transcoda_job_duration_seconds_sum{lane="encode"} 300.5',
        'transcoda_job_duration_seconds_count{lane="encode"} 4',
        '',
      ].join('\n'),
    );
    expect(parseExposition(text).types.get('transcoda_job_duration_seconds')).toBe('histogram');
  });
});
