// Checks that a pull request carries a release note (.changes/*.md) or the
// "no user-facing change" label. Run by .github/workflows/release-note.yml.
// Usage: node scripts/check-release-note.mjs <base-sha> <head-sha> <labels-json>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [base, head, labelsJson = '[]'] = process.argv.slice(2);
const NO_NOTE_LABEL = 'no user-facing change';
const TYPES = new Set(['new', 'improved', 'fixed', 'breaking']);

const labels = JSON.parse(labelsJson);
if (labels.includes(NO_NOTE_LABEL)) {
  console.log(`Label "${NO_NOTE_LABEL}" present: no release note needed.`);
  process.exit(0);
}

const changed = execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=AM', `${base}...${head}`],
  {
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter((f) => /^\.changes\/[^/]+\.md$/.test(f) && f !== '.changes/README.md');

if (changed.length === 0) {
  console.error(
    `No release note found. Add a file .changes/<short-name>.md (see .changes/README.md), or ask a maintainer to add the "${NO_NOTE_LABEL}" label.`,
  );
  process.exit(1);
}

let failed = false;
for (const file of changed) {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const type = match ? /^type:\s*(\S+)\s*$/m.exec(match[1])?.[1] : undefined;
  const body = match ? match[2].trim() : '';
  if (!type || !TYPES.has(type)) {
    console.error(`${file}: front matter needs "type:" set to one of ${[...TYPES].join(', ')}.`);
    failed = true;
  }
  if (!body) {
    console.error(`${file}: the note text is empty.`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`Release note found: ${changed.join(', ')}`);
