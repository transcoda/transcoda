import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  plugins: {
    list: vi.fn(),
    catalog: vi.fn(),
  },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { catalogOutput, plugin } from '../test/fixtures/plugins.ts';
import { usePlugins } from './usePlugins.ts';

beforeEach(() => {
  mocks.plugins.list.mockReset().mockResolvedValue({ plugins: [plugin()] });
  mocks.plugins.catalog.mockReset().mockResolvedValue(catalogOutput());
});
afterEach(cleanup);

async function loaded() {
  const hook = renderHook(() => usePlugins());
  await waitFor(() => expect(hook.result.current.plugins).toBeDefined());
  await waitFor(() => expect(hook.result.current.catalogs).toBeDefined());
  expect(mocks.plugins.list).toHaveBeenCalledTimes(1);
  return hook;
}

describe('usePlugins', () => {
  it('reloads the installed plugins after a successful "Check for updates"', async () => {
    const { result } = await loaded();
    expect(result.current.plugins?.[0]?.updateAvailable).toBeNull();

    // The refreshed catalog fills the server's update map, which plugins.list reads.
    mocks.plugins.list.mockResolvedValue({ plugins: [plugin({ updateAvailable: '1.1.0' })] });
    await act(() => result.current.checkForUpdates());

    expect(mocks.plugins.catalog).toHaveBeenLastCalledWith({ refresh: true });
    await waitFor(() => expect(result.current.plugins?.[0]?.updateAvailable).toBe('1.1.0'));
    expect(mocks.plugins.list).toHaveBeenCalledTimes(2);
  });

  it('a failed check keeps the list and does not reload it', async () => {
    const { result } = await loaded();
    mocks.plugins.catalog.mockRejectedValueOnce(new Error('offline'));
    await act(() => result.current.checkForUpdates());

    expect(result.current.checkError).toBeInstanceOf(Error);
    expect(result.current.checking).toBe(false);
    expect(mocks.plugins.list).toHaveBeenCalledTimes(1);
  });

  it('setCatalogs (a catalog added or removed) shows that answer and reloads the list', async () => {
    const { result } = await loaded();
    const out = catalogOutput({ catalogUrl: 'https://other.test/index.json' });
    mocks.plugins.list.mockResolvedValue({ plugins: [plugin({ updateAvailable: '2.0.0' })] });
    act(() => result.current.setCatalogs(out));

    expect(result.current.catalogs?.[0]?.catalogUrl).toBe('https://other.test/index.json');
    await waitFor(() => expect(result.current.plugins?.[0]?.updateAvailable).toBe('2.0.0'));
    expect(mocks.plugins.list).toHaveBeenCalledTimes(2);
  });
});
