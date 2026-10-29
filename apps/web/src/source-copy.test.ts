import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

/** Every component source under src (no tests, no test helpers), as [path relative to src, text]. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test') walk(path);
      } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
        out.push([relative(__dirname, path), readFileSync(path, 'utf8')]);
      }
    }
  };
  walk(__dirname);
  return out;
}

/** Acronyms and codes that are capitals in any case. */
const ACRONYMS = new Set([
  'API',
  'CPU',
  'CRF',
  'GNU',
  'GPU',
  'GPL',
  'HEVC',
  'HTTP',
  'JSON',
  'MKV',
  'MP4',
  'SDH',
  'SDK',
  'SHA',
  'TMDB',
  'URL',
]);

/** The shown copy of a file: JSX text, display attributes, and the strings a JSX `{…}` picks or builds. */
function copyOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/>([^<>{}]*)</g)) out.push(m[1] ?? '');
  for (const m of text.matchAll(
    /\b(?:eyebrow|label|data-label|aria-label|title|placeholder)="([^"]*)"/g,
  )) {
    out.push(m[1] ?? '');
  }
  for (const m of text.matchAll(/\{[^{}]*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*\}/g)) {
    out.push(m[1] ?? '', m[2] ?? '');
  }
  for (const m of text.matchAll(/\{\s*(?:[^{}`]*\?\s*)?`([^`]*)`/g)) {
    out.push((m[1] ?? '').replace(/\$\{[^}]*\}/g, ' '));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const typedCaps = (copy: string): string[] =>
  [...copy.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)]
    .map((m) => m[0])
    .filter((w) => !ACRONYMS.has(w) && /[A-Z]{3}/.test(w));

describe('copy in source (L12, L16)', () => {
  it('no page shows its own "Loading…" text: every loading state is the shared Loading', () => {
    const own = sources()
      .filter(([path]) => path !== join('components', 'Loading.tsx'))
      .flatMap(([path, text]) =>
        [...text.matchAll(/>\s*(Loading[^<>{}]*?)\s*</g)].map((m) => `${path}: ${m[1]}`),
      );
    expect(own).toEqual([]);
  });

  it('no label or header is typed in capitals: sentence case in source, uppercase by text-transform', () => {
    const caps = sources().flatMap(([path, text]) =>
      copyOf(text)
        .filter((c) => typedCaps(c).length > 0)
        .map((c) => `${path}: ${c}`),
    );
    expect(caps).toEqual([]);
  });
});

describe('labels typed in sentence case are shown in capitals by their class (L16)', () => {
  it.each([
    '.token-table th',
    '.new-tag',
    '.revoked-tag',
    '.wf-table th',
    '.lib-table th',
    '.plan-table thead th',
    '.plan-tile-label',
    '.plan-tile-now',
    '.plan-original',
    '.eyebrow',
    '.eyebrow-kind-word',
    '.palette-heading',
    '.node-search-kind',
    '.inspector-eyebrow.is-caps',
    '.tc-node-eyebrow',
    '.tc-group-count',
    '.legend-label',
    '.live-dot.is-live',
  ])('%s', (selector) => {
    expect(rule(selector)).toMatch(/text-transform:\s*uppercase/);
  });
});
