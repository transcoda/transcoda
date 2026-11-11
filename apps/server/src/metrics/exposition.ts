/**
 * The Prometheus text exposition format (version 0.0.4), written by hand: a few metric families
 * per scrape do not need a client library, its global registry or its default process metrics.
 */
export const EXPOSITION_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export type Labels = Record<string, string>;

export interface ScalarFamily {
  name: string;
  type: 'gauge' | 'counter';
  help: string;
  samples: { labels: Labels; value: number }[];
}

export interface HistogramFamily {
  name: string;
  type: 'histogram';
  help: string;
  /** Upper bounds, ascending; `+Inf` is added. */
  buckets: readonly number[];
  /** `counts[i]`: observations in bucket i alone (not cumulative), one entry per bucket. */
  samples: { labels: Labels; counts: readonly number[]; count: number; sum: number }[];
}

export type MetricFamily = ScalarFamily | HistogramFamily;

export function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return '+Inf';
  if (v === Number.NEGATIVE_INFINITY) return '-Inf';
  return Number.isInteger(v) ? v.toFixed(0) : String(v);
}

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

export function renderExposition(families: readonly MetricFamily[]): string {
  const out: string[] = [];
  for (const f of families) {
    out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`);
    if (f.type === 'histogram') {
      for (const s of f.samples) {
        let cumulative = 0;
        f.buckets.forEach((le, i) => {
          cumulative += s.counts[i] ?? 0;
          out.push(
            `${f.name}_bucket${labelText({ ...s.labels, le: formatValue(le) })} ${cumulative}`,
          );
        });
        out.push(
          `${f.name}_bucket${labelText({ ...s.labels, le: '+Inf' })} ${formatValue(s.count)}`,
        );
        out.push(`${f.name}_sum${labelText(s.labels)} ${formatValue(s.sum)}`);
        out.push(`${f.name}_count${labelText(s.labels)} ${formatValue(s.count)}`);
      }
    } else {
      for (const s of f.samples)
        out.push(`${f.name}${labelText(s.labels)} ${formatValue(s.value)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
