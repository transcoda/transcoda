import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewportMemory } from './useViewportMemory.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useViewportMemory', () => {
  it('writes the viewport on move end, per workflow', () => {
    const a = renderHook(() => useViewportMemory('wf-a'));
    const b = renderHook(() => useViewportMemory('wf-b'));
    act(() => a.result.current.onMoveEnd(null, { x: 1, y: 2, zoom: 0.5 }));
    act(() => b.result.current.onMoveEnd(null, { x: 9, y: 8, zoom: 2 }));
    const size = { w: window.innerWidth, h: window.innerHeight };
    expect(JSON.parse(localStorage.getItem('tc.viewport.wf-a') ?? 'null')).toEqual({
      x: 1,
      y: 2,
      zoom: 0.5,
      ...size,
    });
    expect(JSON.parse(localStorage.getItem('tc.viewport.wf-b') ?? 'null')).toEqual({
      x: 9,
      y: 8,
      zoom: 2,
      ...size,
    });
    // A new mount reads its own workflow's viewport; another workflow starts unset (fit).
    expect(renderHook(() => useViewportMemory('wf-a')).result.current.defaultViewport).toEqual({
      x: 1,
      y: 2,
      zoom: 0.5,
    });
    expect(renderHook(() => useViewportMemory('wf-c')).result.current.defaultViewport).toBe(
      undefined,
    );
  });

  it('a view saved in a window of another size is not restored: the canvas fits instead', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    localStorage.setItem(
      'tc.viewport.wf-a',
      JSON.stringify({ x: 1, y: 2, zoom: 0.24, w: Math.round(w / 2), h }),
    );
    expect(renderHook(() => useViewportMemory('wf-a')).result.current.defaultViewport).toBe(
      undefined,
    );
    // Within 15 % of the window it was saved in, it is.
    localStorage.setItem(
      'tc.viewport.wf-a',
      JSON.stringify({ x: 1, y: 2, zoom: 0.5, w: Math.round(w * 1.1), h }),
    );
    expect(renderHook(() => useViewportMemory('wf-a')).result.current.defaultViewport).toEqual({
      x: 1,
      y: 2,
      zoom: 0.5,
    });
  });

  it('a throwing storage means "fit the view" and never breaks the editor', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useViewportMemory('wf-a'));
    expect(result.current.defaultViewport).toBe(undefined);
    expect(() => result.current.onMoveEnd(null, { x: 1, y: 2, zoom: 1 })).not.toThrow();
  });

  it('ignores stored values that are not a usable viewport', () => {
    for (const raw of ['not json', '{"x":1,"y":2}', '{"x":1,"y":2,"zoom":0}', 'null']) {
      localStorage.setItem('tc.viewport.wf-a', raw);
      expect(renderHook(() => useViewportMemory('wf-a')).result.current.defaultViewport).toBe(
        undefined,
      );
    }
  });
});
