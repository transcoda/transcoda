// Third-party notices: node scripts/third-party-notices.ts [--check] [--out <dir>]
//
// Builds third-party.json and THIRD_PARTY_NOTICES.txt from the production dependency tree of the
// web UI and the server (`pnpm licenses list --json --prod`, one run per app so each entry knows
// who uses it) plus hand-maintained entries for what the Docker image ships beside the npm tree
// (jellyfin-ffmpeg, Node.js, the Debian base) and for vendored code (lucide icon path data).
//
// Every npm licence must pass the allow-list (ALLOWED, SPDX expressions) and every entry needs a
// licence text; otherwise the run fails and nothing is written. `--check` writes nothing (part of
// `pnpm check`). An exception, a corrected licence or a hand-supplied text goes in
// scripts/licences/overrides.json, always with a reason. The output is reproducible: sorted, no
// timestamps, no paths. Run by Node's type stripping, so only erasable TypeScript syntax here.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Origin = 'npm' | 'image' | 'vendored';
export type UsedBy = 'web' | 'server' | 'image';

/** One package of `pnpm licenses list --json`, grouped there by licence. */
export interface PnpmPackage {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage?: string | undefined;
}
export type PnpmLicences = Record<string, PnpmPackage[]>;
export interface PnpmSource {
  usedBy: 'web' | 'server';
  json: PnpmLicences;
}

export interface Entry {
  name: string;
  version: string;
  licence: string;
  homepage: string | null;
  origin: Origin;
  usedBy: UsedBy[];
  /** Full licence text (+ NOTICE); null when none was found. */
  text: string | null;
  /** overrides.json reason when a licence outside the allow-list is accepted. */
  exception?: string | undefined;
}

/** overrides.json: key `name` or `name@version`; keys starting with `$` are comments. */
export interface Override {
  reason: string;
  /** Replaces the licence pnpm reports (wrong or missing package metadata). */
  licence?: string | undefined;
  /** A text file under scripts/licences/, used when the package ships none. */
  text?: string | undefined;
  /** Accepts a licence outside the allow-list (an exception, with its reason). */
  allow?: boolean | undefined;
}
export type Overrides = Record<string, Override>;

export const ALLOWED: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'MPL-2.0',
  'Python-2.0',
  'OFL-1.1',
]);

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const LICENCES_DIR = join(ROOT, 'scripts', 'licences');
const RULE = '='.repeat(78);

/** SPDX expression check: OR passes if any side passes, AND only if all do, WITH and unknown ids fail. */
export function licenceAllowed(expr: string): boolean {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const isOp = (t: string | undefined, op: string): boolean => t?.toUpperCase() === op;
  const fail = (): never => {
    throw new Error(`bad SPDX expression: ${expr}`);
  };
  const atom = (): boolean => {
    const t = tokens[pos++];
    if (t === undefined || t === ')' || isOp(t, 'AND') || isOp(t, 'OR') || isOp(t, 'WITH')) {
      return fail();
    }
    if (t === '(') {
      const value = or();
      if (tokens[pos++] !== ')') fail();
      return value;
    }
    if (isOp(peek(), 'WITH')) {
      pos += 1;
      if (tokens[pos++] === undefined) fail();
      return false;
    }
    return ALLOWED.has(t);
  };
  const and = (): boolean => {
    let value = atom();
    while (isOp(peek(), 'AND')) {
      pos += 1;
      value = atom() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (isOp(peek(), 'OR')) {
      pos += 1;
      value = and() || value;
    }
    return value;
  };
  try {
    const value = or();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}

const LICENCE_FILE = /^(licen[cs]e|copying)([-.][\w.-]+)?$/i;
const NOTICE_FILE = /^notice([-.][\w.-]+)?$/i;
const CODE_FILE = /\.(c|m)?(js|ts)$|\.json$/i;

const normalise = (text: string): string => `${text.replace(/\r\n?/g, '\n').trimEnd()}\n`;

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Licence files of one package directory (concatenated in name order), NOTICE files appended. */
export function readLicenceText(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).sort(byCodePoint);
  } catch {
    return null;
  }
  const read = (pattern: RegExp): string[] =>
    names
      .filter((n) => pattern.test(n) && !CODE_FILE.test(n) && statSync(join(dir, n)).isFile())
      .map((n) => normalise(readFileSync(join(dir, n), 'utf8')));
  const licences = read(LICENCE_FILE);
  if (licences.length === 0) return null;
  return normalise([...licences, ...read(NOTICE_FILE)].join('\n'));
}

export interface CollectOptions {
  readText?: ((dir: string) => string | null) | undefined;
  overrides?: Overrides | undefined;
  licencesDir?: string | undefined;
}

