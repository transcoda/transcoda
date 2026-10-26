// Enforces the workspace dependency direction: shared <- sdk <- contract <- server/web.
// - @transcoda/* dependencies must follow ALLOWED.
// - Third-party dependencies of shared and sdk are limited to THIRD_PARTY (zod only);
//   packages without a THIRD_PARTY entry are unrestricted.
// - shared/src may import no @transcoda/* package; sdk/src only @transcoda/shared.
// Exports checkDeps(root) for tests; the CLI runs only when executed directly.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALLOWED = {
  shared: [],
  sdk: ['shared'],
  contract: ['shared', 'sdk'],
  server: ['shared', 'sdk', 'contract'],
  web: ['shared', 'contract'],
};
const THIRD_PARTY = { shared: ['zod'], sdk: ['zod'] };
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

export function checkDeps(root) {
  const errors = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const dirName of readdirSync(groupDir)) {
      const pkgPath = join(groupDir, dirName, 'package.json');
      let pkg;
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
            if (!permitted.includes(m[1])) {
              errors.push(`${short}: ${file.slice(root.length + 1)} imports ${m[1]}`);
            }
          }
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
