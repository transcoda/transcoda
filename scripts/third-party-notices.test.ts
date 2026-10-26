import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED,
  collect,
  type Entry,
  imageEntries,
  licenceAllowed,
  type PnpmLicences,
  type PnpmSource,
  problems,
  readOverrides,
  render,
} from './third-party-notices.ts';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const fixtures = join(root, 'scripts', 'fixtures', 'licences');
const realDockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8');

/** The fixture pnpm JSON with its relative package paths made absolute. */
const fixturePnpm = (): PnpmLicences => {
  const json = JSON.parse(
    readFileSync(join(fixtures, 'pnpm-licenses.json'), 'utf8'),
  ) as PnpmLicences;
  for (const pkgs of Object.values(json)) {
    for (const pkg of pkgs) pkg.paths = pkg.paths.map((p) => join(fixtures, p));
  }
  return json;
};

const sources = (): PnpmSource[] => [
  { usedBy: 'web', json: fixturePnpm() },
  { usedBy: 'server', json: { MIT: fixturePnpm().MIT ?? [] } },
];

const fixtureOverrides = {
  'pkg-d': { reason: 'ships no licence file; text from its repository', text: 'pkg-d.txt' },
};
const handTexts = (file: string) => `hand text ${file}\n`;
const fakeDockerfile = [
  'ARG NODE_IMAGE=node:24.22-bookworm-slim',
  'ARG JELLYFIN_FFMPEG_VERSION=8.1.3-1-bookworm',
].join('\n');

const fixtureEntries = (): Entry[] => [
  ...collect(sources(), {
    overrides: fixtureOverrides,
    licencesDir: join(fixtures, 'overrides'),
  }),
  ...imageEntries(fakeDockerfile, handTexts),
];

const byId = (entries: Entry[], id: string): Entry => {
  const found = entries.find((e) => `${e.name}@${e.version}` === id);
  assert.ok(found, `${id} is collected`);
  return found;
};

test('licenceAllowed: SPDX expressions against the allow-list', () => {
  const table: [string, boolean][] = [
    ['MIT', true],
    ['(MIT OR CC0-1.0)', true],
    ['(MIT AND GPL-3.0-only)', false],
    ['GPL-3.0-only', false],
    ['LGPL-2.1', false],
    ['AGPL-3.0', false],
    ['Apache-2.0 WITH LLVM-exception', false],
    ['Unknown', false],
    ['OFL-1.1', true],
    ['(GPL-2.0 OR MIT)', true],
    ['MIT AND (ISC OR GPL-3.0-only)', true],
    ['MIT AND (LGPL-2.1 OR GPL-3.0-only)', false],
    ['', false],
    ['(MIT', false],
    ['MIT OR', false],
  ];
  for (const [expr, expected] of table) {
    assert.equal(licenceAllowed(expr), expected, expr);
  }
  for (const id of ALLOWED) assert.equal(licenceAllowed(id), true, id);
});

test('collect skips @transcoda/*, finds LICENCE.md case-insensitively, appends NOTICE', () => {
  const entries = collect(sources());
  assert.equal(
    entries.some((e) => e.name.startsWith('@transcoda/')),
    false,
  );
  const a = byId(entries, 'pkg-a@1.0.0');
  assert.match(a.text ?? '', /^Apache-ish licence of pkg-a\n/);
  assert.match(a.text ?? '', /\n\npkg-a NOTICE: includes code by Someone\n$/);
  assert.equal(a.homepage, 'https://example.org/pkg-a');
  assert.deepEqual(a.usedBy, ['web']);
  assert.equal(byId(entries, 'pkg-b@2.0.0').homepage, null);
  assert.deepEqual(byId(entries, 'pkg-b@10.0.0').usedBy, ['web', 'server']);
  assert.equal(byId(entries, 'pkg-d@3.0.0').text, null);
});

test('collect applies overrides: a hand text, a corrected licence, an accepted exception', () => {
  const entries = collect(sources(), {
    licencesDir: join(fixtures, 'overrides'),
    overrides: {
      'pkg-d@3.0.0': { reason: 'no file in the package', text: 'pkg-d.txt' },
      'pkg-c': { reason: 'metadata says MIT, the file says GPL', licence: 'GPL-3.0-only' },
      'pkg-a': { reason: 'accepted after review', licence: 'LGPL-2.1', allow: true },
    },
  });
  assert.equal(byId(entries, 'pkg-d@3.0.0').text, 'Hand-supplied licence text for pkg-d\n');
  assert.equal(byId(entries, 'pkg-c@0.1.0').licence, 'GPL-3.0-only');
  assert.deepEqual(problems(entries), ["pkg-c@0.1.0: licence 'GPL-3.0-only' is not allowed"]);
});