/** pnpm licenses JSON (web and server, --prod) → entries; skips @transcoda/*; applies overrides. */
export function collect(sources: readonly PnpmSource[], options: CollectOptions = {}): Entry[] {
  const readText = options.readText ?? readLicenceText;
  const overrides = options.overrides ?? {};
  const licencesDir = options.licencesDir ?? LICENCES_DIR;
  const entries = new Map<string, Entry>();
  for (const { usedBy, json } of sources) {
    for (const pkg of Object.values(json).flat()) {
      if (pkg.name.startsWith('@transcoda/')) continue;
      pkg.versions.forEach((version, i) => {
        const key = `${pkg.name}@${version}`;
        const existing = entries.get(key);
        if (existing) {
          if (!existing.usedBy.includes(usedBy)) existing.usedBy.push(usedBy);
          return;
        }
        const override = overrides[key] ?? overrides[pkg.name];
        const dir = pkg.paths[i];
        let text = dir === undefined ? null : readText(dir);
        if (override?.text !== undefined) {
          text = normalise(readFileSync(join(licencesDir, override.text), 'utf8'));
        }
        entries.set(key, {
          name: pkg.name,
          version,
          licence: override?.licence ?? pkg.license,
          homepage: pkg.homepage || null,
          origin: 'npm',
          usedBy: [usedBy],
          text,
          exception: override?.allow === true ? override.reason : undefined,
        });
      });
    }
  }
  return [...entries.values()];
}

/** Reads a hand-maintained text by file name (under scripts/licences/). */
export type HandTexts = (file: string) => string;
export const readHandText: HandTexts = (file) =>
  normalise(readFileSync(join(LICENCES_DIR, file), 'utf8'));

const dockerArg = (dockerfile: string, name: string): string => {
  const match = dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)\\s*$`, 'm'));
  if (!match?.[1]) {
    throw new Error(`docker/Dockerfile: ARG ${name} not found (renamed? update imageEntries)`);
  }
  return match[1];
};

/** The image's entries, versions read from docker/Dockerfile ARGs (NODE_IMAGE, JELLYFIN_FFMPEG_VERSION). */
export function imageEntries(dockerfile: string, texts: HandTexts): Entry[] {
  const nodeImage = dockerArg(dockerfile, 'NODE_IMAGE');
  const nodeMatch = nodeImage.match(/^node:(\d+\.\d+(?:\.\d+)?)-([a-z]+)/);
  const nodeVersion = nodeMatch?.[1];
  const debian = nodeMatch?.[2];
  if (!nodeVersion || !debian) {
    throw new Error(`docker/Dockerfile: NODE_IMAGE ${nodeImage} is not node:<version>-<debian>`);
  }
  const ffmpeg = dockerArg(dockerfile, 'JELLYFIN_FFMPEG_VERSION');
  const ffmpegTag = `v${ffmpeg.replace(`-${debian}`, '')}`;
  const nodeTag = nodeVersion.split('.').length === 2 ? `v${nodeVersion}.0` : `v${nodeVersion}`;
  return [
    {
      name: 'jellyfin-ffmpeg',
      version: ffmpeg,
      licence: 'GPL-3.0-or-later',
      homepage: 'https://github.com/jellyfin/jellyfin-ffmpeg',
      origin: 'image',
      usedBy: ['image'],
      text: normalise(
        [
          'jellyfin-ffmpeg is a separate program in the image (/usr/lib/jellyfin-ffmpeg/ffmpeg),',
          'installed from the Jellyfin Debian repository and run by Transcoda as a process.',
          `Its source code: https://github.com/jellyfin/jellyfin-ffmpeg at tag ${ffmpegTag}.`,
          '',
          texts('GPL-3.0.txt'),
        ].join('\n'),
      ),
    },
    {
      name: 'Node.js',
      version: nodeVersion,
      licence: 'MIT',
      homepage: 'https://nodejs.org',
      origin: 'image',
      usedBy: ['image'],
      text: normalise(
        [
          `Node.js ${nodeVersion} (the image's ${nodeImage} base; \`node --version\` in the`,
          'container names the exact release) is licensed under the MIT licence and bundles',
          'third-party components under their own licences. The full text, with every bundled',
          `component, is the LICENSE file of that release, for example`,
          `https://github.com/nodejs/node/blob/${nodeTag}/LICENSE`,
        ].join('\n'),
      ),
    },
    {
      name: `Debian ${debian} base packages`,
      version: debian,
      licence: 'Various',
      homepage: 'https://www.debian.org',
      origin: 'image',
      usedBy: ['image'],
      text: normalise(
        [
          `The image is based on Debian ${debian} (${nodeImage}) and adds Debian packages`,
          '(ca-certificates, tini, procps and the libraries jellyfin-ffmpeg needs). Each package',
          'carries its own licence; its copyright file is in the image at',
          '/usr/share/doc/<package>/copyright.',
        ].join('\n'),
      ),
    },
    {
      name: 'lucide',
      version: 'path data',
      licence: 'ISC',
      homepage: 'https://lucide.dev',
      origin: 'vendored',
      usedBy: ['web'],
      text: normalise(
        [
          'Icon path data copied into apps/web/src/components/Icon.tsx.',
          '',
          texts('lucide-ISC.txt'),
        ].join('\n'),
      ),
    },
  ];
}

