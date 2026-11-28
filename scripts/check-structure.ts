// Enforces the source layout in docs/dev/structure.md:
// - Rule A: layers. A production file imports only from its own layer or lower ones (LAYERS).
// - Rule B: a module folder (`verify/` holding `verify.ts`) is entered through that file only.
// - No `index.ts` barrels, except the registries (REGISTRIES) and package entry points.
// - Rule C: production code never imports test code; test support is named `testing`.
// - Web: only App.tsx imports a page.
// - Folder names, small folders, test names, the soft size limit for source files.
// - Every back-ticked path in AGENTS.md and docs/dev/*.md exists.
// What breaks a rule today is listed in scripts/structure-allowlist.json; those lists only shrink.
// Exports checkStructure(root) for tests; the CLI runs only when executed directly.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importSpecifiers } from './check-deps.ts';

export interface Layer {
  name: string;
  /** Paths relative to the app's `src/`. An entry matches every path that starts with it. */
  paths: string[];
}

/**
 * The layers of each app, bottom first. A file is in the layer whose entry is the longest prefix of
 * its path. Entries marked "today" are where files sit before the move that takes them to the
 * entry above them; the move removes the "today" entry. An entry for a folder that does not exist
 * yet is fine: it matches nothing.
 */
export const LAYERS: Record<string, Layer[]> = {
  'apps/server/src': [
    { name: 'platform', paths: ['platform/'] },
    { name: 'engine/model', paths: ['engine/model/'] },
    { name: 'db', paths: ['db/'] },
    { name: 'engine/events', paths: ['engine/events.ts'] },
    { name: 'capabilities', paths: ['capabilities/'] },
    { name: 'auth', paths: ['auth/'] },
    { name: 'engine/files', paths: ['engine/files/'] },
    { name: 'engine/media', paths: ['engine/media/'] },
    { name: 'engine/encode', paths: ['engine/encode/'] },
    { name: 'engine/verify', paths: ['engine/verify/'] },
    { name: 'nodes', paths: ['nodes/'] },
    { name: 'workflows', paths: ['workflows/'] },
    { name: 'plugin-host', paths: ['plugin-host/'] },
    { name: 'plugins', paths: ['plugins/'] },
    { name: 'engine/walk', paths: ['engine/walk/'] },
    { name: 'engine/queue', paths: ['engine/queue/'] },
    { name: 'engine/pipeline', paths: ['engine/pipeline/'] },
    // engine.ts (EngineService) and anything else left directly in engine/.
    { name: 'engine', paths: ['engine/'] },
    { name: 'metrics', paths: ['metrics/'] },
    { name: 'settings', paths: ['settings.ts', 'settings/'] },
    { name: 'system', paths: ['system/'] },
    { name: 'rpc', paths: ['rpc/'] },
    { name: 'http', paths: ['http/'] },
    { name: 'mcp', paths: ['mcp/'] },
    { name: 'app', paths: ['app/'] },
    { name: 'main', paths: ['main.ts'] },
  ],
  'apps/web/src': [
    // The shared layer imports no feature.
    {
      name: 'shared',
      paths: ['components/', 'hooks/', 'lib/', 'api/', 'data/', 'assets/', 'styles/'],
    },
    // Features may import each other (Biome's noImportCycles keeps that acyclic).
    {
      name: 'features',
      paths: [
        'shell/',
        'auth/',
        'workflows/',
        'editor/',
        'jobs/',
        'libraries/',
        'plugins/',
        'recycle/',
        'settings/',
        // today: pages/ moves into the features.
        'pages/',
      ],
    },
    { name: 'app', paths: ['App.tsx', 'main.tsx'] },
  ],
};

/** The only `index.ts` files allowed: registries, lists of things in order. */
export const REGISTRIES = [
  'apps/server/src/nodes/core/index.ts',
  'apps/server/src/db/migrations/index.ts',
  'apps/server/src/mcp/tools/index.ts',
];

/** The one file that imports pages, and folders that are part of a page today. */
const APP_ROUTES = 'apps/web/src/App.tsx';
export const PAGE_PARTS: Record<string, string> = {};

