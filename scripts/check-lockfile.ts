// Every package the lockfiles resolve comes from the npm registry, or is the shared tooling
// (@transcoda/dev-config) from a pinned commit of transcoda/.github. Anything else (another
// registry, a tarball on some other host, a git or local-directory dependency) fails, so a
// pull request cannot swap in a package from elsewhere by editing the lockfile.
// - pnpm-lock.yaml: each `resolution: {...}` is integrity only (the registry), or a tarball on an
//   allowed URL. No git, directory or file: resolutions.
// - docker/corepack/package-lock.json: each `resolved` is an allowed URL.
// - .npmrc: no `registry=` (or `@scope:registry=`) other than the npm registry, since an
//   integrity-only resolution is fetched from whatever registry is configured.
// It has no dependencies, so CI runs it before `pnpm install` as well as in `pnpm check`.
// Exports the checks for tests; the CLI runs only when executed directly.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';
const ALLOWED_URLS = [
  /^https:\/\/registry\.npmjs\.org\/[^\s]+$/,
  /^https:\/\/codeload\.github\.com\/transcoda\/\.github\/tar\.gz\/[0-9a-f]{40}$/,
];

export const allowedUrl = (url: string): boolean => ALLOWED_URLS.some((re) => re.test(url));

/** Problems in a pnpm-lock.yaml's text, each prefixed with its line number. */
export function checkPnpmLock(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const at = `line ${i + 1}`;
    const tarballs = [...line.matchAll(/\btarball:\s*([^\s,}]+)/g)].map((m) => m[1] ?? '');
    for (const url of tarballs) {
      if (!allowedUrl(url)) problems.push(`${at}: tarball ${url} is not on an allowed host`);
    }
    if (!/^\s*resolution:/.test(line)) continue;
    const body = /^\s*resolution:\s*\{(.*)\}\s*$/.exec(line)?.[1];
    if (body === undefined) {
      problems.push(`${at}: resolution is not a one-line {...} map`);
      continue;
    }
    const fields = new Map(
      body.split(',').map((part) => {
        const [key = '', ...rest] = part.split(':');
        return [key.trim(), rest.join(':').trim()] as const;
      }),
    );
    for (const key of fields.keys()) {
      if (!['integrity', 'tarball', 'gitHosted'].includes(key)) {
        problems.push(`${at}: resolution field ${key} (${fields.get(key)}) is not allowed`);
      }
    }
    if (!fields.has('integrity')) problems.push(`${at}: resolution has no integrity hash`);
  }
  return problems;
}

/** Problems in an npm package-lock.json's text. */
export function checkPackageLock(text: string): string[] {
  const lock = JSON.parse(text) as {
    packages?: Record<string, { resolved?: string; link?: boolean }>;
  };
  const problems: string[] = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || entry.link) continue;
    if (entry.resolved === undefined) problems.push(`${path}: no resolved URL`);
    else if (!allowedUrl(entry.resolved)) {
      problems.push(`${path}: resolved ${entry.resolved} is not on an allowed host`);
    }
  }
  return problems;
}

/** Problems in an .npmrc's text: a registry other than the npm registry. */
export function checkNpmrc(text: string): string[] {
  const problems: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const m = /^\s*((?:@[^:\s]+:)?registry)\s*=\s*(\S+)\s*$/.exec(line);
    if (m && m[2]?.replace(/\/?$/, '/') !== REGISTRY) {
      problems.push(`line ${i + 1}: ${m[1]} is ${m[2]}, not ${REGISTRY}`);
    }
  }
  return problems;
}

/** Every problem in the repository's lockfiles and .npmrc, prefixed with the file. */
export function checkLockfiles(root: string): string[] {
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const prefixed = (file: string, problems: string[]) => problems.map((p) => `${file} ${p}`);
  const problems = [
    ...prefixed('pnpm-lock.yaml', checkPnpmLock(read('pnpm-lock.yaml'))),
    ...prefixed(
      'docker/corepack/package-lock.json',
      checkPackageLock(read('docker/corepack/package-lock.json')),
    ),
  ];
  if (existsSync(join(root, '.npmrc')))
    problems.push(...prefixed('.npmrc', checkNpmrc(read('.npmrc'))));
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const problems = checkLockfiles(root);
  if (problems.length > 0) {
    console.error('Lockfile sources outside the npm registry and transcoda/.github:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('check-lockfile: ok');
}
