import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Allowlist,
  checkStructure,
  countLines,
  emptyAllowlist,
  isConcretePath,
  isTestSupportPath,
} from './check-structure.ts';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

/** A workspace with these files; a value is the file's text. */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-structure-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SMALL_FOLDER = /and no sub-folder\. A folder needs at least three/;

/** The failures for these files; small folders aside, which most examples here are. */
const check = (files: Record<string, string>, allow: Partial<Allowlist> = {}) =>
  checkStructure(workspace(files), { ...emptyAllowlist(), ...allow }).filter(
    (e) => !SMALL_FOLDER.test(e),
  );

const S = 'apps/server/src';
const W = 'apps/web/src';
const imp = (spec: string) => `import { x } from '${spec}';\nexport const y = x;\n`;
const leaf = 'export const x = 1;\n';

it('the real repository passes', () => {
  expect(checkStructure(repoRoot)).toEqual([]);
});

describe('layers (Rule A)', () => {
  it('lets a file import its own layer and lower ones', () => {
    expect(
      check({
        [`${S}/db/open.ts`]: imp('../logger.ts'),
        [`${S}/logger.ts`]: leaf,
        [`${S}/platform/config.ts`]: imp('../logger.ts'),
      }),
    ).toEqual([]);
  });

  it('fails an upward import, and an allowlisted one passes until it is gone', () => {
    const files = { [`${S}/logger.ts`]: imp('./db/open.ts'), [`${S}/db/open.ts`]: leaf };
    expect(check(files).join('\n')).toMatch(
      /apps\/server\/src\/logger\.ts \(layer platform\) imports apps\/server\/src\/db\/open\.ts \(layer db\), a higher layer/,
    );
    const edge = `${S}/logger.ts -> ${S}/db/open.ts`;
    expect(check(files, { upwardImports: [edge] })).toEqual([]);
    expect(
      check({ [`${S}/logger.ts`]: leaf, [`${S}/db/open.ts`]: leaf }, { upwardImports: [edge] }),
    ).toEqual([
      `"${edge}" in upwardImports in scripts/structure-allowlist.json no longer breaks the rule: remove the entry.`,
    ]);
  });

  it('uses the longest prefix: engine/verify.ts sits below nodes/, engine.ts above it', () => {
    expect(
      check({
        [`${S}/engine/verify.ts`]: imp('../nodes/registry.ts'),
        [`${S}/nodes/registry.ts`]: leaf,
        [`${S}/engine/engine.ts`]: imp('../nodes/registry.ts'),
      }).join('\n'),
    ).toMatch(/engine\/verify\.ts \(layer engine\/verify\) imports .* \(layer nodes\)/);
  });

  it('counts type-only imports and ignores tests', () => {
    const files = {
      [`${S}/db/open.ts`]: "import type { X } from '../engine/engine.ts';\nexport type Y = X;\n",
      [`${S}/db/open.test.ts`]: imp('../app/app.ts'),
      [`${S}/engine/engine.ts`]: 'export type X = 1;\n',
      [`${S}/app/app.ts`]: imp('../db/open.ts'),
      [`${S}/main.ts`]: imp('./app/app.ts'),
    };
    const errors = check(files);
    expect(errors, errors.join('\n')).toHaveLength(1);
    expect(errors[0]).toMatch(/db\/open\.ts \(layer db\) imports/);
  });

  it('keeps the web shared layer free of features', () => {
    expect(
      check({
        [`${W}/components/Shell.tsx`]: imp('../jobs/use-jobs.ts'),
        [`${W}/jobs/use-jobs.ts`]: leaf,
      }).join('\n'),
    ).toMatch(/components\/Shell\.tsx \(layer shared\) imports .* \(layer features\)/);
  });

  it('fails a production file that is in no layer', () => {
    expect(check({ [`${W}/widgets/a.ts`]: leaf }).join('\n')).toMatch(
      /apps\/web\/src\/widgets\/a\.ts is in no layer: add its folder .* LAYERS\['apps\/web\/src'\]/,
    );
  });
});