test('render dedups identical texts to one key', () => {
  const parsed = JSON.parse(render(fixtureEntries()).json) as {
    packages: { name: string; textKey: string }[];
    texts: Record<string, string>;
  };
  const keyOf = (name: string) => parsed.packages.find((p) => p.name === name)?.textKey;
  assert.ok(keyOf('pkg-b'));
  assert.equal(keyOf('pkg-b'), keyOf('pkg-c'));
  assert.equal(
    new Set(parsed.packages.map((p) => p.textKey)).size,
    Object.keys(parsed.texts).length,
  );
  assert.match(keyOf('pkg-a') ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('render is byte-identical on two runs, sorted, and carries no local path', () => {
  const first = render(fixtureEntries());
  const second = render(fixtureEntries().reverse());
  assert.equal(first.json, second.json);
  assert.equal(first.notices, second.notices);
  for (const out of [first.json, first.notices]) {
    assert.doesNotMatch(out, /\/Users\/|\/home\/|node_modules/);
  }
  const names = (JSON.parse(first.json) as { packages: { name: string; version: string }[] })
    .packages;
  assert.deepEqual(
    names.filter((p) => p.name === 'pkg-b').map((p) => p.version),
    ['2.0.0', '10.0.0'],
  );
});

test('render matches the shared fixture (the shape system.licences serves)', () => {
  // Compared parsed: Biome formats the committed fixture; byte stability is the test above.
  const expected: unknown = JSON.parse(
    readFileSync(join(fixtures, 'expected-third-party.json'), 'utf8'),
  );
  assert.deepEqual(JSON.parse(render(fixtureEntries()).json), expected);
});

test('the notices file names Transcoda licence, then each component with its full text', () => {
  const { notices } = render(fixtureEntries());
  assert.match(notices, /^Transcoda: third-party notices\n/);
  assert.match(notices, /GPL-3\.0-only/);
  assert.match(notices, /\npkg-a 1\.0\.0 — ISC \(https:\/\/example\.org\/pkg-a\)\n/);
  assert.match(notices, /\njellyfin-ffmpeg 8\.1\.3-1-bookworm — GPL-3\.0-or-later .*\[image\]\n/);
  assert.match(notices, /Hand-supplied licence text for pkg-d/);
});

test('imageEntries reads both ARGs from the real Dockerfile', () => {
  const entries = imageEntries(realDockerfile, handTexts);
  const node = entries.find((e) => e.name === 'Node.js');
  const ffmpeg = entries.find((e) => e.name === 'jellyfin-ffmpeg');
  const nodeArg = realDockerfile.match(/^ARG NODE_IMAGE=node:(\d+\.\d+(?:\.\d+)?)/m)?.[1];
  const ffmpegArg = realDockerfile.match(/^ARG JELLYFIN_FFMPEG_VERSION=(\S+)/m)?.[1];
  assert.ok(nodeArg && ffmpegArg);
  assert.equal(node?.version, nodeArg);
  assert.equal(ffmpeg?.version, ffmpegArg);
  assert.equal(ffmpeg?.licence, 'GPL-3.0-or-later');
  assert.match(ffmpeg?.text ?? '', /github\.com\/jellyfin\/jellyfin-ffmpeg at tag v\d[\w.-]*\./);
  assert.match(ffmpeg?.text ?? '', /hand text GPL-3\.0\.txt/);
  assert.deepEqual(
    entries.map((e) => [e.name, e.origin]),
    [
      ['jellyfin-ffmpeg', 'image'],
      ['Node.js', 'image'],
      [
        `Debian ${realDockerfile.match(/^ARG NODE_IMAGE=node:[\d.]+-([a-z]+)/m)?.[1]} base packages`,
        'image',
      ],
      ['lucide', 'vendored'],
    ],
  );
});

test('imageEntries fails loudly when an ARG is renamed', () => {
  assert.throws(
    () =>
      imageEntries(realDockerfile.replace('ARG JELLYFIN_FFMPEG_VERSION', 'ARG FFMPEG'), handTexts),
    /ARG JELLYFIN_FFMPEG_VERSION not found/,
  );
  assert.throws(
    () => imageEntries(realDockerfile.replace('ARG NODE_IMAGE', 'ARG BASE_IMAGE'), handTexts),
    /ARG NODE_IMAGE not found/,
  );
});

test('problems names a package without text and a licence outside the list; image entries are exempt', () => {
  const entries = collect(sources());
  const gpl: Entry = {
    name: 'bad',
    version: '1.0.0',
    licence: 'GPL-2.0',
    homepage: null,
    origin: 'npm',
    usedBy: ['server'],
    text: 'GPL\n',
  };
  assert.deepEqual(problems([...entries, gpl, ...imageEntries(fakeDockerfile, handTexts)]), [
    "bad@1.0.0: licence 'GPL-2.0' is not allowed",
    'pkg-d@3.0.0: no licence text found',
  ]);
  assert.throws(() => render(entries), /pkg-d@3\.0\.0: no licence text found/);
});

test('the real overrides file has a reason for every entry and its texts exist', () => {
  const overrides = readOverrides();
  for (const [key, o] of Object.entries(overrides)) {
    assert.ok(o.reason.length > 10, key);
    if (o.text) assert.ok(readFileSync(join(root, 'scripts', 'licences', o.text), 'utf8'), key);
  }
});
