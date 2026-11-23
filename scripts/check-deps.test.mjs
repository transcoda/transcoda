import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDeps } from './check-deps.mjs';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

const workspace = (pkgs) => {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'));
  for (const { name, dependencies } of pkgs) {
    const dir = join(root, 'packages', name.replace(/^@transcoda\//, ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies }));
  }
  return root;
};

it('the real workspace passes', () => assert.deepEqual(checkDeps(repoRoot), []));

it('sdk may depend on zod but not on hono', () => {
  const ok = workspace([
    { name: '@transcoda/sdk', dependencies: { zod: '4.6.7', '@transcoda/shared': 'workspace:*' } },
  ]);
  assert.deepEqual(checkDeps(ok), []);
  const bad = workspace([{ name: '@transcoda/sdk', dependencies: { hono: '4.13.13' } }]);
  assert.match(
    checkDeps(bad).join('\n'),
    /sdk: dependencies contains third-party dependency hono \(allowed: zod\)/,
  );
});

it('shared may depend on zod only; sdk may not depend on contract', () => {
  assert.match(
    checkDeps(workspace([{ name: '@transcoda/shared', dependencies: { hono: '1' } }])).join('\n'),
    /shared: .*hono/,
  );
  assert.match(
    checkDeps(
      workspace([
        { name: '@transcoda/sdk', dependencies: { '@transcoda/contract': 'workspace:*' } },
      ]),
    ).join('\n'),
    /sdk: dependencies contains forbidden dependency @transcoda\/contract/,
  );
});

it('no package reaches into another one with a relative import', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'));
  const pkg = (dir, name, files) => {
    mkdirSync(join(root, dir, 'src'), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name }));
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(root, dir, 'src', file), text);
    }
  };
  pkg('apps/server', '@transcoda/server', { 'a.ts': 'export const a = 1;\n' });
  pkg('apps/web', '@transcoda/web', {
    'ok.ts': "import { b } from './b.ts';\nimport x from '../../../examples/x.json';\n",
    'b.ts': 'export const b = 1;\n',
  });
  assert.deepEqual(checkDeps(root), []);
  writeFileSync(join(root, 'apps/web/src/bad.ts'), "import { a } from '../../server/src/a.ts';\n");
  assert.match(
    checkDeps(root).join('\n'),
    /apps\/web\/src\/bad\.ts imports \.\.\/\.\.\/server\/src\/a\.ts, a relative path into apps\/server/,
  );
});
