import { describe, expect, it, vi } from 'vitest';
import { type ReadMap, SourceMaps, sourcePath } from './source-maps.ts';

// Generated line 1 maps to the source's line 1, generated line 2 to its line 3.
const MAP = JSON.stringify({
  version: 3,
  sources: ['../../src/jobs/JobPage.tsx'],
  names: [],
  mappings: 'AAAA;AAEA',
});

function maps(files: Record<string, string> = { '/web/assets/index-abc.js.map': MAP }) {
  const read = vi.fn<ReadMap>(async (path) => {
    const body = files[path];
    if (body === undefined) throw new Error('ENOENT');
    return body;
  });
  return { sm: new SourceMaps('/web/assets', read), read };
}

describe('SourceMaps', () => {
  it('replaces a bundle position with the original file, line and column', async () => {
    const { sm } = maps();
    expect(await sm.resolve('at f (/assets/index-abc.js:2:1)')).toBe(
      'at f (src/jobs/JobPage.tsx:3:1)',
    );
    expect(await sm.resolve('at /assets/index-abc.js:1:1')).toBe('at src/jobs/JobPage.tsx:1:1');
  });

  it('leaves a frame as it is without a map, for another script, or without a UI', async () => {
    const { sm } = maps();
    for (const f of [
      'at f (/assets/old-123.js:1:1)',
      'at f (<url>:1:1)',
      'at <anonymous>:1:1',
      'at f (/src/main.tsx:1:1)',
    ]) {
      expect(await sm.resolve(f)).toBe(f);
    }
    const none = new SourceMaps(null, vi.fn());
    expect(await none.resolve('at f (/assets/index-abc.js:2:1)')).toBe(
      'at f (/assets/index-abc.js:2:1)',
    );
  });

  it('never reads outside the assets folder', async () => {
    const { sm, read } = maps();
    await sm.resolve('at f (/assets/../../etc/passwd.js:1:1)');
    await sm.resolve('at f (/assets/a/b.js:1:1)');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads each map once, a missing one included', async () => {
    const { sm, read } = maps();
    await sm.resolve('at f (/assets/index-abc.js:2:1)');
    await sm.resolve('at g (/assets/index-abc.js:1:1)');
    await sm.resolve('at f (/assets/old-123.js:1:1)');
    await sm.resolve('at f (/assets/old-123.js:1:1)');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('leaves a frame as it is when the map is broken', async () => {
    const { sm } = maps({ '/web/assets/index-abc.js.map': '{not json' });
    expect(await sm.resolve('at f (/assets/index-abc.js:2:1)')).toBe(
      'at f (/assets/index-abc.js:2:1)',
    );
  });
});

describe('sourcePath', () => {
  it.each([
    ['../../src/main.tsx', 'src/main.tsx'],
    ['./src/main.tsx', 'src/main.tsx'],
    [
      '../../../../node_modules/.pnpm/react-dom@19.3.1/node_modules/react-dom/cjs/x.js',
      'node_modules/react-dom/cjs/x.js',
    ],
    ['webpack:///src/a.ts', 'src/a.ts'],
  ])('%s is %s', (source, expected) => {
    expect(sourcePath(source)).toBe(expected);
  });
});
