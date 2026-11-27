// The suppression budget: how many `biome-ignore` comments each rule has. A count may only go down.
// Adding a suppression fails here: follow the rule instead, or, if it really cannot be followed,
// raise its count in the pull request so a reviewer sees it. Removing one fails too, until its count
// is lowered, so the budget follows the code down (like the migration allowlist).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  'build',
  '.git',
  '.local',
  '.superpowers',
  'docs',
]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs|css|json|jsonc|grit)$/;
const SELF = relative(ROOT, import.meta.filename);

/** Suppressions per rule (`format` for the formatter); `-start`/`-end` pairs count once. */
const BASELINE: Record<string, number> = {
  format: 36,
  'lint/a11y/noAutofocus': 12,
  'lint/a11y/noInteractiveElementToNoninteractiveRole': 1,
  'lint/a11y/noNoninteractiveTabindex': 1,
  'lint/a11y/noStaticElementInteractions': 7,
  'lint/a11y/useKeyWithClickEvents': 2,
  'lint/a11y/useMediaCaption': 1,
  'lint/a11y/useSemanticElements': 12,
  'lint/complexity/useMathMinMax': 1,
  'lint/correctness/useExhaustiveDependencies': 13,
  'lint/plugin/utc-dates': 2,
  'lint/security/noGlobalEval': 1,
  'lint/style/noDescendingSpecificity': 1,
  'lint/style/noHexColors': 1,
  'lint/suspicious/noArrayIndexKey': 18,
  'lint/suspicious/noConsole': 1,
  'lint/suspicious/noControlCharactersInRegex': 1,
  'lint/suspicious/noExplicitAny': 7,
  'lint/suspicious/noTemplateCurlyInString': 2,
};

/** Every file Biome may read, as paths relative to the repo root (docs and build output left out). */
function sourceFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

/** The rules each suppression comment names; a comment may name several before its colon. */
function suppressedRules(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/biome-ignore(?:-all|-start)? ([^:\n]+):/g)) {
    const rules = (m[1] ?? '').trim().split(/\s+/);
    for (const rule of rules) out.push(rule.replace(/\(.*\)$/, ''));
  }
  return out;
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sourceFiles()) {
    if (file === SELF) continue;
    for (const rule of suppressedRules(readFileSync(join(ROOT, file), 'utf8'))) {
      out[rule] = (out[rule] ?? 0) + 1;
    }
  }
  return out;
}

describe('biome suppressions', () => {
  it('reads one comment per suppression, with every rule it names', () => {
    expect(suppressedRules('// biome-ignore lint/a/b: why\n')).toEqual(['lint/a/b']);
    expect(suppressedRules('{/* biome-ignore lint/a/b lint/c/d: why */}')).toEqual([
      'lint/a/b',
      'lint/c/d',
    ]);
    expect(
      suppressedRules('/* biome-ignore-start lint/s/x: why */ a /* biome-ignore-end lint/s/x: */'),
    ).toEqual(['lint/s/x']);
    expect(suppressedRules('// biome-ignore lint/s/x(name): why')).toEqual(['lint/s/x']);
    expect(suppressedRules('// biome-ignore format: aligned table')).toEqual(['format']);
  });

  it('stays within the budget per rule, and the budget follows the code down', () => {
    const now = counts();
    const rules = new Set([...Object.keys(now), ...Object.keys(BASELINE)]);
    const over: string[] = [];
    const under: string[] = [];
    for (const rule of [...rules].sort()) {
      const have = now[rule] ?? 0;
      const budget = BASELINE[rule] ?? 0;
      if (have > budget) over.push(`${rule}: ${have} (budget ${budget})`);
      if (have < budget) under.push(`${rule}: ${have} (lower the budget from ${budget})`);
    }
    expect(over, 'new biome-ignore comments: follow the rule instead').toEqual([]);
    expect(under, 'fewer suppressions than the budget: lower BASELINE').toEqual([]);
  });
});