export const SOFT_MAX_LINES = 800;
export const ALLOWLIST = 'scripts/structure-allowlist.json';
const DOCS = 'docs/dev/structure.md';
/**
 * Docs whose paths are not checked. structure.md describes the target layout, so it names folders
 * that do not exist yet; it joins the check once the migration is done.
 */
const DOC_PATHS_SKIP = [DOCS];

/** The lists in the allowlist file. Each holds what breaks one rule today. */
export interface Allowlist {
  upwardImports: string[];
  moduleEntryImports: string[];
  barrels: string[];
  testSupportImports: string[];
  testSupportNames: string[];
  pageImports: string[];
  folderNames: string[];
  smallFolders: string[];
  orphanTests: string[];
  softSizeLimit: Record<string, number>;
  docPaths: string[];
}

type ListRule = Exclude<keyof Allowlist, 'softSizeLimit'>;

const LIST_RULES: ListRule[] = [
  'upwardImports',
  'moduleEntryImports',
  'barrels',
  'testSupportImports',
  'testSupportNames',
  'pageImports',
  'folderNames',
  'smallFolders',
  'orphanTests',
  'docPaths',
];

export const emptyAllowlist = (): Allowlist => ({
  upwardImports: [],
  moduleEntryImports: [],
  barrels: [],
  testSupportImports: [],
  testSupportNames: [],
  pageImports: [],
  folderNames: [],
  smallFolders: [],
  orphanTests: [],
  softSizeLimit: {},
  docPaths: [],
});

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.local', 'coverage', '.turbo']);
const CODE = /\.(?:[cm]?[jt]s|tsx)$/;
const SOURCE = /\.(?:[cm]?[jt]s|tsx|css)$/;
const isTest = (p: string) => /\.test\.[cm]?[jt]sx?$/.test(p);
const isDts = (p: string) => p.endsWith('.d.ts');
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const parent = (p: string) => p.slice(0, p.lastIndexOf('/'));
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

/** Lines as an editor counts them, the same count as `pnpm check-file-size`. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** Test support by name: a `testing.ts(x)` file, or anything in a `testing/` or `fixtures/` folder. */
export const isTestSupportPath = (p: string) =>
  /(?:^|\/)testing\.[cm]?[jt]sx?$/.test(p) || /(?:^|\/)(?:testing|fixtures)\//.test(p);

function walkFiles(root: string, dir: string, out: string[]) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(root, path, out);
    else out.push(path);
  }
}

/** `apps/<name>/src` and `packages/<name>/src`: the trees the rules apply to. */
function srcRoots(root: string): string[] {
  const roots: string[] = [];
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group)).sort()) {
      if (existsSync(join(root, group, name, 'src'))) roots.push(`${group}/${name}/src`);
    }
  }
  return roots;
}

/**
 * Each workspace package's entry points, by specifier (`@transcoda/shared/testing`) and file
 * (package.json `exports` and `main`). An entry point may be called index.ts.
 */
function packageEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group))) {
      const pkgPath = join(root, group, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        main?: string;
        exports?: unknown;
      };
      const collect = (sub: string, v: unknown) => {
        if (typeof v === 'string')
          entries.set(posix.join(pkg.name ?? name, sub), posix.join(group, name, v));
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) collect(k.startsWith('.') ? k : sub, x);
        }
      };
      collect('.', pkg.main);
      collect('.', pkg.exports);
    }
  }
  return entries;
}

function layerOf(path: string): { app: string; index: number; name: string } | null {
  for (const [app, layers] of Object.entries(LAYERS)) {
    if (!path.startsWith(`${app}/`)) continue;
    const rel = path.slice(app.length + 1);
    let best: { index: number; length: number } | null = null;
    layers.forEach((layer, index) => {
      for (const p of layer.paths) {
        if (rel.startsWith(p) && (!best || p.length > best.length))
          best = { index, length: p.length };
      }
    });
    if (!best) return { app, index: -1, name: '' };
    const { index } = best as { index: number };
    return { app, index, name: layers[index]?.name ?? '' };
  }
  return null;
}

