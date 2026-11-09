// Cuts a release from the notes in .changes/*.md (see .changes/README.md) and sets the version in
// the app's package.json files (the server bundles it; see docs/releasing.md).
// Usage: node scripts/release-notes.mjs <version> [--date YYYY-MM-DD] [--dry-run]
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TYPES = ['breaking', 'new', 'improved', 'fixed'];
/** Optional prose and screenshots for a minor or major release, kept apart from the notes. */
export const HIGHLIGHTS = 'highlights.md';
export const IMAGES_DIR = 'images';
/** Image links in the highlights: Markdown `](images/x.png)` or HTML `src="images/x.png"`. */
const IMAGE_LINK = /(\]\(|src=")images\/([^)"\s]+)/g;
const HEADINGS = { breaking: 'Breaking', new: 'New', improved: 'Improved', fixed: 'Fixed' };
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
export function compareVersions(a, b) {
  const [, ...pa] = SEMVER.exec(a) ?? [];
  const [, ...pb] = SEMVER.exec(b) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const [ra, rb] = [pa[3], pb[3]];
  if (ra === undefined || rb === undefined) return (ra === undefined) - (rb === undefined);
  const ia = ra.split('.');
  const ib = rb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined || ib[i] === undefined) return ia[i] === undefined ? -1 : 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb) {
      const d = Number(ia[i]) - Number(ib[i]);
      if (d !== 0) return d;
    } else if (na !== nb) return na ? -1 : 1;
    else if (ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
}

