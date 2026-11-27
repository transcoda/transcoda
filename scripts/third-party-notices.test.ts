import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
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
  'ARG NODE_IMAGE=node:26.13-bookworm-slim',
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
  if (!found) throw new Error(`${id} is not collected`);
  return found;
};

it('licenceAllowed: SPDX expressions against the allow-list', () => {
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
    expect(licenceAllowed(expr), expr).toBe(expected);
  }
  for (const id of ALLOWED) expect(licenceAllowed(id), id).toBe(true);
});

it('collect skips @transcoda/*, finds LICENCE.md case-insensitively, appends NOTICE', () => {
  const entries = collect(sources());
  expect(entries.some((e) => e.name.startsWith('@transcoda/'))).toBe(false);
  const a = byId(entries, 'pkg-a@1.0.0');
  expect(a.text ?? '').toMatch(/^Apache-ish licence of pkg-a\n/);
  expect(a.text ?? '').toMatch(/\n\npkg-a NOTICE: includes code by Someone\n$/);
  expect(a.homepage).toBe('https://example.org/pkg-a');
  expect(a.usedBy).toEqual(['web']);
  expect(byId(entries, 'pkg-b@2.0.0').homepage).toBe(null);
  expect(byId(entries, 'pkg-b@10.0.0').usedBy).toEqual(['web', 'server']);
  expect(byId(entries, 'pkg-d@3.0.0').text).toBe(null);
});

it('collect applies overrides: a hand text, a corrected licence, an accepted exception', () => {
  const entries = collect(sources(), {
    licencesDir: join(fixtures, 'overrides'),
    overrides: {
      'pkg-d@3.0.0': { reason: 'no file in the package', text: 'pkg-d.txt' },
      'pkg-c': { reason: 'metadata says MIT, the file says GPL', licence: 'GPL-3.0-only' },
      'pkg-a': { reason: 'accepted after review', licence: 'LGPL-2.1', allow: true },
    },
  });
  expect(byId(entries, 'pkg-d@3.0.0').text).toBe('Hand-supplied licence text for pkg-d\n');
  expect(byId(entries, 'pkg-c@0.1.0').licence).toBe('GPL-3.0-only');
  expect(problems(entries)).toEqual(["pkg-c@0.1.0: license 'GPL-3.0-only' is not allowed"]);
});

it('render dedups identical texts to one key', () => {
  const parsed = JSON.parse(render(fixtureEntries()).json) as {
    packages: { name: string; textKey: string }[];
    texts: Record<string, string>;
  };
  const keyOf = (name: string) => parsed.packages.find((p) => p.name === name)?.textKey;
  expect(keyOf('pkg-b')).toBeTruthy();
  expect(keyOf('pkg-b')).toBe(keyOf('pkg-c'));
  expect(new Set(parsed.packages.map((p) => p.textKey)).size).toBe(
    Object.keys(parsed.texts).length,
  );
  expect(keyOf('pkg-a') ?? '').toMatch(/^sha256:[0-9a-f]{64}$/);
});

it('render is byte-identical on two runs, sorted, and carries no local path', () => {
  const first = render(fixtureEntries());
  const second = render(fixtureEntries().reverse());
  expect(first.json).toBe(second.json);
  expect(first.notices).toBe(second.notices);
  for (const out of [first.json, first.notices]) {
    expect(out).not.toMatch(/\/Users\/|\/home\/|node_modules/);
  }
  const names = (JSON.parse(first.json) as { packages: { name: string; version: string }[] })
    .packages;
  expect(names.filter((p) => p.name === 'pkg-b').map((p) => p.version)).toEqual([
    '2.0.0',
    '10.0.0',
  ]);
});

it('render matches the shared fixture (the shape system.licences serves)', () => {
  // Compared parsed: Biome formats the committed fixture; byte stability is the test above.
  const expected: unknown = JSON.parse(
    readFileSync(join(fixtures, 'expected-third-party.json'), 'utf8'),
  );
  expect(JSON.parse(render(fixtureEntries()).json)).toEqual(expected);
});

it('the notices file names Transcoda licence, then each component with its full text', () => {
  const { notices } = render(fixtureEntries());
  expect(notices).toMatch(/^Transcoda: third-party notices\n/);
  expect(notices).toMatch(/GPL-3\.0-only/);
  expect(notices).toMatch(/\npkg-a 1\.0\.0 — ISC \(https:\/\/example\.org\/pkg-a\)\n/);
  expect(notices).toMatch(/\njellyfin-ffmpeg 8\.1\.3-1-bookworm — GPL-3\.0-or-later .*\[image\]\n/);
  expect(notices).toMatch(/Hand-supplied licence text for pkg-d/);
});

it('imageEntries reads both ARGs from the real Dockerfile', () => {
  const entries = imageEntries(realDockerfile, handTexts);
  const node = entries.find((e) => e.name === 'Node.js');
  const ffmpeg = entries.find((e) => e.name === 'jellyfin-ffmpeg');
  const nodeArg = realDockerfile.match(/^ARG NODE_IMAGE=node:(\d+\.\d+(?:\.\d+)?)/m)?.[1];
  const ffmpegArg = realDockerfile.match(/^ARG JELLYFIN_FFMPEG_VERSION=(\S+)/m)?.[1];
  expect(nodeArg && ffmpegArg).toBeTruthy();
  expect(node?.version).toBe(nodeArg);
  expect(ffmpeg?.version).toBe(ffmpegArg);
  expect(ffmpeg?.licence).toBe('GPL-3.0-or-later');
  expect(ffmpeg?.text ?? '').toMatch(/github\.com\/jellyfin\/jellyfin-ffmpeg at tag v\d[\w.-]*\./);
  expect(ffmpeg?.text ?? '').toMatch(/hand text GPL-3\.0\.txt/);
  expect(entries.map((e) => [e.name, e.origin])).toEqual([
    ['jellyfin-ffmpeg', 'image'],
    ['Node.js', 'image'],
    [
      `Debian ${realDockerfile.match(/^ARG NODE_IMAGE=node:[\d.]+-([a-z]+)/m)?.[1]} base packages`,
      'image',
    ],
    ['lucide', 'vendored'],
  ]);
});

it('imageEntries fails loudly when an ARG is renamed', () => {
  expect(() =>
    imageEntries(realDockerfile.replace('ARG JELLYFIN_FFMPEG_VERSION', 'ARG FFMPEG'), handTexts),
  ).toThrow(/ARG JELLYFIN_FFMPEG_VERSION not found/);
  expect(() =>
    imageEntries(realDockerfile.replace('ARG NODE_IMAGE', 'ARG BASE_IMAGE'), handTexts),
  ).toThrow(/ARG NODE_IMAGE not found/);
});

it('problems names a package without text and a licence outside the list; image entries are exempt', () => {
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
  expect(problems([...entries, gpl, ...imageEntries(fakeDockerfile, handTexts)])).toEqual([
    "bad@1.0.0: license 'GPL-2.0' is not allowed",
    'pkg-d@3.0.0: no license text found',
  ]);
  expect(() => render(entries)).toThrow(/pkg-d@3\.0\.0: no license text found/);
});

it('the real overrides file has a reason for every entry and its texts exist', () => {
  const overrides = readOverrides();
  for (const [key, o] of Object.entries(overrides)) {
    expect(o.reason.length > 10, key).toBeTruthy();
    if (o.text)
      expect(readFileSync(join(root, 'scripts', 'licences', o.text), 'utf8'), key).toBeTruthy();
  }
});