/** The page a web file belongs to: a `*Page/` module folder, a `*Page.tsx` file, or PAGE_PARTS. */
function pageOf(path: string): string | null {
  if (!path.startsWith('apps/web/src/')) return null;
  const parts = path.split('/');
  for (let i = 3; i < parts.length - 1; i++) {
    const name = parts[i] ?? '';
    if (PASCAL.test(name) && name.endsWith('Page')) return parts.slice(0, i + 1).join('/');
  }
  for (const [prefix, page] of Object.entries(PAGE_PARTS)) if (path.startsWith(prefix)) return page;
  if (/^[A-Z][A-Za-z0-9]*Page\.tsx$/.test(base(path))) return path;
  return null;
}

export interface Problem {
  rule: ListRule;
  key: string;
  message: string;
}

function readAllowlist(root: string): Allowlist {
  const path = join(root, ALLOWLIST);
  if (!existsSync(path)) return emptyAllowlist();
  return { ...emptyAllowlist(), ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<Allowlist>) };
}

export interface Findings {
  /** What breaks a rule that has an allowlist, keyed as the allowlist keys it. */
  problems: Problem[];
  /** Lines of every source file the soft size limit applies to. */
  sizes: Map<string, number>;
  /** Failures no allowlist can hold. */
  errors: string[];
}

