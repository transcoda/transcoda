// Every package the lockfiles resolve comes from the npm registry, or is the shared tooling
// (@transcoda/dev-config) from a pinned commit of transcoda/.github. Anything else (another
// registry, a tarball on some other host, a git or local-directory dependency) fails, so a
// pull request cannot swap in a package from elsewhere by editing the lockfile.
// - pnpm-lock.yaml: each `resolution: {...}` is integrity only (the registry), or a tarball on an
//   allowed URL. No git, directory or file: resolutions, and every URL in the file is allowed.
//   The check reads the lines as pnpm writes them and fails on what it cannot read that way:
//   double quotes or backslashes (quoted or escaped keys), a `resolution` or `tarball` key in
//   any other form.
// - docker/corepack/package-lock.json: a version 2 or 3 lockfile whose every `resolved` is an
//   allowed URL.
// - .npmrc and pnpm-workspace.yaml: no registry other than the npm registry (an integrity-only
//   resolution is fetched from whatever registry is configured), and no pnpmfile (it could
//   rewrite what gets installed).
// It has no dependencies, so CI runs it before `pnpm install` as well as in `pnpm check`.
// `node scripts/check-lockfile.ts [root]` checks another checkout.
// Exports the checks for tests; the CLI runs only when executed directly.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';
const ALLOWED_URLS = [
  /^https:\/\/registry\.npmjs\.org\/[^\s]+$/,
  /^https:\/\/codeload\.github\.com\/transcoda\/\.github\/tar\.gz\/[0-9a-f]{40}$/,
];
const RESOLUTION_FIELDS = ['integrity', 'tarball', 'gitHosted'];

export const allowedUrl = (url: string): boolean => ALLOWED_URLS.some((re) => re.test(url));

/** Problems in a pnpm-lock.yaml's text, each prefixed with its line number. */
export function checkPnpmLock(text: string): string[] {
  const problems: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const at = `line ${i + 1}`;
    if (/["\\]/.test(line)) {
      problems.push(`${at}: double quote or backslash, which pnpm does not write`);
      continue;
    }
    // A deprecation message is text pnpm shows, not a source; any other URL must be allowed.
    if (!/^\s*deprecated:/.test(line)) {
      for (const [url] of line.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s,}']+/gi)) {
        if (!allowedUrl(url)) problems.push(`${at}: ${url} is not on an allowed host`);
      }
    }
    const resolution = /^\s*resolution: \{([^{}]*)\}$/.exec(line);
    if (!resolution) {
      if (/(resolution|tarball)'?\s*:/.test(line)) {
        problems.push(`${at}: a resolution or tarball key not in pnpm's one-line form`);
      }
      continue;
    }
    const fields = new Map(
      (resolution[1] ?? '').split(', ').map((part) => {
        const [key = '', ...rest] = part.split(': ');
        return [key, rest.join(': ')] as const;
      }),
    );
    for (const [key, value] of fields) {
      if (!RESOLUTION_FIELDS.includes(key))
        problems.push(`${at}: resolution field ${key} (${value}) is not allowed`);
    }
    const tarball = fields.get('tarball');
    if (tarball !== undefined && !allowedUrl(tarball)) {
      problems.push(`${at}: tarball ${tarball} is not on an allowed host`);
    }
    if (!fields.has('integrity')) problems.push(`${at}: resolution has no integrity hash`);
  }
  return problems;
}

interface LockEntry {
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, LockEntry>;
}

/** Problems in an npm package-lock.json's text. */
export function checkPackageLock(text: string): string[] {
  const lock = JSON.parse(text) as {
    lockfileVersion?: number;
    packages?: Record<string, LockEntry>;
    dependencies?: Record<string, LockEntry>;
  };
  if (
    (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) ||
    typeof lock.packages !== 'object'
  ) {
    return ['not a version 2 or 3 lockfile with a packages object'];
  }
  const problems: string[] = [];
  const check = (path: string, entry: LockEntry, required: boolean) => {
    if (entry.link) return;
    if (entry.resolved === undefined) {
      if (required) problems.push(`${path}: no resolved URL`);
    } else if (!allowedUrl(entry.resolved)) {
      problems.push(`${path}: resolved ${entry.resolved} is not on an allowed host`);
    }
  };
  for (const [path, entry] of Object.entries(lock.packages))
    if (path !== '') check(path, entry, true);
  // Version 2 also keeps the old `dependencies` tree, which older npm reads.
  const walk = (deps: Record<string, LockEntry> | undefined, at: string) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      check(`${at}${name}`, entry, false);
      walk(entry.dependencies, `${at}${name} > `);
    }
  };
  walk(lock.dependencies, 'dependencies > ');
  return problems;
}

/** Problems in an .npmrc's text: any registry setting but the npm registry itself. */
export function checkNpmrc(text: string): string[] {
  const problems: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!/registry/i.test(line)) continue;
    const m = /^((?:@[a-z0-9][a-z0-9._-]*:)?registry)=(\S+)$/.exec(line.trim());
    if (!m || m[2]?.replace(/\/?$/, '/') !== REGISTRY) {
      problems.push(`line ${i + 1}: ${line.trim()} is not registry=${REGISTRY}`);
    }
  }
  return problems;
}

/** Problems in a pnpm-workspace.yaml's text: registries and pnpmfiles are set nowhere. */
export function checkWorkspace(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) =>
      /registr|pnpmfile/i.test(line)
        ? [`line ${i + 1}: ${line.trim()} (registries and pnpmfiles are not allowed)`]
        : [],
    );
}

/** Every problem in the repository's lockfiles and package-manager settings, prefixed with the file. */
export function checkLockfiles(root: string): string[] {
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const prefixed = (file: string, problems: string[]) => problems.map((p) => `${file} ${p}`);
  const problems = [
    ...prefixed('pnpm-lock.yaml', checkPnpmLock(read('pnpm-lock.yaml'))),
    ...prefixed(
      'docker/corepack/package-lock.json',
      checkPackageLock(read('docker/corepack/package-lock.json')),
    ),
    ...prefixed('pnpm-workspace.yaml', checkWorkspace(read('pnpm-workspace.yaml'))),
  ];
  if (existsSync(join(root, '.npmrc')))
    problems.push(...prefixed('.npmrc', checkNpmrc(read('.npmrc'))));
  for (const file of ['.pnpmfile.cjs', '.pnpmfile.mjs']) {
    if (existsSync(join(root, file)))
      problems.push(`${file}: a pnpmfile can rewrite what gets installed`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : join(fileURLToPath(import.meta.url), '..', '..');
  const problems = checkLockfiles(root);
  if (problems.length > 0) {
    console.error('Lockfile sources outside the npm registry and transcoda/.github:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('check-lockfile: ok');
}