const compareEntries = (a: Entry, b: Entry): number =>
  byCodePoint(a.name.toLowerCase(), b.name.toLowerCase()) ||
  byCodePoint(a.name, b.name) ||
  a.version.localeCompare(b.version, 'en', { numeric: true }) ||
  byCodePoint(a.version, b.version);

const textKey = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

const USED_BY_ORDER: readonly UsedBy[] = ['web', 'server', 'image'];

export function render(entries: Entry[]): { json: string; notices: string } {
  const sorted = [...entries].sort(compareEntries);
  const texts = new Map<string, string>();
  const packages = sorted.map((e) => {
    if (e.text === null) throw new Error(`${e.name}@${e.version}: no licence text found`);
    const key = textKey(e.text);
    texts.set(key, e.text);
    return {
      name: e.name,
      version: e.version,
      licence: e.licence,
      homepage: e.homepage,
      origin: e.origin,
      usedBy: USED_BY_ORDER.filter((u) => e.usedBy.includes(u)),
      textKey: key,
    };
  });
  const sortedTexts = Object.fromEntries(
    [...texts.entries()].sort(([a], [b]) => byCodePoint(a, b)),
  );
  const json = `${JSON.stringify({ format: 1, packages, texts: sortedTexts }, null, 2)}\n`;

  const header = [
    'Transcoda: third-party notices',
    '',
    'Transcoda is free software under the GNU General Public License, version 3 only',
    '(GPL-3.0-only); see the LICENSE file of the source code,',
    'https://github.com/transcoda/transcoda/blob/main/LICENSE.',
    '',
    'It is built on the components below. Each is listed with its version, its licence and',
    'the full licence text.',
  ].join('\n');
  const blocks = sorted.map((e) => {
    const where = e.homepage ? ` (${e.homepage})` : '';
    const tag = e.origin === 'npm' ? '' : ` [${e.origin}]`;
    return `${RULE}\n${e.name} ${e.version} — ${e.licence}${where}${tag}\n${RULE}\n\n${e.text}`;
  });
  const notices = `${[header, ...blocks].join('\n\n').trimEnd()}\n`;
  return { json, notices };
}

export function problems(entries: Entry[]): string[] {
  const out: string[] = [];
  for (const e of [...entries].sort(compareEntries)) {
    const id = `${e.name}@${e.version}`;
    if (e.origin === 'npm' && e.exception === undefined && !licenceAllowed(e.licence)) {
      out.push(`${id}: licence '${e.licence}' is not allowed`);
    }
    if (e.text === null) out.push(`${id}: no licence text found`);
  }
  return out;
}

export function readOverrides(file = join(LICENCES_DIR, 'overrides.json')): Overrides {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Override>;
  const out: Overrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    if (typeof value?.reason !== 'string' || value.reason.trim() === '') {
      throw new Error(`overrides.json: ${key} has no reason`);
    }
    out[key] = value;
  }
  return out;
}

function pnpmLicences(filter: string): PnpmLicences {
  const out = execFileSync('pnpm', ['--filter', filter, 'licenses', 'list', '--json', '--prod'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as PnpmLicences;
}

function main(argv: string[]): number {
  const check = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const outDir = resolve(outIndex >= 0 ? (argv[outIndex + 1] ?? '') : join(ROOT, 'apps', 'server'));
  const entries = [
    ...collect(
      [
        { usedBy: 'web', json: pnpmLicences('@transcoda/web') },
        { usedBy: 'server', json: pnpmLicences('@transcoda/server') },
      ],
      { overrides: readOverrides() },
    ),
    ...imageEntries(readFileSync(join(ROOT, 'docker', 'Dockerfile'), 'utf8'), readHandText),
  ];
  const found = problems(entries);
  if (found.length > 0) {
    console.error('Third-party licence problems (see scripts/licences/overrides.json):');
    for (const p of found) console.error(`  - ${p}`);
    return 1;
  }
  if (check) {
    console.log(`check-licences: ok (${entries.length} components)`);
    return 0;
  }
  const { json, notices } = render(entries);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'third-party.json'), json);
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), notices);
  console.log(`notices: ${entries.length} components → third-party.json, THIRD_PARTY_NOTICES.txt`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