/** Everything that breaks a rule today, before the allowlist is applied. */
export function findProblems(root: string, allowlist: Allowlist): Findings {
  const roots = srcRoots(root);
  const inRoots = (p: string) => roots.some((r) => p.startsWith(`${r}/`));

  // Every file the rules look at, and the files that only import them (scripts, e2e).
  const files: string[] = [];
  for (const r of roots) walkFiles(root, r, files);
  const importerOnly: string[] = [];
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group))) {
      walkFiles(root, `${group}/${name}/scripts`, importerOnly);
    }
  }
  walkFiles(root, 'e2e', importerOnly);
  walkFiles(root, 'scripts', importerOnly);
  // Config files next to each package.json (tsdown.config.ts imports src/platform/build-version.ts).
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group))) {
      const dir = join(root, group, name);
      if (!existsSync(join(dir, 'package.json'))) continue;
      for (const f of readdirSync(dir))
        if (CODE.test(f)) importerOnly.push(`${group}/${name}/${f}`);
    }
  }
  const entries = packageEntries(root);
  const entryFiles = new Set(entries.values());
  const fileSet = new Set([...files, ...importerOnly]);
  const codeFiles = files.filter((f) => CODE.test(f) && !isDts(f));

  // The import graph: relative imports resolved to files.
  const imports = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  for (const file of [...codeFiles, ...importerOnly.filter((f) => CODE.test(f))]) {
    const targets: string[] = [];
    for (const spec of importSpecifiers(readFileSync(join(root, file), 'utf8'))) {
      const target = /^\.\.?\//.test(spec)
        ? posix.normalize(posix.join(parent(file), spec.replace(/\?.*$/, '')))
        : entries.get(spec);
      if (!target) continue;
      if (!fileSet.has(target) || targets.includes(target)) continue;
      targets.push(target);
      importers.set(target, [...(importers.get(target) ?? []), file]);
    }
    imports.set(file, targets);
  }

  const problems: Problem[] = [];
  const errors: string[] = [];
  const add = (rule: ListRule, key: string, message: string) =>
    problems.push({ rule, key, message });

  // Test code: tests, test support by name, test support under an old name (allowlisted), and
  // files only test code imports.
  const legacySupport = allowlist.testSupportNames;
  const isLegacySupport = (p: string) =>
    legacySupport.some((l) => (l.endsWith('/') ? p.startsWith(l) : p === l));
  const testCode = new Set(
    [...fileSet].filter((f) => isTest(f) || isTestSupportPath(f) || isLegacySupport(f)),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of codeFiles) {
      if (testCode.has(f)) continue;
      const by = importers.get(f) ?? [];
      if (by.length > 0 && by.every((i) => testCode.has(i))) {
        testCode.add(f);
        changed = true;
      }
    }
  }
  for (const f of codeFiles) {
    if (testCode.has(f) && !isTest(f) && !isTestSupportPath(f)) {
      add(
        'testSupportNames',
        legacySupport.find((l) => (l.endsWith('/') ? f.startsWith(l) : f === l)) ?? f,
        `${f}: only tests import it, so it is test support. Move it into a testing.ts beside the tests that use it, or into a testing/ folder (Rule C).`,
      );
    }
  }

  // Module folders: a folder below an area that holds a file named like itself.
  const moduleEntry = new Map<string, string>();
  for (const f of files) {
    const dir = parent(f);
    if (roots.includes(dir) || roots.includes(parent(dir))) continue; // src/ and its areas
    const stem = base(f).replace(/\.[^.]+$/, '');
    if (stem === base(dir) && CODE.test(f) && !isTest(f)) moduleEntry.set(dir, f);
  }

  for (const [file, targets] of imports) {
    if (!inRoots(file)) continue;
    const prod = !testCode.has(file);
    for (const target of targets) {
      const edge = `${file} -> ${target}`;
      // Rule C: production code never imports test code.
      if (prod && testCode.has(target)) {
        add(
          'testSupportImports',
          edge,
          `${file} imports ${target}, which is test code. Production code never imports a test, a testing.ts or testing/ file, a fixtures/ file or a file only tests use: move what both need into a production module (Rule C).`,
        );
      }
      // Rule B: from outside a module folder, only its entry.
      for (const [dir, entry] of moduleEntry) {
        if (!target.startsWith(`${dir}/`) || file.startsWith(`${dir}/`) || target === entry)
          continue;
        const rest = target.slice(dir.length + 1);
        if (!prod && /^testing(?:\.[cm]?[jt]sx?$|\/)/.test(rest)) continue;
        add(
          'moduleEntryImports',
          edge,
          `${file} imports ${target}, inside the module folder ${dir}/. Import its entry ${entry} instead; if code outside needs something, export it from the entry (Rule B).`,
        );
      }
      if (!prod) continue;
      // Rule A: layers.
      const from = layerOf(file);
      const to = layerOf(target);
      if (from && to && from.app === to.app && from.index >= 0 && to.index > from.index) {
        add(
          'upwardImports',
          edge,
          `${file} (layer ${from.name}) imports ${target} (layer ${to.name}), a higher layer. Import only from your own layer or lower ones: move the code you need down to ${from.name} or below, or have the higher layer pass it in (Rule A).`,
        );
      }
      // Web: only App.tsx imports a page.
      const page = pageOf(target);
      if (page && file !== APP_ROUTES && pageOf(file) !== page) {
        add(
          'pageImports',
          edge,
          `${file} imports ${target}, part of the page ${page}. Only ${APP_ROUTES} imports a page: move what both use to the feature folder's root (or to components/, hooks/ or lib/ when it knows no feature).`,
        );
      }
    }
  }

  // Every production file is in a layer.
  for (const f of codeFiles) {
    const layer = layerOf(f);
    if (layer && layer.index < 0 && !testCode.has(f)) {
      errors.push(
        `${f} is in no layer: add its folder (or the file) to the layer it belongs to in LAYERS['${layer.app}'] in scripts/check-structure.ts (${DOCS}, "Layers").`,
      );
    }
  }

  // No barrels.
  for (const f of codeFiles) {
    if (!/^index\.[cm]?[jt]sx?$/.test(base(f)) || REGISTRIES.includes(f) || entryFiles.has(f))
      continue;
    add(
      'barrels',
      f,
      `${f} is an index file. No barrels: a module folder's entry is the file named after the folder (verify/verify.ts), and imports name that file. index.ts is only for the registries in REGISTRIES in scripts/check-structure.ts.`,
    );
  }

  // Folders: names, and no folder too small to be one.
  const dirs = new Set<string>();
  for (const f of files) {
    for (let d = parent(f); !roots.includes(d) && inRoots(d); d = parent(d)) dirs.add(d);
  }
  for (const dir of [...dirs].sort()) {
    const name = base(dir);
    if (dir.split('/').some((s) => s === '__snapshots__')) continue;
    const children = files.filter((f) => parent(f) === dir);
    const ok =
      KEBAB.test(name) || (PASCAL.test(name) && children.some((f) => base(f) === `${name}.tsx`));
    if (!ok) {
      add(
        'folderNames',
        dir,
        `${dir}/: a folder name is kebab-case, or PascalCase when it holds a component of that name (${name}/${name}.tsx). Rename it.`,
      );
    }
    if (/(?:^|\/)(?:testing|fixtures)(?:\/|$)/.test(dir)) continue;
    const hasSubfolder = [...dirs].some((d) => parent(d) === dir && base(d) !== '__snapshots__');
    const sources = children.filter((f) => SOURCE.test(f) && !isTest(f) && !isDts(f));
    if (!hasSubfolder && sources.length > 0 && sources.length < 3) {
      add(
        'smallFolders',
        dir,
        `${dir}/ has ${sources.length} source file${sources.length === 1 ? '' : 's'} and no sub-folder. A folder needs at least three: move its files up into ${parent(dir)}/ (with their tests).`,
      );
    }
  }

  // Test names: <subject>.test.ts or <subject>.<topic>.test.ts beside <subject>.ts (or .css).
  for (const f of files) {
    if (!isTest(f)) continue;
    const parts = base(f).split('.');
    const dir = parent(f);
    const hasSubject = parts
      .slice(0, parts.indexOf('test'))
      .some((_, i) =>
        files.some(
          (s) =>
            parent(s) === dir &&
            SOURCE.test(s) &&
            !isTest(s) &&
            !isDts(s) &&
            base(s).replace(/\.[^.]+$/, '') === parts.slice(0, i + 1).join('.'),
        ),
      );
    if (!hasSubject) {
      add(
        'orphanTests',
        f,
        `${f} is named after no source file beside it. Name a test after its subject: <subject>.test.ts, or <subject>.<topic>.test.ts for a further file on it (${DOCS}, "Test names").`,
      );
    }
  }

  // Doc paths.
  const repoFiles: string[] = [];
  walkFiles(root, '', repoFiles);
  // The shared dev config's files count too: the docs name its Biome rules.
  walkFiles(root, 'node_modules/@transcoda/dev-config', repoFiles);
  const repoPaths = new Set(repoFiles);
  for (const f of repoFiles) {
    for (let d = parent(f); d; d = parent(d)) {
      repoPaths.add(d);
      repoPaths.add(`${d}/`);
    }
  }
  const docs = [
    'AGENTS.md',
    ...repoFiles.filter((f) => /^docs\/dev\/[^/]+\.md$/.test(f) && !DOC_PATHS_SKIP.includes(f)),
  ];
  for (const doc of docs) {
    if (!existsSync(join(root, doc))) continue;
    const text = readFileSync(join(root, doc), 'utf8');
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const path = m[1] ?? '';
      if (!isConcretePath(path)) continue;
      const fromDoc = posix.normalize(posix.join(parent(doc) || '.', path));
      const found =
        repoPaths.has(path) ||
        repoPaths.has(fromDoc) ||
        [...repoPaths].some((p) => p.endsWith(`/${path}`));
      if (!found) {
        add(
          'docPaths',
          `${doc}: ${path}`,
          `${doc} names \`${path}\`, which does not exist. Change it to the file's path now, or drop it.`,
        );
      }
    }
  }

  // The soft size limit for source files.
  const sizes = new Map<string, number>();
  for (const f of files) {
    if (!SOURCE.test(f) || isTest(f) || isDts(f) || /(?:^|\/)fixtures\//.test(f)) continue;
    sizes.set(f, countLines(readFileSync(join(root, f), 'utf8')));
  }
  return { problems, sizes, errors };
}

