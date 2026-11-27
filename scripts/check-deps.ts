// Enforces the workspace dependency direction: shared <- sdk <- contract <- server/web.
// - @transcoda/* dependencies must follow ALLOWED.
// - Third-party dependencies of shared and sdk are limited to THIRD_PARTY (zod only);
//   packages without a THIRD_PARTY entry are unrestricted.
// - shared/src may import no @transcoda/* package; sdk/src only @transcoda/shared.
// - No package's src reaches into another package with a relative import (../../server/src/...).
// Exports checkDeps(root) for tests; the CLI runs only when executed directly.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALLOWED: Record<string, string[]> = {
  shared: [],
  sdk: ['shared'],
  contract: ['shared', 'sdk'],
  server: ['shared', 'sdk', 'contract'],
  web: ['shared', 'contract'],
};
const THIRD_PARTY: Record<string, string[]> = { shared: ['zod'], sdk: ['zod'] };
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

export function checkDeps(root: string): string[] {
  const errors: string[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const dirName of readdirSync(groupDir)) {
      const pkgPath = join(groupDir, dirName, 'package.json');
      let pkg: PackageJson;
      try {
        pkg = readJson(pkgPath);
      } catch {
        continue;
      }
      const short = pkg.name?.replace(/^@transcoda\//, '') ?? dirName;
      const allowed = ALLOWED[short];
      if (!allowed) {
        errors.push(`${pkg.name ?? pkgPath}: not in the dependency allowlist`);
        continue;
      }
      for (const field of DEP_FIELDS) {
        for (const dep of Object.keys(pkg[field] ?? {})) {
          if (!dep.startsWith('@transcoda/')) {
            const thirdParty = THIRD_PARTY[short];
            if (thirdParty && !thirdParty.includes(dep)) {
              errors.push(
                `${short}: ${field} contains third-party dependency ${dep} (allowed: ${thirdParty.join(', ') || 'none'})`,
              );
            }
            continue;
          }
          const depShort = dep.slice('@transcoda/'.length);
          if (!allowed.includes(depShort)) {
            errors.push(`${short}: ${field} contains forbidden dependency ${dep}`);
          }
        }
      }
      if (short === 'sdk' || short === 'shared') {
        const permitted = short === 'sdk' ? ['@transcoda/shared'] : [];
        const srcDir = join(groupDir, dirName, 'src');
        if (!existsSync(srcDir)) continue;
        for (const file of walk(srcDir)) {
          const text = readFileSync(file, 'utf8');
          for (const m of text.matchAll(/from\s+['"](@transcoda\/[^'"]+)['"]/g)) {
            if (m[1] && !permitted.includes(m[1])) {
              errors.push(`${short}: ${file.slice(root.length + 1)} imports ${m[1]}`);
            }
          }
        }
      }
    }
  }
  errors.push(...crossPackageRelativeImports(root));
  return errors;
}

/** A token: a word, a string (null for a template literal or a regex) or one punctuation mark. */
interface Token {
  kind: 'word' | 'string' | 'punct';
  value: string | null;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;

const REGEX_AFTER_WORD = new Set(
  'return typeof instanceof in of new delete void throw case do else yield await'.split(' '),
);

/**
 * The module specifiers of a file's import and export statements and dynamic imports:
 * `from '<s>'`, `import '<s>'` and `import('<s>')`. A small tokenizer, so the same text inside a
 * comment, a string, a template literal or a regex does not count. (TypeScript 7 has no JS API,
 * and this script runs with no dependencies.) A quote string ends at a line break, so an
 * apostrophe in JSX text spoils at most its own line.
 */
export function importSpecifiers(text: string): string[] {
  const tokens: Token[] = [];
  const braces: boolean[] = []; // per open `{`: true when it is a template literal's `${`
  let i = 0;
  const n = text.length;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.kind === 'word') return REGEX_AFTER_WORD.has(t.value ?? '');
    if (t.kind === 'string') return false;
    return !/^[)\]]$/.test(t.value ?? '');
  };
  // Skips a template literal's text from i (just after ` or a closing }) up to its end or `${`.
  const templateText = () => {
    while (i < n) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i += 1;
        tokens.push({ kind: 'string', value: null });
        return;
      } else if (c === '$' && text[i + 1] === '{') {
        i += 2;
        braces.push(true);
        return;
      } else i += 1;
    }
  };
  while (i < n) {
    const c = text[i] ?? '';
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      let value = '';
      i += 1;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') i += 1;
        else value += text[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
    } else if (c === '`') {
      i += 1;
      templateText();
    } else if (c === '/' && regexAllowed()) {
      let inClass = false;
      i += 1;
      while (i < n && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') i += 1;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/i.test(text[i] ?? '')) i += 1;
      tokens.push({ kind: 'string', value: null });
    } else if (/[\w$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(text[i] ?? '')) i += 1;
      tokens.push({ kind: 'word', value: text.slice(start, i) });
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      i += 1;
      if (c === '{') braces.push(false);
      else if (c === '}' && braces.pop()) {
        templateText();
        continue;
      }
      tokens.push({ kind: 'punct', value: c });
    }
  }
  const specifiers: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t?.kind !== 'word') continue;
    const next = tokens[k + 1];
    const prev = tokens[k - 1];
    // `x.from 'a'` or `x.import(...)` is a property, not a statement.
    if (prev?.kind === 'punct' && prev.value === '.') continue;
    if ((t.value === 'from' || t.value === 'import') && next?.kind === 'string' && next.value) {
      specifiers.push(next.value);
    } else if (t.value === 'import' && next?.value === '(') {
      const arg = tokens[k + 2];
      if (arg?.kind === 'string' && arg.value) specifiers.push(arg.value);
    }
  }
  return specifiers;
}

// A relative import that resolves into another workspace package skips the dependency direction
// above (and the package's public entry point): import it as @transcoda/<name> instead.
function crossPackageRelativeImports(root: string): string[] {
  const errors: string[] = [];
  const packageDirs: string[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const dirName of readdirSync(groupDir)) {
      const dir = join(groupDir, dirName);
      if (existsSync(join(dir, 'package.json'))) packageDirs.push(dir);
    }
  }
  const owner = (path: string) =>
    packageDirs.find((dir) => path === dir || path.startsWith(dir + sep));
  for (const dir of packageDirs) {
    const srcDir = join(dir, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of walk(srcDir)) {
      if (!SOURCE_FILE.test(file)) continue;
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (!/^\.\.?\//.test(spec)) continue;
        const target = owner(resolve(dirname(file), spec));
        if (target && target !== dir) {
          errors.push(
            `${relative(root, file)} imports ${spec}, a relative path into ${relative(root, target)}: import that package by its @transcoda/ name instead`,
          );
        }
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const errors = checkDeps(root);
  if (errors.length > 0) {
    console.error('Dependency rule violations:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('check-deps: ok');
}
