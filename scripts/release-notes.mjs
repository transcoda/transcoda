// Cuts a release from the notes in .changes/*.md (see .changes/README.md) and sets the version in
// the app's package.json files (the server bundles it; see docs/releasing.md).
// Usage: node scripts/release-notes.mjs <version> [--date YYYY-MM-DD] [--dry-run]
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TYPES = ['breaking', 'new', 'improved', 'fixed'];
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

export function renderChangelogSection(version, date, entries) {
  return `## ${version} — ${date}\n\n${renderGroups(entries, 3)}`;
}

export function renderReleaseBody(entries) {
  return renderGroups(entries, 2);
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
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
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

  const entries = groupEntries(notes);
  const jsonPath = join(root, 'apps/server/src/changelog.json');
  const changelogPath = join(root, 'CHANGELOG.md');
  const json = updateChangelogJson(read(jsonPath), args.version, date, entries);
  const section = renderChangelogSection(args.version, date, entries);
  const changelog = prependChangelog(read(changelogPath), section);
  const body = renderReleaseBody(entries);

  if (args.dryRun) {
    return `Dry run: nothing written. Would consume ${files.length} note(s) and set version ${args.version} in ${packages.length} package.json file(s).\n\n--- CHANGELOG.md (new section) ---\n${section}\n--- release-notes.md ---\n${body}\n--- apps/server/src/changelog.json ---\n${json}`;
  }
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(changelogPath, changelog);
  writeFileSync(join(root, 'release-notes.md'), body);
  writeFileSync(jsonPath, json);
  for (const p of packages) writeFileSync(p, withVersion(read(p), args.version));
  for (const f of files) unlinkSync(join(changesDir, f));
  return `Release ${args.version} (${date}): ${files.length} note(s) written to CHANGELOG.md, release-notes.md and apps/server/src/changelog.json; notes removed; version set in ${packages.length} package.json file(s).`;
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
