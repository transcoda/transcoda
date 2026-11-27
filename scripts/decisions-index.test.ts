// The decision log in docs/decisions/ stays findable: every entry has a dated heading
// (`## YYYY-MM-DD Title`) and one line in the index in docs/decisions/README.md, in log order.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..', 'docs', 'decisions');
const README = readFileSync(join(DIR, 'README.md'), 'utf8');
const LINE = /^- (\d{4}-\d{2}-\d{2}) · ([A-Z][\w ]*) · \[(.+)\]\(([\w.-]+\.md)\)(?: \(.+\))?$/;

interface Entry {
  date: string;
  title: string;
  file: string;
}

/** The log files in the order the README's file table lists them. */
function logFiles(): string[] {
  return [...README.matchAll(/^\| \[([\w.-]+\.md)\]\(\1\) \|/gm)].map((m) => m[1] ?? '');
}

function headings(file: string): { line: string; entry: Entry | null }[] {
  return readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((line) => {
      const m = /^## (\d{4}-\d{2}-\d{2}) (.+)$/.exec(line);
      return { line, entry: m ? { date: m[1] ?? '', title: m[2] ?? '', file } : null };
    });
}

function indexed(): Entry[] {
  const index = README.slice(README.indexOf('\n## Index\n'));
  return index
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => {
      const m = LINE.exec(l);
      if (!m)
        throw new Error(
          `index line not in the form "- YYYY-MM-DD · Area · [Title](file.md)": ${l}`,
        );
      return { date: m[1] ?? '', title: m[3] ?? '', file: m[4] ?? '' };
    });
}

describe('decision log', () => {
  it('lists every log file in the README table', () => {
    const onDisk = readdirSync(DIR)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .sort();
    expect([...logFiles()].sort()).toEqual(onDisk);
  });

  it('gives every entry a dated heading', () => {
    const undated = logFiles().flatMap((f) =>
      headings(f)
        .filter((h) => h.entry === null)
        .map((h) => `${f}: ${h.line}`),
    );
    expect(undated, 'start each "## " heading with its date: "## YYYY-MM-DD Title"').toEqual([]);
  });

  it('indexes every entry once, in log order', () => {
    const entries = logFiles().flatMap((f) =>
      headings(f).flatMap((h) => (h.entry ? [h.entry] : [])),
    );
    const missing = entries
      .filter((e) => !indexed().some((i) => i.file === e.file && i.title === e.title))
      .map((e) => `- ${e.date} · <Area> · [${e.title}](${e.file})`);
    expect(missing, 'add these lines to the index in docs/decisions/README.md').toEqual([]);
    expect(indexed()).toEqual(entries);
  });
});
