import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodesFixture } from '../test/fixtures/catalog.ts';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../api/client.ts', () => ({
  api: { nodes: { list: mocks.list } },
  isDefinedError: () => false,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch (e) {
      return [e, undefined];
    }
  },
}));

import { buildCatalog, resetCatalogCache, useCatalog } from './useCatalog.ts';

beforeEach(() => {
  resetCatalogCache();
  mocks.list.mockReset().mockResolvedValue({ nodes: nodesFixture });
});
afterEach(cleanup);

describe('buildCatalog', () => {
  const c = buildCatalog(nodesFixture);

  it('buildCatalog groups core nodes by kind in palette order and excludes subworkflow-io from kinds', () => {
    expect(c.kinds).toEqual(['trigger', 'condition', 'action', 'finish']); // the fixture has no data nodes today
    expect(c.byType.get('core:keep-languages')?.onNodeSettings).toEqual(['languages']);
  });

  it('portType resolves inputs and outputs and returns null for unknown ports', () => {
    expect(c.portType('core:keep-languages', 'language')).toBe('data:language');
    expect(c.portType('core:video-is', 'pass')).toBe('file');
    expect(c.portType('core:video-is', 'nope')).toBeNull();
    expect(c.portType('core:does-not-exist', 'in')).toBeNull();
  });
});

describe('useCatalog', () => {
  it('useCatalog fetches nodes.list once for two consumers and refetches after reload', async () => {
    const a = renderHook(() => useCatalog());
    const b = renderHook(() => useCatalog());
    await waitFor(() => expect(a.result.current.catalog).not.toBeNull());
    await waitFor(() => expect(b.result.current.catalog).not.toBeNull());
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(a.result.current.catalog?.byType.has('core:keep-languages')).toBe(true);

    act(() => a.result.current.reload());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(b.result.current.catalog).not.toBeNull());
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('surfaces a nodes.list failure as error with a null catalog', async () => {
    const failure = new TypeError('Failed to fetch');
    mocks.list.mockRejectedValue(failure);
    const { result } = renderHook(() => useCatalog());
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.catalog).toBeNull();
  });
});
