// Cuts a release from the notes in .changes/*.md (see .changes/README.md) and sets the version in
// the app's package.json files (the server bundles it; see docs/releasing.md).
// Usage: node scripts/release-notes.ts <version> [--date YYYY-MM-DD] [--dry-run]
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entry } from '@transcoda/dev-config/changes';
// The note format, its checks and the grouping are shared with the plugins repository and the
// release-note check: @transcoda/dev-config (transcoda/.github, changes/notes.mjs).
import {
  groupEntries,
  HIGHLIGHTS,
  layoutOf,
  readNotes,
  renderGroups,
} from '@transcoda/dev-config/changes';

export const IMAGES_DIR = 'images';
/**
 * Image links in the highlights: Markdown `](images/x.png)` or `](<images/my shot.png>)`, or HTML
 * `src="images/x.png"`. Inside angle brackets the name runs to the `>` and may hold spaces.
 */
const IMAGE_LINK = /(\]\(<|\]\(|src=")images\/((?<=<images\/)[^>\n]+|[^)"\s]+)/g;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const CHANGELOG_HEADER =
  '# Changelog\n\nAll notable changes to Transcoda, newest first. Generated from the notes in `.changes/` when a release is cut.\n';

/** The packages that carry the app's version. The plugin SDK is versioned on its own. */
export const VERSIONED_PACKAGES = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
  'packages/contract/package.json',
];