/** The failures: problems no allowlist entry holds, and entries nothing needs any more. */
export function checkStructure(root: string, allowlist: Allowlist = readAllowlist(root)): string[] {
  const { problems, sizes, errors } = findProblems(root, allowlist);
  for (const key of Object.keys(allowlist)) {
    if (key !== '$comment' && !(key in emptyAllowlist())) {
      errors.push(`${ALLOWLIST} has an unknown list "${key}".`);
    }
  }
  for (const [f, lines] of sizes) {
    const allowed = allowlist.softSizeLimit[f];
    if (allowed === undefined) {
      if (lines > SOFT_MAX_LINES) {
        errors.push(
          `${f} has ${lines} lines, over the soft limit of ${SOFT_MAX_LINES} for source files. Split it: make ${f.replace(/\.[^.]+$/, '/')} a module folder with the entry named after it (Rule B).`,
        );
      }
    } else if (lines > allowed) {
      errors.push(
        `${f} grew to ${lines} lines; softSizeLimit in ${ALLOWLIST} allows ${allowed}, and that number may only go down. Move code out of it instead.`,
      );
    } else if (lines <= SOFT_MAX_LINES) {
      errors.push(
        `${f} is down to ${lines} lines, within the soft limit of ${SOFT_MAX_LINES}: remove it from softSizeLimit in ${ALLOWLIST}.`,
      );
    } else if (lines < allowed) {
      errors.push(
        `${f} shrank to ${lines} lines: lower its number in softSizeLimit in ${ALLOWLIST} from ${allowed} to ${lines}.`,
      );
    }
  }
  for (const f of Object.keys(allowlist.softSizeLimit)) {
    if (!sizes.has(f)) {
      errors.push(`${f} is gone: remove it from softSizeLimit in ${ALLOWLIST}.`);
    }
  }

  // Compare with the allowlist: new problems fail, and so do entries nothing needs any more.
  for (const rule of LIST_RULES) {
    const listed = new Set(allowlist[rule]);
    const seen = new Set<string>();
    for (const p of problems.filter((x) => x.rule === rule)) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      if (!listed.has(p.key)) errors.push(p.message);
    }
    for (const key of listed) {
      if (!seen.has(key)) {
        errors.push(
          `"${key}" in ${rule} in ${ALLOWLIST} no longer breaks the rule: remove the entry.`,
        );
      }
    }
  }
  return [...new Set(errors)];
}

