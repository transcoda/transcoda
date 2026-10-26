import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('the real workspace passes', () => assert.deepEqual(checkDeps(repoRoot), []));

test('sdk may depend on zod but not on hono', () => {
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

test('shared may depend on zod only; sdk may not depend on contract', () => {
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
