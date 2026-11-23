// The release notes waiting in .changes/ follow .changes/README.md now, not only when a pull
// request adds one (the release-note check) or when a release is cut (pnpm release).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { HIGHLIGHTS, IMAGES_DIR, parseNote, prepareHighlights } from './release-notes.mjs';

const dir = join(import.meta.dirname, '../.changes');
const entries = readdirSync(dir);
const notes = entries.filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== HIGHLIGHTS);

/** A note's problems: the format, and no commit hashes or pull request numbers (README: "No code,
 *  commit hashes or internal names"). */
function noteProblems(name: string, text: string): string[] {
  const parsed = parseNote(text) as { errors?: string[]; text?: string };
  const errors = (parsed.errors ?? []).map((e) => `.changes/${name}: ${e}`);
  const body = parsed.text ?? '';
  if (/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.test(body)) {
    errors.push(`.changes/${name}: no commit hashes in a note`);
  }
  if (/(?<![\w&])#\d+\b/.test(body))
    errors.push(`.changes/${name}: no pull request numbers in a note`);
  return errors;
}

describe('.changes/', () => {
  it('holds only notes, the README, highlights and their images', () => {
    expect(
      entries.filter((f) => !f.endsWith('.md') && f !== IMAGES_DIR),
      '.changes/README.md: a note is a .md file',
    ).toEqual([]);
  });

  it('every note has a valid type and text, without hashes or PR numbers', () => {
    const problems = notes.flatMap((name) =>
      noteProblems(name, readFileSync(join(dir, name), 'utf8')),
    );
    expect(problems, '.changes/README.md › Format').toEqual([]);
    expect(noteProblems('x.md', '---\ntype: changed\n---\nSomething.\n')).toHaveLength(1);
    expect(noteProblems('x.md', '---\ntype: fixed\n---\nFixed in 3f9c2a7e.\n')).toHaveLength(1);
    expect(noteProblems('x.md', '---\ntype: fixed\n---\nFixed (#123).\n')).toHaveLength(1);
    expect(noteProblems('x.md', '---\ntype: fixed\n---\nKeeps 1080p files.\n')).toEqual([]);
  });

  it('highlights, when present, link only images that exist and use every one', () => {
    const images = existsSync(join(dir, IMAGES_DIR)) ? readdirSync(join(dir, IMAGES_DIR)) : [];
    if (!entries.includes(HIGHLIGHTS)) {
      expect(images, '.changes/README.md: images need a highlights file').toEqual([]);
      return;
    }
    const result = prepareHighlights(readFileSync(join(dir, HIGHLIGHTS), 'utf8'), images, '0.0.0');
    expect(result.errors ?? [], '.changes/README.md › Highlights').toEqual([]);
  });
});