const BARE_EXTENSION = /\.(?:[cm]?tsx?|mjs|json|css|md|ya?ml|sh|grit)$/;
const EXTENSION = /\.(?:[cm]?[jt]sx?|json|css|md|ya?ml|sh|html|grit|svg|png)$/;

/** A back-ticked text that names one file or folder: no spaces, placeholders or globs. */
export function isConcretePath(text: string): boolean {
  if (!/^[\w.-]+(?:\/[\w.-]+)*\/?$/.test(text)) return false;
  if (text.startsWith('.local/') || /^\.\.?\/?$/.test(text)) return false;
  // Placeholders: `NNNN_snake_case.ts`, `./x.ts`, a bare extension like `.tsx`.
  if (/NNNN|(?:^|\/)x\.\w+$/.test(text) || /^\.\w+$/.test(text)) return false;
  // A bare name is a file only with a code or config extension (not `Node.js`).
  if (!text.includes('/') && !BARE_EXTENSION.test(text)) return false;
  if (text.includes('/') && !EXTENSION.test(text) && !text.endsWith('/')) {
    // A word with a slash but no extension (`hevc_vaapi/h264_vaapi`) is a path only with a known
    // top folder.
    return /^(?:apps|packages|docs|scripts|e2e|docker|examples|\.github|\.changes)\//.test(text);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const errors = checkStructure(root);
  if (errors.length > 0) {
    console.error(`Structure rule violations (rules and fixes: ${DOCS}):`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `Fix the code. Don't add entries to ${ALLOWLIST}: its lists hold what broke a rule before the check existed, and they only shrink.`,
    );
    process.exit(1);
  }
  console.log('check-structure: ok');
}