describe('module folders (Rule B)', () => {
  const files = {
    [`${S}/engine/verify/verify.ts`]: imp('./durations.ts'),
    [`${S}/engine/verify/durations.ts`]: leaf,
    [`${S}/engine/verify/durations.test.ts`]: imp('./durations.ts'),
    [`${S}/engine/verify/testing.ts`]: leaf,
  };

  it('allows the entry from outside and anything from inside', () => {
    expect(
      check({
        ...files,
        [`${S}/engine/engine.ts`]: imp('./verify/verify.ts'),
        [`${S}/engine/engine.test.ts`]: imp('./verify/testing.ts'),
      }),
    ).toEqual([]);
  });

  it('fails an import of an internal file from outside', () => {
    expect(
      check({ ...files, [`${S}/engine/engine.ts`]: imp('./verify/durations.ts') }).join('\n'),
    ).toMatch(
      /engine\/engine\.ts imports .*verify\/durations\.ts, inside the module folder .*verify\/\. Import its entry .*verify\/verify\.ts instead/,
    );
  });

  it('does not treat an area as a module folder', () => {
    expect(
      check({
        [`${S}/engine/engine.ts`]: leaf,
        [`${S}/engine/probe.ts`]: leaf,
        [`${S}/rpc/router.ts`]: imp('../engine/probe.ts'),
      }),
    ).toEqual([]);
  });
});

describe('barrels', () => {
  it('allows index.ts only for registries and package entry points', () => {
    const errors = check({
      [`${S}/nodes/core/index.ts`]: leaf,
      [`${S}/nodes/thing/index.ts`]: leaf,
      [`${S}/nodes/thing/a.ts`]: leaf,
      [`${S}/nodes/thing/b.ts`]: leaf,
      'packages/shared/package.json': JSON.stringify({
        name: '@transcoda/shared',
        exports: { '.': './src/index.ts' },
      }),
      'packages/shared/src/index.ts': leaf,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/nodes\/thing\/index\.ts is an index file\. No barrels/);
  });
});

describe('test support (Rule C)', () => {
  it('fails production code that imports test code', () => {
    expect(
      check({
        [`${S}/db/open.ts`]: imp('./testing.ts'),
        [`${S}/db/testing.ts`]: leaf,
      }).join('\n'),
    ).toMatch(/db\/open\.ts imports .*db\/testing\.ts, which is test code/);
  });

  it('names a file only tests import as test support', () => {
    const files = {
      [`${S}/db/test-db.ts`]: leaf,
      [`${S}/db/open.ts`]: leaf,
      [`${S}/db/open.test.ts`]: imp('./test-db.ts'),
    };
    expect(check(files).join('\n')).toMatch(
      /db\/test-db\.ts: only tests import it, so it is test support\. Move it into a testing\.ts/,
    );
    expect(check(files, { testSupportNames: [`${S}/db/test-db.ts`] })).toEqual([]);
  });

  it('counts a package entry imported by name as used', () => {
    expect(
      check({
        'packages/shared/package.json': JSON.stringify({
          name: '@transcoda/shared',
          exports: { '.': './src/index.ts' },
        }),
        'packages/shared/src/index.ts': leaf,
        [`${S}/db/open.ts`]: "import { x } from '@transcoda/shared';\nexport const y = x;\n",
      }),
    ).toEqual([]);
  });

  it('knows test support by name', () => {
    expect(isTestSupportPath('a/testing.ts')).toBe(true);
    expect(isTestSupportPath('a/testing/build.ts')).toBe(true);
    expect(isTestSupportPath('a/fixtures/x.ts')).toBe(true);
    expect(isTestSupportPath('a/test-helpers.ts')).toBe(false);
  });
});

describe('pages', () => {
  it('lets only App.tsx import a page', () => {
    const files = {
      [`${W}/jobs/JobPage/JobPage.tsx`]: imp('./JobHead.tsx'),
      [`${W}/jobs/JobPage/JobHead.tsx`]: leaf,
      [`${W}/App.tsx`]: imp('./jobs/JobPage/JobPage.tsx'),
    };
    expect(check(files)).toEqual([]);
    const errors = check({ ...files, [`${W}/jobs/RunPage.tsx`]: imp('./JobPage/JobPage.tsx') });
    expect(errors.join('\n')).toMatch(
      /jobs\/RunPage\.tsx imports .*JobPage\.tsx, part of the page .*jobs\/JobPage\. Only apps\/web\/src\/App\.tsx imports a page/,
    );
  });
});

describe('folders', () => {
  it('wants kebab-case, or PascalCase with a same-named component', () => {
    const errors = check({
      [`${W}/jobs/JobPage/JobPage.tsx`]: leaf,
      [`${W}/jobs/Parts/a.ts`]: leaf,
      [`${W}/jobs/Parts/b.ts`]: leaf,
      [`${W}/jobs/Parts/c.ts`]: leaf,
      [`${W}/App.tsx`]: imp('./jobs/JobPage/JobPage.tsx'),
    });
    expect(errors.filter((e) => /folder name/.test(e))).toEqual([
      'apps/web/src/jobs/Parts/: a folder name is kebab-case, or PascalCase when it holds a component of that name (Parts/Parts.tsx). Rename it.',
    ]);
  });

  it('fails a folder with fewer than three source files and no sub-folder', () => {
    const errors = checkStructure(
      workspace({ [`${S}/updates/app-update.ts`]: leaf }),
      emptyAllowlist(),
    );
    expect(errors.join('\n')).toMatch(
      /apps\/server\/src\/updates\/ has 1 source file and no sub-folder\. A folder needs at least three: move its files up into apps\/server\/src\//,
    );
  });
});

describe('test names', () => {
  it('wants a subject beside every test', () => {
    const errors = check({
      [`${S}/db/open.ts`]: leaf,
      [`${S}/db/open.test.ts`]: imp('./open.ts'),
      [`${S}/db/open.real.test.ts`]: imp('./open.ts'),
      [`${S}/db/repos.test.ts`]: imp('./open.ts'),
    });
    expect(errors.filter((e) => /named after no source file/.test(e))).toEqual([
      expect.stringMatching(/^apps\/server\/src\/db\/repos\.test\.ts is named after no source/),
    ]);
  });
});

describe('the soft size limit', () => {
  const big = 'export const x = 1;\n'.repeat(801);

  it('fails a source file over 800 lines, but not a test', () => {
    expect(check({ [`${S}/db/open.ts`]: big }).join('\n')).toMatch(
      /db\/open\.ts has 801 lines, over the soft limit of 800/,
    );
    expect(check({ [`${S}/db/open.ts`]: leaf, [`${S}/db/open.test.ts`]: big })).toEqual([]);
  });

  it('holds a listed file to its number, which only goes down', () => {
    const path = `${S}/db/open.ts`;
    expect(check({ [path]: big }, { softSizeLimit: { [path]: 801 } })).toEqual([]);
    expect(check({ [path]: big }, { softSizeLimit: { [path]: 800 } }).join('\n')).toMatch(
      /grew to 801 lines/,
    );
    expect(check({ [path]: big }, { softSizeLimit: { [path]: 900 } }).join('\n')).toMatch(
      /lower its number .* from 900 to 801/,
    );
    expect(check({ [path]: leaf }, { softSizeLimit: { [path]: 900 } }).join('\n')).toMatch(
      /is down to 1 lines, within the soft limit of 800: remove it/,
    );
  });

  it('counts lines as the file-size check does', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });
});

