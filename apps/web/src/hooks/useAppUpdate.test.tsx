import { act, cleanup, render, screen } from '@testing-library/react';
import type { AppUpdateOutput } from '@transcoda/contract';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../api/client.ts', () => ({ api: { system: { update: mocks.update } } }));

import { resetAppUpdate, useAppUpdate } from './useAppUpdate.ts';

function status(version: string | null): AppUpdateOutput {
  return {
    current: '1.4.0',
    checking: true,
    checkedAt: null,
    update: version
      ? { version, url: 'u', changelogUrl: 'c', releases: [], olderReleases: 0 }
      : null,
  };
}

function Probe({ name }: { name: string }) {
  const s = useAppUpdate();
  return <p>{`${name}: ${s ? (s.update?.version ?? 'none') : 'unknown'}`}</p>;
}

beforeEach(() => {
  resetAppUpdate();
  mocks.update.mockReset();
});
afterEach(cleanup);

it('gives every consumer the newest answer, even when an older one arrives last', async () => {
  const answers: ((s: AppUpdateOutput) => void)[] = [];
  mocks.update.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
  render(
    <>
      <Probe name="a" />
      <Probe name="b" />
    </>,
  );
  expect(answers).toHaveLength(2);
  await act(async () => answers[1]?.(status('1.6.0')));
  await act(async () => answers[0]?.(status(null)));
  expect(screen.getByText('a: 1.6.0')).toBeTruthy();
  expect(screen.getByText('b: 1.6.0')).toBeTruthy();
});

it('a consumer mounted later starts from the shared answer without fetching', async () => {
  mocks.update.mockResolvedValue(status('1.6.0'));
  const { rerender } = render(<Probe name="a" />);
  expect(await screen.findByText('a: 1.6.0')).toBeTruthy();
  rerender(
    <>
      <Probe name="a" />
      <Probe name="b" />
    </>,
  );
  expect(screen.getByText('b: 1.6.0')).toBeTruthy();
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
