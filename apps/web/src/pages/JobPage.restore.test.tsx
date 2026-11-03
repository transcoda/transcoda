import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: {
    get: vi.fn(),
    log: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    queue: vi.fn(),
  },
  workflows: { get: vi.fn(), list: vi.fn() },
  libraries: { get: vi.fn() },
  nodes: { list: vi.fn() },
  queue: { status: vi.fn() },
  events: { subscribe: vi.fn() },
  recycle: { restore: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { ORPCError } from '@orpc/client';
import { Route, Switch } from 'wouter';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { EventsProvider } from '../hooks/useEvents.ts';
import { fmtDate } from '../lib/time.ts';
import { fakeEventSource } from '../test/fakeEventStream.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import { jobDetail, runningJobDetail } from '../test/fixtures/trace.ts';
import { renderAt } from '../test/render.tsx';
import { JobPage } from './JobPage.tsx';

const FILE = '/media/Shows/Tigger and Pooh/Tigger and Pooh S01E01.mkv';
const BIN = '/media/Shows/.transcoda-recycle/Tigger and Pooh/Tigger and Pooh S01E01.mkv';
const KEPT = '2026-11-09T10:00:00.000Z';
const AT = '2026-11-03T08:30:00.000Z';

let fake: ReturnType<typeof fakeEventSource>;

function recycledJob(over: Parameters<typeof jobDetail>[0] = {}) {
  const base = jobDetail({ state: 'done' });
  return {
    ...base,
    result: base.result && {
      ...base.result,
      outcome: 'done' as const,
      replacedTo: 'recycle' as const,
    },
    recycled: { path: BIN, keptUntil: KEPT },
    ...over,
  };
}

beforeEach(() => {
  resetCatalogCache();
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.workflows.get
    .mockReset()
    .mockResolvedValue({ id: 'w1', name: 'TV cleanup', kind: 'workflow', version: 7 });
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.jobs.get.mockReset().mockResolvedValue(recycledJob());
  mocks.jobs.log.mockReset().mockResolvedValue({ log: '' });
  mocks.libraries.get.mockReset();
  mocks.recycle.restore.mockReset();
  mocks.queue.status
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null }, preparing: [] });
});
afterEach(() => cleanup());

async function open() {
  const view = renderAt(
    '/jobs/j1',
    <EventsProvider>
      <Switch>
        <Route path="/jobs/:id">
          <JobPage />
        </Route>
      </Switch>
    </EventsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Tigger and Pooh S01E01.mkv' });
  await act(async () => {});
  return view;
}

describe('JobPage: Restore original', () => {
  it('a done job with a recycled original shows Restore original and when the original goes', async () => {
    await open();
    expect(await screen.findByRole('button', { name: 'Restore original' })).toBeTruthy();
    expect(screen.getByText(`Original kept until ${fmtDate(KEPT)}`)).toBeTruthy();
  });

  it('Restore original asks first, then restores and reloads the job', async () => {
    mocks.recycle.restore.mockResolvedValue({
      jobId: 'j1',
      direction: 'restored',
      notRestored: [],
    });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore original' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore the original of Tigger and Pooh S01E01.mkv?',
    });
    expect(
      within(dialog).getByText(
        `The original goes back to ${FILE}. Transcoda's version moves to the recycle folder, so you can undo this from there.`,
      ),
    ).toBeTruthy();
    expect(mocks.recycle.restore).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore original' }));
    await waitFor(() => expect(mocks.recycle.restore).toHaveBeenCalledWith({ path: BIN }));
    await waitFor(() => expect(mocks.jobs.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Original restored')).toBeTruthy();
  });

  it('names the subtitle files that stayed', async () => {
    mocks.recycle.restore.mockResolvedValue({
      jobId: 'j1',
      direction: 'restored',
      notRestored: ['a.de.srt (its place is taken)'],
    });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore original' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore original' }));
    expect(
      await screen.findByText('Original restored; not brought back: a.de.srt (its place is taken)'),
    ).toBeTruthy();
  });

  it("a refusal is a toast with the server's reason", async () => {
    mocks.recycle.restore.mockRejectedValue(
      new ORPCError('RECYCLE_REFUSED', {
        defined: true,
        status: 409,
        message: 'The recycle folder action was refused',
        data: { reason: 'The original is no longer in the recycle folder (removed by hand).' },
      }),
    );
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore original' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore original' }));
    expect(
      await screen.findByText(
        "Couldn't restore the original: The original is no longer in the recycle folder (removed by hand).",
      ),
    ).toBeTruthy();
  });

  it('a restored job says when and by whom, and offers no Restore', async () => {
    mocks.jobs.get.mockResolvedValue(
      recycledJob({
        recycled: null,
        restore: { restoredAt: AT, restoredBy: 'jan', outputPath: `${BIN}.1` },
      }),
    );
    await open();
    expect(screen.getByText(`Original restored on ${fmtDate(AT)} by jan`)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Undo from the recycle folder' }).getAttribute('href'),
    ).toBe('/recycle?library=l1');
    expect(screen.queryByRole('button', { name: 'Restore original' })).toBeNull();
  });

  it('no Restore on a running job, a dry run, or a job without a recycled original', async () => {
    mocks.jobs.get.mockResolvedValue({
      ...runningJobDetail(),
      recycled: { path: BIN, keptUntil: KEPT },
    });
    await open();
    expect(screen.queryByRole('button', { name: 'Restore original' })).toBeNull();
    cleanup();

    mocks.jobs.get.mockResolvedValue(recycledJob({ state: 'dry_run', dryRun: true }));
    await open();
    expect(screen.queryByRole('button', { name: 'Restore original' })).toBeNull();
    cleanup();

    mocks.jobs.get.mockResolvedValue(recycledJob({ recycled: null }));
    await open();
    expect(screen.queryByRole('button', { name: 'Restore original' })).toBeNull();
  });
});
