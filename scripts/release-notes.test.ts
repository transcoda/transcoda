import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { compareVersions, parseNote, prependChangelog } from './release-notes.mjs';

const script = join(import.meta.dirname, 'release-notes.mjs');
let root: string;

const note = (name: string, type: string, text: string) =>
  writeFileSync(join(root, '.changes', name), `---\ntype: ${type}\n---\n${text}\n`);
const cli = (...args: string[]) =>
  spawnSync('node', [script, ...args, '--root', root], { encoding: 'utf8' });
const read = (p: string) => readFileSync(join(root, p), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relnotes-'));
  mkdirSync(join(root, '.changes'));
  writeFileSync(join(root, '.changes/README.md'), '# readme\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseNote', () => {
  it('parses type and body, joining lines', () => {
    expect(parseNote('---\ntype: new\n---\nHello\nworld.\n')).toEqual({
      type: 'new',
      text: 'Hello world.',
    });
  });
  it('reports bad type and empty body', () => {
    expect(parseNote('---\ntype: wat\n---\n\n').errors).toHaveLength(2);
    expect(parseNote('no front matter').errors).toHaveLength(2);
  });
});

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const sorted = [
      '1.0.0',
      '0.10.0',
      '0.2.0',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
      '1.0.0-alpha',
      '0.1.0',
    ];
    expect([...sorted].sort(compareVersions)).toEqual([
      '0.1.0',
      '0.2.0',
      '0.10.0',
      '1.0.0-alpha',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
      '1.0.0',
    ]);
    expect(compareVersions('0.1.0', '0.1.0+build.5')).toBe(0);
  });
});

describe('prependChangelog', () => {
  it('puts the new section above older ones', () => {
    const out = prependChangelog(
      '# Changelog\n\nintro\n\n## 1.0.0 — 2026-01-01\n\nold\n',
      '## 1.1.0 — x\n\nnew\n',
    );
    expect(out.indexOf('1.1.0')).toBeLessThan(out.indexOf('1.0.0'));
    expect(out).toContain('intro');
  });
});

describe('cli', () => {
  it('cuts a release', () => {
    note('a.md', 'fixed', 'Fixed a thing.');
    note('b.md', 'breaking', 'Change your config.');
    note('c.md', 'new', 'A new thing.');
    note('d.md', 'improved', 'Faster.');
    const r = cli('1.0.0', '--date', '2026-10-20');
    expect(r.status).toBe(0);
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^# Changelog/);
    expect(changelog).toContain('## 1.0.0 — 2026-10-20');
    const order = ['Breaking', 'New', 'Improved', 'Fixed'].map((h) =>
      changelog.indexOf(`### ${h}`),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(read('release-notes.md')).toContain('- A new thing.');
    expect(read('release-notes.md')).not.toContain('1.0.0');
    expect(JSON.parse(read('apps/server/src/changelog.json'))).toEqual([
      {
        version: '1.0.0',
        date: '2026-10-20',
        entries: [
          { type: 'breaking', text: 'Change your config.' },
          { type: 'new', text: 'A new thing.' },
          { type: 'improved', text: 'Faster.' },
          { type: 'fixed', text: 'Fixed a thing.' },
        ],
      },
    ]);
    expect(existsSync(join(root, '.changes/a.md'))).toBe(false);
    expect(existsSync(join(root, '.changes/README.md'))).toBe(true);
  });

  it('sets the version in the root and app packages, not in the SDK', () => {
    const pkgs = ['', 'apps/server', 'apps/web', 'packages/shared', 'packages/contract'];
    for (const dir of [...pkgs, 'packages/sdk']) {
      mkdirSync(join(root, dir), { recursive: true });
      const version = dir === 'packages/sdk' ? '1.0.0' : '0.0.0';
      writeFileSync(
        join(root, dir, 'package.json'),
        `${JSON.stringify({ name: `x-${dir}`, version, private: true }, null, 2)}\n`,
      );
    }
    note('a.md', 'new', 'First.');
    const r = cli('0.1.0', '--date', '2026-10-26');
    expect(r.status).toBe(0);
    for (const dir of pkgs) {
      expect(read(join(dir, 'package.json'))).toBe(
        `${JSON.stringify({ name: `x-${dir}`, version: '0.1.0', private: true }, null, 2)}\n`,
      );
    }
    expect(JSON.parse(read('packages/sdk/package.json')).version).toBe('1.0.0');
  });

  it('refuses a version that is not newer than the current one, changing nothing', () => {
    writeFileSync(join(root, 'package.json'), '{\n  "version": "0.2.0"\n}\n');
    note('a.md', 'new', 'First.');
    const r = cli('0.1.0', '--date', '2026-10-26');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('0.1.0 is not newer than the current version 0.2.0');
    expect(existsSync(join(root, '.changes/a.md'))).toBe(true);
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(false);
  });

  it('keeps past versions, newest first', () => {
    note('a.md', 'new', 'One.');
    expect(cli('1.0.0', '--date', '2026-10-01').status).toBe(0);
    note('b.md', 'fixed', 'Two.');
    expect(cli('1.1.0-rc.1', '--date', '2026-10-02').status).toBe(0);
    const list = JSON.parse(read('apps/server/src/changelog.json'));
    expect(list.map((r: { version: string }) => r.version)).toEqual(['1.1.0-rc.1', '1.0.0']);
    const changelog = read('CHANGELOG.md');
    expect(changelog.indexOf('1.1.0-rc.1')).toBeLessThan(changelog.indexOf('## 1.0.0'));
  });

  it('refuses without notes', () => {
    const r = cli('1.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No release notes/);
  });

  it('refuses invalid semver', () => {
    note('a.md', 'new', 'One.');
    const r = cli('v1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/semver/);
    expect(existsSync(join(root, '.changes/a.md'))).toBe(true);
  });

  it('refuses a duplicate version and changes nothing', () => {
    note('a.md', 'new', 'One.');
    cli('1.0.0');
    note('b.md', 'new', 'Two.');
    const before = read('CHANGELOG.md');
    const r = cli('1.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(read('CHANGELOG.md')).toBe(before);
    expect(existsSync(join(root, '.changes/b.md'))).toBe(true);
  });

  it('refuses invalid notes naming the file', () => {
    note('good.md', 'new', 'Fine.');
    note('bad.md', 'oops', 'Text.');
    const r = cli('1.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bad.md');
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(false);
  });

  it('dry run prints and changes nothing', () => {
    note('a.md', 'new', 'One.');
    const r = cli('1.0.0', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('## 1.0.0');
    expect(r.stdout).toContain('One.');
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(false);
    expect(existsSync(join(root, 'release-notes.md'))).toBe(false);
    expect(existsSync(join(root, 'apps/server/src/changelog.json'))).toBe(false);
    expect(existsSync(join(root, '.changes/a.md'))).toBe(true);
  });
});
