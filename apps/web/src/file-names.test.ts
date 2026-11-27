import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Web file names (docs/dev/conventions.md, "File names"): a module whose main export is a React
// component is PascalCase (`JobPage.tsx`); every other module is kebab-case (`media-text.ts`);
// a test follows its subject. Biome's useFilenamingConvention allows only those two cases in
// apps/web/src but cannot see what a file exports, so this test checks which of the two applies.

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

/** Every .ts and .tsx file under src, as paths relative to src. */
function files(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) out.push(relative(__dirname, path));
    }
  };
  walk(__dirname);
  return out.sort();
}

const stem = (path: string) => (path.split('/').pop() ?? '').split('.')[0] ?? '';
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

/** Names of the values (not types) a module exports. */
function valueExports(text: string): string[] {
  return [
    ...text.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z0-9_$]+)/gm),
  ].map((m) => m[1] ?? '');
}

const isComponentName = (name: string) => /^[A-Z][a-z]/.test(name);

describe('web file names', () => {
  const all = files();
  const sources = all.filter((path) => !isTest(path) && !path.endsWith('.d.ts'));

  it('finds the source files', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('names a module PascalCase only when it exports a component', () => {
    const wrong = sources
      .filter((path) => PASCAL.test(stem(path)))
      .filter(
        (path) =>
          !path.endsWith('.tsx') ||
          !valueExports(readFileSync(join(__dirname, path), 'utf8')).some(isComponentName),
      );
    expect(wrong, 'rename these to kebab-case').toEqual([]);
  });

  it('names a module PascalCase when it exports nothing but components', () => {
    const wrong = sources
      .filter((path) => path.endsWith('.tsx') && !PASCAL.test(stem(path)))
      .filter((path) => {
        const names = valueExports(readFileSync(join(__dirname, path), 'utf8'));
        return names.length > 0 && names.every(isComponentName);
      });
    expect(wrong, 'rename these to PascalCase').toEqual([]);
  });

  it('names a PascalCase test after the component file it tests', () => {
    const wrong = all
      .filter((path) => isTest(path) && PASCAL.test(stem(path)))
      .filter((path) => {
        const dir = path.split('/').slice(0, -1).join('/');
        const subject = join(dir, `${stem(path)}.tsx`);
        return !all.includes(subject);
      });
    expect(wrong, 'name the test after its subject').toEqual([]);
  });
});
