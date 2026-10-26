import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../engine/fixtures.ts';
import { nodeFsOps } from '../../engine/fs-ops.ts';
import { fsSidecarSource, parseSidecarName, readHead, type SidecarName } from './sidecars.ts';

const hasMkfifo = (() => {
  try {
    execFileSync('which', ['mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const BASE = 'Show.S01E01';
const name = (n: Partial<SidecarName>): SidecarName => ({
  language: null,
  forced: false,
  sdh: false,
  default: false,
  title: null,
  codec: 'subrip',
  ...n,
});

describe('parseSidecarName', () => {
  it.each([
    ['Show.S01E01.de.forced.srt', name({ language: 'deu', forced: true })],
    ['Show.S01E01.en.sdh.srt', name({ language: 'eng', sdh: true })],
    ['Show.S01E01.en.cc.srt', name({ language: 'eng', sdh: true })],
    ['Show.S01E01.eng.hi.srt', name({ language: 'eng', sdh: true })],
    ['Show.S01E01.hi.srt', name({ language: 'hin' })],
    ['Show.S01E01.eng.hi.forced.srt', name({ language: 'eng', sdh: true, forced: true })],
    ['Show.S01E01.pt-BR.srt', name({ language: 'por' })],
    ['Show.S01E01.ger.ass', name({ language: 'deu', codec: 'ass' })],
    ['Show.S01E01.en.ssa', name({ language: 'eng', codec: 'ass' })],
    ['Show.S01E01.en.vtt', name({ language: 'eng', codec: 'webvtt' })],
    ['Show.S01E01.en.sup', name({ language: 'eng', codec: 'hdmv_pgs_subtitle' })],
    ['Show.S01E01.EN.Default.SRT', name({ language: 'eng', default: true })],
    ['Show.S01E01.Commentary.en.srt', name({ language: 'eng', title: 'Commentary' })],
    ['Show.S01E01.Directors.Cut.srt', name({ title: 'Directors Cut' })],
    ['Show.S01E01.srt', name({})],
  ])('%s', (file, expected) => {
    expect(parseSidecarName(BASE, file)).toEqual(expected);
  });

  it('two different languages are skipped; the same one twice is not', () => {
    expect(parseSidecarName(BASE, 'Show.S01E01.en.de.srt')).toEqual({
      skip: 'two languages in the name',
    });
    expect(parseSidecarName(BASE, 'Show.S01E01.en.eng.srt')).toEqual(name({ language: 'eng' }));
  });

  it.each([
    'Other.en.srt',
    'Show.S01E01.en.txt',
    'Show.S01E01',
    'Show.S01E01.mkv',
    'Show.S01E01x.en.srt',
  ])('%s is not a sidecar of the video', (file) => {
    expect(parseSidecarName(BASE, file)).toBeNull();
  });
});

describe('fsSidecarSource', () => {
  let dir: string;
  const source = () => fsSidecarSource(nodeFsOps, readHead);
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHallo Welt\n';

  beforeEach(async () => {
    dir = await realpath(await tempDir('sidecars-'));
    await writeFile(join(dir, 'Show.S01E01.mkv'), 'video');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns each sidecar to the video with the longest matching base name', async () => {
    await writeFile(join(dir, 'Show.S01E01.Part2.mkv'), 'video');
    await writeFile(join(dir, 'Show.S01E01.en.srt'), srt);
    await writeFile(join(dir, 'Show.S01E01.Part2.en.srt'), srt);
    const first = await source().find(join(dir, 'Show.S01E01.mkv'));
    expect(first.found.map((c) => c.file)).toEqual(['Show.S01E01.en.srt']);
    expect(first.found[0]).toMatchObject({
      path: join(dir, 'Show.S01E01.en.srt'),
      name: { language: 'eng', codec: 'subrip' },
    });
    expect(first.skipped).toEqual([]);
    const second = await source().find(join(dir, 'Show.S01E01.Part2.mkv'));
    expect(second.found.map((c) => c.file)).toEqual(['Show.S01E01.Part2.en.srt']);
  });

  it('returns candidates sorted by file name and skips names with two languages', async () => {
    await writeFile(join(dir, 'Show.S01E01.en.srt'), srt);
    await writeFile(join(dir, 'Show.S01E01.de.forced.srt'), srt);
    await writeFile(join(dir, 'Show.S01E01.en.de.srt'), srt);
    await writeFile(join(dir, 'Show.S01E01.nfo'), 'x');
    const r = await source().find(join(dir, 'Show.S01E01.mkv'));
    expect(r.found.map((c) => c.file)).toEqual(['Show.S01E01.de.forced.srt', 'Show.S01E01.en.srt']);
    expect(r.skipped).toEqual([
      { file: 'Show.S01E01.en.de.srt', reason: 'two languages in the name' },
    ]);
  });

  it('skips a symlink, a directory, an empty file and a non-UTF-8 text file', async () => {
    const outside = await tempDir('sidecars-outside-');
    try {
      await writeFile(join(outside, 'secret.srt'), srt);
      await symlink(join(outside, 'secret.srt'), join(dir, 'Show.S01E01.de.srt'));
      await mkdir(join(dir, 'Show.S01E01.fr.srt'));
      await writeFile(join(dir, 'Show.S01E01.it.srt'), '');
      await writeFile(join(dir, 'Show.S01E01.es.srt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      const r = await source().find(join(dir, 'Show.S01E01.mkv'));
      expect(r.found).toEqual([]);
      expect(r.skipped).toEqual([
        { file: 'Show.S01E01.de.srt', reason: 'not a regular file' },
        {
          file: 'Show.S01E01.es.srt',
          reason: 'not UTF-8 text (let Bazarr encode subtitles to UTF-8)',
        },
        { file: 'Show.S01E01.fr.srt', reason: 'not a regular file' },
        { file: 'Show.S01E01.it.srt', reason: 'empty' },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts UTF-8 with a BOM, UTF-16 with a BOM and a binary .sup without decoding it', async () => {
    await writeFile(
      join(dir, 'Show.S01E01.de.srt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(srt)]),
    );
    await writeFile(
      join(dir, 'Show.S01E01.en.srt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(srt, 'utf16le')]),
    );
    await writeFile(join(dir, 'Show.S01E01.fr.sup'), Buffer.from([0x50, 0x47, 0xff, 0xe9, 0x00]));
    const r = await source().find(join(dir, 'Show.S01E01.mkv'));
    expect(r.found.map((c) => c.file)).toEqual([
      'Show.S01E01.de.srt',
      'Show.S01E01.en.srt',
      'Show.S01E01.fr.sup',
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('skips a file larger than 8 MiB', async () => {
    await writeFile(join(dir, 'Show.S01E01.de.sup'), Buffer.alloc(8 * 1024 * 1024 + 1, 1));
    const r = await source().find(join(dir, 'Show.S01E01.mkv'));
    expect(r.skipped).toEqual([{ file: 'Show.S01E01.de.sup', reason: 'larger than 8 MiB' }]);
  });

  it("skips a file whose realpath is outside the video's folder", async () => {
    await writeFile(join(dir, 'Show.S01E01.de.srt'), srt);
    const fs = {
      ...nodeFsOps,
      realpath: async (p: string) =>
        p.endsWith('.srt') ? '/elsewhere/Show.S01E01.de.srt' : nodeFsOps.realpath(p),
    };
    const r = await fsSidecarSource(fs, readHead).find(join(dir, 'Show.S01E01.mkv'));
    expect(r).toEqual({
      found: [],
      skipped: [{ file: 'Show.S01E01.de.srt', reason: "outside the video's folder" }],
    });
  });

  it.skipIf(!hasMkfifo)(
    'readHead refuses a FIFO without blocking on open',
    async () => {
      const fifo = join(dir, 'fifo.srt');
      execFileSync('mkfifo', [fifo]);
      await expect(readHead(fifo, 100)).rejects.toThrow('it is not a regular file');
    },
    5_000,
  );

  it('readHead reads at most max bytes', async () => {
    await writeFile(join(dir, 'x.srt'), 'abcdef');
    expect((await readHead(join(dir, 'x.srt'), 3)).toString()).toBe('abc');
    expect((await readHead(join(dir, 'x.srt'), 100)).toString()).toBe('abcdef');
  });
});