export class ReleaseError extends Error {}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b (build metadata ignored). */
export function compareVersions(a: string, b: string): number {
  const [, ...pa] = SEMVER.exec(a) ?? [];
  const [, ...pb] = SEMVER.exec(b) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const [ra, rb] = [pa[3], pb[3]];
  if (ra === undefined || rb === undefined)
    return Number(ra === undefined) - Number(rb === undefined);
  const ia = ra.split('.');
  const ib = rb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const na = /^\d+$/.test(x);
    const nb = /^\d+$/.test(y);
    if (na && nb) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (na !== nb) return na ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The package.json text with its version set, keeping key order and two-space formatting. */
export function withVersion(text: string, version: string): string {
  const pkg = JSON.parse(text) as { version?: string };
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function isValidVersion(version: unknown): version is string {
  return typeof version === 'string' && SEMVER.test(version);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function todayLocal(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A final x.y.0 release (minor or major). Patches and pre-releases leave the highlights alone. */
export function takesHighlights(version: string): boolean {
  const m = SEMVER.exec(version);
  return m !== null && m[3] === '0' && m[4] === undefined;
}

/** Where a release's screenshots live once it is cut, relative to the repo root. */
export function releaseAssetsDir(version: string): string {
  return `docs/releases/${version}`;
}

/**
 * Checks the highlights text against the files in .changes/images/ and points its image links at
 * docs/releases/<version>/. Returns { text } or { errors }.
 */
export function prepareHighlights(
  text: string,
  images: string[],
  version: string,
): { text: string; errors?: undefined } | { errors: string[]; text?: undefined } {
  const body = text.replace(/\r\n/g, '\n').trim();
  const errors: string[] = [];
  if (!body) errors.push(`.changes/${HIGHLIGHTS}: the text is empty.`);
  if (/^#{1,3} /m.test(body)) {
    errors.push(
      `.changes/${HIGHLIGHTS}: use #### or smaller headings; #, ## and ### belong to the changelog.`,
    );
  }
  const used = new Set<string>();
  for (const [, , link = ''] of body.matchAll(IMAGE_LINK)) {
    // A link may URL-escape the file name (`my%20shot.png`); the file on disk is `my shot.png`.
    let name = link;
    try {
      name = decodeURIComponent(link);
    } catch {
      // Not valid escaping: compare the name as written.
    }
    used.add(name);
    if (!images.includes(name)) {
      errors.push(
        `.changes/${HIGHLIGHTS}: image ${IMAGES_DIR}/${name} is not in .changes/${IMAGES_DIR}/.`,
      );
    }
  }
  for (const name of images) {
    if (!used.has(name)) {
      errors.push(`.changes/${IMAGES_DIR}/${name} is not used in .changes/${HIGHLIGHTS}.`);
    }
  }
  if (errors.length > 0) return { errors };
  const dir = releaseAssetsDir(version);
  return {
    text: body.replace(
      IMAGE_LINK,
      (_: string, lead: string, name: string) => `${lead}${dir}/${name}`,
    ),
  };
}

function withHighlights(highlights: string | undefined, groups: string): string {
  return highlights ? `${highlights}\n\n${groups}` : groups;
}

export function renderChangelogSection(
  version: string,
  date: string,
  entries: Entry[],
  highlights?: string,
): string {
  return `## ${version} — ${date}\n\n${withHighlights(highlights, renderGroups(entries, 3))}`;
}

export function renderReleaseBody(entries: Entry[], highlights?: string): string {
  return withHighlights(highlights, renderGroups(entries, 2));
}

/** Inserts a section above the newest existing one (or creates the file with a header). */
export function prependChangelog(existing: string | undefined, section: string): string {
  if (existing === undefined || existing.trim() === '') return `${CHANGELOG_HEADER}\n${section}`;
  const text = existing.replace(/\r\n/g, '\n');
  const at = text.search(/^## /m);
  if (at === -1) return `${text.replace(/\n*$/, '\n')}\n${section}`;
  return `${text.slice(0, at)}${section}\n${text.slice(at)}`;
}

export function updateChangelogJson(
  existingJson: string | undefined,
  version: string,
  date: string,
  entries: Entry[],
): string {
  let list: unknown = [];
  if (existingJson !== undefined && existingJson.trim() !== '') {
    try {
      list = JSON.parse(existingJson);
    } catch {
      throw new ReleaseError('apps/server/src/changelog.json is not valid JSON.');
    }
    if (!Array.isArray(list))
      throw new ReleaseError('apps/server/src/changelog.json must be an array.');
  }
  const releases = list as { version?: unknown }[];
  if (releases.some((r) => r?.version === version)) {
    throw new ReleaseError(`Version ${version} already exists in apps/server/src/changelog.json.`);
  }
  return `${JSON.stringify([{ version, date, entries }, ...releases], null, 2)}\n`;
}

export interface Args {
  dryRun: boolean;
  root: string | undefined;
  date: string | undefined;
  version: string | undefined;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, root: undefined, date: undefined, version: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a.startsWith('--')) throw new ReleaseError(`Unknown option ${a}.`);
    else if (args.version === undefined) args.version = a;
    else throw new ReleaseError(`Unexpected argument ${a}.`);
  }
  return args;
}

export function run(argv: string[], now = new Date()): string {
  const args = parseArgs(argv);
  const root = args.root ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!args.version) {
    throw new ReleaseError(
      'Usage: node scripts/release-notes.ts <version> [--date YYYY-MM-DD] [--dry-run]',
    );
  }
  if (!isValidVersion(args.version)) {
    throw new ReleaseError(`"${args.version}" is not a valid semver version (for example 1.2.0).`);
  }
  const date = args.date ?? todayLocal(now);
  if (!isValidDate(date)) throw new ReleaseError(`"${date}" is not a valid date (use YYYY-MM-DD).`);

  const changesDir = join(root, '.changes');
  // The same checks as the release-note check and pnpm check: format, place, no hashes or PR numbers.
  const { notes, errors: problems } = readNotes(root, layoutOf(root));
  if (problems.length > 0) throw new ReleaseError(problems.join('\n'));
  if (notes.length === 0) {
    throw new ReleaseError('No release notes found in .changes/ (nothing to release).');
  }
  const files = notes.map((n) => n.path);

  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  const packages = VERSIONED_PACKAGES.map((p) => join(root, p)).filter(existsSync);
  const first = packages[0];
  const current: unknown = first
    ? (JSON.parse(read(first) ?? '{}') as { version?: unknown }).version
    : undefined;
  if (current && isValidVersion(current) && compareVersions(args.version, current) <= 0) {
    throw new ReleaseError(
      `${args.version} is not newer than the current version ${current} (${VERSIONED_PACKAGES[0]}).`,
    );
  }

  // Highlights and their screenshots go into minor and major releases only; a patch or
  // pre-release leaves them in .changes/ for the next one.
  const highlightsPath = join(changesDir, HIGHLIGHTS);
  const imagesPath = join(changesDir, IMAGES_DIR);
  const images = existsSync(imagesPath)
    ? readdirSync(imagesPath)
        .filter((f) => !f.startsWith('.'))
        .sort()
    : [];
  const assetsRel = releaseAssetsDir(args.version);
  let highlights: string | undefined;
  if (takesHighlights(args.version)) {
    if (existsSync(highlightsPath)) {
      const prepared = prepareHighlights(read(highlightsPath) ?? '', images, args.version);
      if (prepared.errors) throw new ReleaseError(prepared.errors.join('\n'));
      highlights = prepared.text;
    } else if (images.length > 0) {
      throw new ReleaseError(
        `.changes/${IMAGES_DIR}/ has images but there is no .changes/${HIGHLIGHTS} to show them.`,
      );
    }
    if (images.length > 0 && existsSync(join(root, assetsRel))) {
      throw new ReleaseError(`${assetsRel}/ already exists.`);
    }
  }
  const moved = highlights ? images : [];

  const entries = groupEntries(notes);
  const jsonPath = join(root, 'apps/server/src/changelog.json');
  const changelogPath = join(root, 'CHANGELOG.md');
  const json = updateChangelogJson(read(jsonPath), args.version, date, entries);
  const section = renderChangelogSection(args.version, date, entries, highlights);
  const changelog = prependChangelog(read(changelogPath), section);
  const body = renderReleaseBody(entries, highlights);
  const highlightsNote = highlights
    ? ` with highlights and ${moved.length} image(s) in ${assetsRel}/`
    : existsSync(highlightsPath)
      ? ` (.changes/${HIGHLIGHTS} kept for the next minor release)`
      : '';

  if (args.dryRun) {
    return `Dry run: nothing written. Would consume ${files.length} note(s)${highlightsNote} and set version ${args.version} in ${packages.length} package.json file(s).\n\n--- CHANGELOG.md (new section) ---\n${section}\n--- release-notes.md ---\n${body}\n--- apps/server/src/changelog.json ---\n${json}`;
  }
  // Every change below is undone if a later one fails, so a failed release can simply be run again.
  // Each undo step is recorded before its change runs, since a write can fail half done.
  const undo: (() => void)[] = [];
  const write = (p: string, text: string) => {
    const before = read(p);
    undo.push(() => (before === undefined ? rmSync(p, { force: true }) : writeFileSync(p, before)));
    writeFileSync(p, text);
  };
  const remove = (p: string) => {
    const before = readFileSync(p);
    unlinkSync(p);
    undo.push(() => writeFileSync(p, before));
  };
  try {
    if (moved.length > 0) {
      const assetsDir = join(root, assetsRel);
      const parents: string[] = [];
      for (let d = assetsDir; !existsSync(d); d = dirname(d)) parents.push(d);
      undo.push(() => {
        for (const d of parents) if (existsSync(d)) rmdirSync(d);
      });
      mkdirSync(assetsDir, { recursive: true });
      for (const f of moved) {
        renameSync(join(imagesPath, f), join(assetsDir, f));
        undo.push(() => renameSync(join(assetsDir, f), join(imagesPath, f)));
      }
    }
    const jsonDir = dirname(jsonPath);
    if (!existsSync(jsonDir)) {
      undo.push(() => rmSync(jsonDir, { recursive: true, force: true }));
      mkdirSync(jsonDir, { recursive: true });
    }
    write(changelogPath, changelog);
    write(join(root, 'release-notes.md'), body);
    write(jsonPath, json);
    for (const p of packages) write(p, withVersion(read(p) ?? '{}', args.version));
    for (const f of files) remove(join(root, f));
    if (highlights) {
      if (existsSync(imagesPath) && readdirSync(imagesPath).length === 0) {
        rmdirSync(imagesPath);
        undo.push(() => mkdirSync(imagesPath));
      }
      remove(highlightsPath);
    }
  } catch (error) {
    const failed: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (undoError) {
        failed.push(undoError instanceof Error ? undoError.message : String(undoError));
      }
    }
    if (failed.length > 0) {
      throw new ReleaseError(
        `${error instanceof Error ? error.message : String(error)}\nUndoing the release also failed, so check the working tree (git status):\n${failed.join('\n')}`,
      );
    }
    throw error;
  }
  return `Release ${args.version} (${date}): ${files.length} note(s)${highlightsNote} written to CHANGELOG.md, release-notes.md and apps/server/src/changelog.json; notes removed; version set in ${packages.length} package.json file(s).`;
}

if (import.meta.main) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
