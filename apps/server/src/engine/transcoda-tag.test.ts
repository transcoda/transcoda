import { describe, expect, it } from 'vitest';
import { modelFromProbe } from './build-model.ts';
import { renderArgs } from './render.ts';
import { probeOf } from './test-helpers.ts';
import {
  MAX_TAG_ENTRIES,
  nextTranscodaTag,
  parseTranscodaTag,
  TRANSCODA_TAG,
  transcodaTagOf,
} from './transcoda-tag.ts';

const tagged = (tags: Record<string, unknown> | null) => ({
  raw: { format: tags === null ? {} : { tags } },
});

describe('the TRANSCODA tag', () => {
  it('reads the format tag in any case; none when absent or not a string', () => {
    expect(transcodaTagOf(tagged({ TRANSCODA: 'a@1' }))).toBe('a@1');
    expect(transcodaTagOf(tagged({ transcoda: 'a@1' }))).toBe('a@1');
    expect(transcodaTagOf(tagged({ Transcoda: 'a@1', title: 'x' }))).toBe('a@1');
    expect(transcodaTagOf(tagged(null))).toBeNull();
    expect(transcodaTagOf(tagged({ TRANSCODA: 3 }))).toBeNull();
    expect(transcodaTagOf({ raw: null })).toBeNull();
  });

  it('parses entries, skipping malformed ones', () => {
    expect(parseTranscodaTag('a@1, b@12,bad,c@0,@3,d@x,e@2')).toEqual([
      { workflowId: 'a', version: 1 },
      { workflowId: 'b', version: 12 },
      { workflowId: 'e', version: 2 },
    ]);
    expect(parseTranscodaTag(null)).toEqual([]);
    expect(parseTranscodaTag('')).toEqual([]);
  });

  it('appends the new entry last; an identical one moves to the end; the list is capped', () => {
    expect(nextTranscodaTag(tagged(null), 'a', 1)).toBe('a@1');
    expect(nextTranscodaTag(tagged({ TRANSCODA: 'a@1' }), 'b', 2)).toBe('a@1,b@2');
    expect(nextTranscodaTag(tagged({ TRANSCODA: 'a@1,b@2' }), 'a', 1)).toBe('b@2,a@1');
    // Another version of the same workflow is another entry.
    expect(nextTranscodaTag(tagged({ TRANSCODA: 'a@1' }), 'a', 2)).toBe('a@1,a@2');
    const many = Array.from({ length: MAX_TAG_ENTRIES }, (_, i) => `w${i}@1`).join(',');
    const next = parseTranscodaTag(nextTranscodaTag(tagged({ TRANSCODA: many }), 'new', 1));
    expect(next).toHaveLength(MAX_TAG_ENTRIES);
    expect(next[0]).toEqual({ workflowId: 'w1', version: 1 });
    expect(next.at(-1)).toEqual({ workflowId: 'new', version: 1 });
  });

  it('renderArgs writes it as a global tag; MP4 also gets use_metadata_tags', () => {
    const probe = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', default: true },
    ]);
    const io = { input: '/lib/a.mkv', output: '/tc/j1/out' };
    const mkv = renderArgs({ ...io, model: modelFromProbe(probe), transcodaTag: 'a@1' });
    expect(mkv.slice(-5)).toEqual([
      '-metadata',
      `${TRANSCODA_TAG}=a@1`,
      '-f',
      'matroska',
      '/tc/j1/out',
    ]);
    const mp4 = renderArgs({
      ...io,
      model: { ...modelFromProbe(probe), container: 'mp4' },
      transcodaTag: 'a@1',
    });
    expect(mp4.slice(-7)).toEqual([
      '-metadata',
      'TRANSCODA=a@1',
      '-movflags',
      'use_metadata_tags',
      '-f',
      'mp4',
      '/tc/j1/out',
    ]);
    // Without a tag nothing is added (the source's own tag still comes with -map_metadata 0).
    const none = renderArgs({ ...io, model: { ...modelFromProbe(probe), container: 'mp4' } });
    expect(none).not.toContain('-movflags');
    expect(none.some((a) => a.startsWith('TRANSCODA='))).toBe(false);
  });
});