/** The package.json text with its version set, keeping key order and two-space formatting. */
export function withVersion(text, version) {
  const pkg = JSON.parse(text);
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function isValidVersion(version) {
  return typeof version === 'string' && SEMVER.test(version);
}

export function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Same rules as scripts/check-release-note.mjs. Returns { type, text } or { error }. */
export function parseNote(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  const type = match ? /^type:\s*(\S+)\s*$/m.exec(match[1])?.[1] : undefined;
  const body = match ? match[2].trim().replace(/\s*\n\s*/g, ' ') : '';
  const errors = [];
  if (!type || !TYPES.includes(type)) {
    errors.push(`front matter needs "type:" set to one of ${TYPES.join(', ')}.`);
  }
  if (!body) errors.push('the note text is empty.');
  return errors.length > 0 ? { errors } : { type, text: body };
}

export function groupEntries(notes) {
  return TYPES.flatMap((type) =>
    notes.filter((n) => n.type === type).map(({ text }) => ({ type, text })),
  );
}

function renderGroups(entries, level) {
  return TYPES.map((type) => {
    const items = entries.filter((e) => e.type === type);
    if (items.length === 0) return '';
    return `${'#'.repeat(level)} ${HEADINGS[type]}\n\n${items.map((e) => `- ${e.text}`).join('\n')}\n`;
  })
    .filter(Boolean)
    .join('\n');
}

/** A final x.y.0 release (minor or major). Patches and pre-releases leave the highlights alone. */
export function takesHighlights(version) {
  const m = SEMVER.exec(version);
  return Boolean(m) && m[3] === '0' && m[4] === undefined;
}

/** Where a release's screenshots live once it is cut, relative to the repo root. */
export function releaseAssetsDir(version) {
  return `docs/releases/${version}`;
}

/**
 * Checks the highlights text against the files in .changes/images/ and points its image links at
 * docs/releases/<version>/. Returns { text } or { errors }.
 */
export function prepareHighlights(text, images, version) {
  const body = text.replace(/\r\n/g, '\n').trim();
  const errors = [];
  if (!body) errors.push(`.changes/${HIGHLIGHTS}: the text is empty.`);
  if (/^#{1,2} /m.test(body)) {
    errors.push(
      `.changes/${HIGHLIGHTS}: use ### or smaller headings; # and ## belong to the changelog.`,
    );
  }
  const used = new Set();
  for (const [, , name] of body.matchAll(IMAGE_LINK)) {
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
  return { text: body.replace(IMAGE_LINK, (_, lead, name) => `${lead}${dir}/${name}`) };
}

function withHighlights(highlights, groups) {
  return highlights ? `${highlights}\n\n${groups}` : groups;
}

export function renderChangelogSection(version, date, entries, highlights) {
  return `## ${version} — ${date}\n\n${withHighlights(highlights, renderGroups(entries, 3))}`;
}

export function renderReleaseBody(entries, highlights) {
  return withHighlights(highlights, renderGroups(entries, 2));
}

/** Inserts a section above the newest existing one (or creates the file with a header). */
export function prependChangelog(existing, section) {
  if (existing === undefined || existing.trim() === '') return `${CHANGELOG_HEADER}\n${section}`;
  const text = existing.replace(/\r\n/g, '\n');
  const at = text.search(/^## /m);
  if (at === -1) return `${text.replace(/\n*$/, '\n')}\n${section}`;
  return `${text.slice(0, at)}${section}\n${text.slice(at)}`;
}

export function updateChangelogJson(existingJson, version, date, entries) {
  let list = [];
  if (existingJson !== undefined && existingJson.trim() !== '') {
    try {
      list = JSON.parse(existingJson);
    } catch {
      throw new ReleaseError('apps/server/src/changelog.json is not valid JSON.');
    }
    if (!Array.isArray(list))
      throw new ReleaseError('apps/server/src/changelog.json must be an array.');
  }
  if (list.some((r) => r?.version === version)) {
    throw new ReleaseError(`Version ${version} already exists in apps/server/src/changelog.json.`);
  }
  return `${JSON.stringify([{ version, date, entries }, ...list], null, 2)}\n`;
}

export function parseArgs(argv) {
  const args = { dryRun: false, root: undefined, date: undefined, version: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a.startsWith('--')) throw new ReleaseError(`Unknown option ${a}.`);
    else if (args.version === undefined) args.version = a;
    else throw new ReleaseError(`Unexpected argument ${a}.`);
  }
  return args;
}

export function run(argv, now = new Date()) {
  const args = parseArgs(argv);
  const root = args.root ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!args.version) {
    throw new ReleaseError(
      'Usage: node scripts/release-notes.mjs <version> [--date YYYY-MM-DD] [--dry-run]',
    );
  }
  if (!isValidVersion(args.version)) {
    throw new ReleaseError(`"${args.version}" is not a valid semver version (for example 1.2.0).`);
  }
  const date = args.date ?? todayLocal(now);
  if (!isValidDate(date)) throw new ReleaseError(`"${date}" is not a valid date (use YYYY-MM-DD).`);

  const changesDir = join(root, '.changes');
  const files = existsSync(changesDir)
    ? readdirSync(changesDir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== HIGHLIGHTS)
        .sort()
    : [];
  if (files.length === 0) {
    throw new ReleaseError('No release notes found in .changes/ (nothing to release).');
  }
  const notes = [];
  const problems = [];
  for (const file of files) {
    const parsed = parseNote(readFileSync(join(changesDir, file), 'utf8'));
    if (parsed.errors) for (const e of parsed.errors) problems.push(`.changes/${file}: ${e}`);
    else notes.push(parsed);
  }
  if (problems.length > 0) throw new ReleaseError(problems.join('\n'));

  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  const packages = VERSIONED_PACKAGES.map((p) => join(root, p)).filter(existsSync);
  const current = packages.length > 0 ? JSON.parse(read(packages[0])).version : undefined;
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
  let highlights;
  if (takesHighlights(args.version)) {
    if (existsSync(highlightsPath)) {
      const prepared = prepareHighlights(read(highlightsPath), images, args.version);
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
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(changelogPath, changelog);
  writeFileSync(join(root, 'release-notes.md'), body);
  writeFileSync(jsonPath, json);
  for (const p of packages) writeFileSync(p, withVersion(read(p), args.version));
  for (const f of files) unlinkSync(join(changesDir, f));
  if (highlights) {
    if (moved.length > 0) {
      mkdirSync(join(root, assetsRel), { recursive: true });
      for (const f of moved) renameSync(join(imagesPath, f), join(root, assetsRel, f));
    }
    if (existsSync(imagesPath) && readdirSync(imagesPath).length === 0) rmdirSync(imagesPath);
    unlinkSync(highlightsPath);
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