describe('doc paths', () => {
  it('wants every back-ticked path in AGENTS.md and docs/dev to exist', () => {
    const errors = check({
      [`${S}/db/open.ts`]: leaf,
      'AGENTS.md':
        'See `apps/server/src/db/open.ts`, `db/open.ts`, `open.ts` and `apps/server/`.\n',
      'docs/dev/x.md': 'Gone: `apps/server/src/db/old.ts`. Not paths: `pnpm check`, `NNNN_x.ts`.\n',
    });
    expect(errors).toEqual([
      "docs/dev/x.md names `apps/server/src/db/old.ts`, which does not exist. Change it to the file's path now, or drop it.",
    ]);
  });

  it('tells a concrete path from other code', () => {
    for (const p of ['apps/web/src/App.tsx', 'steps.test.ts', 'docs/dev/', 'apps/server']) {
      expect(isConcretePath(p), p).toBe(true);
    }
    for (const p of [
      'pnpm check',
      'src/**/*.ts',
      '<transcodeDir>/test-outputs/',
      'NNNN_snake_case.ts',
      './x.ts',
      '.tsx',
      'Node.js',
      'hevc_vaapi/h264_vaapi',
      '.local/fixtures',
    ]) {
      expect(isConcretePath(p), p).toBe(false);
    }
  });
});

it('fails an unknown list in the allowlist file', () => {
  const allow = { ...emptyAllowlist(), typo: [] } as Allowlist;
  expect(checkStructure(workspace({}), allow)).toEqual([
    'scripts/structure-allowlist.json has an unknown list "typo".',
  ]);
});
