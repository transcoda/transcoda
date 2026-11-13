// The Grafana dashboard and the docs name metrics by hand: these tests keep them in step with the
// catalog `/metrics` serves, so a renamed or dropped metric fails here, not in someone's Grafana.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { METRICS } from './catalog.ts';

const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const DASHBOARD = root('examples/grafana/transcoda-dashboard.json');
const DOCS = root('docs/metrics.md');

interface Panel {
  id?: number;
  type: string;
  title?: string;
  datasource?: { type?: string; uid?: string };
  targets?: { expr?: string; datasource?: { type?: string; uid?: string } }[];
  panels?: Panel[];
}

const dashboard = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as {
  __inputs?: { name: string; type: string; pluginId: string }[];
  uid: string;
  title: string;
  panels: Panel[];
  templating?: { list: { name: string; query?: string; definition?: string }[] };
};

function allPanels(list: Panel[]): Panel[] {
  return list.flatMap((p) => [p, ...allPanels(p.panels ?? [])]);
}

/** Every `transcoda_*` name an expression uses, with histogram suffixes taken off. */
function metricNames(expr: string): string[] {
  const known = new Map<string, string>(METRICS.map((m) => [m.name, m.type]));
  return [...expr.matchAll(/\btranscoda_[a-z0-9_]+/g)].map(([name]) => {
    const base = name.replace(/_(bucket|sum|count)$/, '');
    return known.get(base) === 'histogram' && base !== name ? base : name;
  });
}

const catalog = new Set<string>(METRICS.map((m) => m.name));
const panels = allPanels(dashboard.panels);
const exprs = [
  ...panels.flatMap((p) => (p.targets ?? []).flatMap((t) => (t.expr ? [t.expr] : []))),
  ...(dashboard.templating?.list ?? []).flatMap((v) =>
    [v.query, v.definition].filter((q): q is string => typeof q === 'string'),
  ),
];

describe('examples/grafana/transcoda-dashboard.json', () => {
  it('asks for a Prometheus data source on import and uses only that', () => {
    expect(dashboard.__inputs).toEqual([
      expect.objectContaining({
        name: 'DS_PROMETHEUS',
        type: 'datasource',
        pluginId: 'prometheus',
      }),
    ]);
    // Grafana's import placeholder, not a JS template.
    const ds = { type: 'prometheus', uid: `\${DS_PROMETHEUS}` };
    for (const p of panels.filter((x) => x.type !== 'row')) {
      expect(p.datasource, p.title).toEqual(ds);
      for (const t of p.targets ?? []) expect(t.datasource, p.title).toEqual(ds);
    }
  });

  it('has a stable uid and unique panel ids', () => {
    expect(dashboard.uid).toBe('transcoda');
    const ids = panels.map((p) => p.id);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('queries only metrics /metrics serves', () => {
    expect(exprs.length).toBeGreaterThan(10);
    for (const expr of exprs) {
      for (const name of metricNames(expr))
        expect(catalog.has(name), `${name} in ${expr}`).toBe(true);
    }
  });

  it('uses the per-library and per-encoder metrics it is meant to chart', () => {
    const used = new Set(exprs.flatMap(metricNames));
    for (const name of [
      'transcoda_jobs',
      'transcoda_saved_bytes',
      'transcoda_jobs_finished',
      'transcoda_processed_media_seconds',
      'transcoda_encoder_busy_seconds_total',
      'transcoda_gpu_utilization_ratio',
      'transcoda_recycle_bytes',
      'transcoda_job_duration_seconds',
    ]) {
      expect(used.has(name), name).toBe(true);
    }
  });
});

describe('docs/metrics.md', () => {
  const docs = readFileSync(DOCS, 'utf8');
  const rows = new Map(
    [...docs.matchAll(/^\| `(transcoda_[a-z0-9_]+)` \| (\w+) \| ([^|]*) \|/gm)].map((m) => [
      m[1] as string,
      { type: m[2] as string, labels: (m[3] as string).trim() },
    ]),
  );

  it('lists every metric with its type and labels, in catalog order', () => {
    expect([...rows.keys()]).toEqual(METRICS.map((m) => m.name));
    for (const m of METRICS) {
      const row = rows.get(m.name);
      expect(row?.type, m.name).toBe(m.type);
      const labels = m.labels.length === 0 ? '' : m.labels.map((l) => `\`${l}\``).join(', ');
      expect(row?.labels, m.name).toBe(labels);
    }
  });

  it('names no metric the server does not serve', () => {
    for (const name of new Set(docs.match(/\btranscoda_[a-z0-9_]+/g) ?? [])) {
      const base = name.replace(/_(bucket|sum|count)$/, '');
      expect(catalog.has(name) || catalog.has(base), name).toBe(true);
    }
  });
});
