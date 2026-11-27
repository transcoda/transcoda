// The release notes waiting in .changes/ follow .changes/README.md now, not only when a pull
// request adds one (the release-note check) or when a release is cut (pnpm release). The note
// rules are the shared ones (@transcoda/dev-config/changes); the highlights are core's own.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HIGHLIGHTS, layoutOf, lintNotes } from '@transcoda/dev-config/changes';
import { describe, expect, it } from 'vitest';
import { IMAGES_DIR, prepareHighlights } from './release-notes.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, '.changes');
const entries = readdirSync(dir);

describe('.changes/', () => {
  it('holds only notes, the README, highlights and their images', () => {
    expect(
      entries.filter((f) => !f.endsWith('.md') && f !== IMAGES_DIR),
      '.changes/README.md: a note is a .md file',
    ).toEqual([]);
  });

  it('every note has a valid type and text, without hashes or PR numbers', () => {
    expect(lintNotes(root, layoutOf(root)), '.changes/README.md › Format').toEqual([]);
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
