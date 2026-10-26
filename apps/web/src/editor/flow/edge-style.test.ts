import { describe, expect, it } from 'vitest';
import { ARROWED, type EdgeStyle, edgeStyle, edgeWord } from './edge-style.ts';

describe('edgeStyle and edgeWord', () => {
  it('picks the style first match wins: broken, data, path taken, not taken, file', () => {
    expect(edgeStyle(undefined)).toBe('edge-file');
    expect(edgeStyle({ portType: 'data:x', broken: true, taken: true })).toBe('edge-broken');
    expect(edgeStyle({ portType: 'data:x', broken: false, taken: true })).toBe('edge-data');
    expect(edgeStyle({ portType: 'file', broken: false, taken: true, untaken: true })).toBe(
      'edge-path',
    );
    expect(edgeStyle({ portType: 'file', broken: false, untaken: true })).toBe('edge-untaken');
    expect(edgeStyle({ portType: null, broken: false })).toBe('edge-file');
  });

  it('names every style but plain file flow with a meaning word', () => {
    const words: Array<[EdgeStyle, string | null]> = [
      ['edge-broken', 'leads to a broken node'],
      ['edge-data', 'data'],
      ['edge-path', 'path taken'],
      ['edge-untaken', 'not taken'],
      ['edge-file', null],
    ];
    for (const [style, word] of words) expect(edgeWord(style)).toBe(word);
  });

  it('arrows every style (direction at the target)', () => {
    expect([...ARROWED].sort()).toEqual(
      ['edge-broken', 'edge-data', 'edge-file', 'edge-path', 'edge-untaken'].sort(),
    );
  });
});
