import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: { get: vi.fn(), log: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() },
  workflows: { get: vi.fn(), list: vi.fn() },
  nodes: { list: vi.fn() },
  queue: { status: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import type { JobDetail } from '@transcoda/contract';
import { Route } from 'wouter';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { EventsProvider } from '../hooks/useEvents.ts';
import { jobWhenLine } from '../jobs/jobOutcome.ts';
import { fmtDate } from '../lib/time.ts';
import { fakeEventSource } from '../test/fakeEventStream.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import { jobDetail, runningJobDetail, SUB_ID, traceSub } from '../test/fixtures/trace.ts';
import { renderAt } from '../test/render.tsx';
import { JobPage } from './JobPage.tsx';

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  resetCatalogCache();
  mocks.events.subscribe.mockReset().mockImplementation(fakeEventSource().subscribe);
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.workflows.get.mockReset().mockResolvedValue({
    id: SUB_ID,
    name: 'Cleanup',
    kind: 'subworkflow',
    version: 3,
    graph: traceSub(),
  });
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.jobs.log.mockReset().mockResolvedValue({ log: '' });
  mocks.queue.status
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null }, preparing: [] });
});
afterEach(() => {
  cleanup();
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

async function open(job: JobDetail) {
  mocks.jobs.get.mockReset().mockResolvedValue(job);
  renderAt(
    '/jobs/j1',
    <EventsProvider>
      <Route path="/jobs/:id">
        <JobPage />
      </Route>
    </EventsProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  await act(async () => {});
}

function fact(term: string): HTMLElement | null {
  const dt = [...document.querySelectorAll('.job-facts dt')].find((n) => n.textContent === term);
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
}

const movie = (over: Partial<JobDetail> = {}) =>
  jobDetail({
    media: {
      kind: 'movie',
      title: 'Shepherd Jr.',
      year: 1924,
      season: null,
      episode: null,
      episodeTitle: null,
      source: 'filename',
      poster: true,
    },
    fileName: 'Shepherd Jr. (1924).mkv',
    filePath: '/media/Movies/Shepherd Jr. (1924)/Shepherd Jr. (1924).mkv',
    ...over,
  });

describe('JobPage header: title and poster', () => {
  it('a movie: the heading is the title, the year sits beside it, the poster is an image', async () => {
    await open(movie());
    expect(screen.getByRole('heading', { level: 1, name: 'Shepherd Jr.' })).toBeTruthy();
    expect(document.querySelector('.job-year')?.textContent).toBe('1924');
    const img = document.querySelector('.job-head .poster-page img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/v1/jobs/j1/poster');
    await waitFor(() => expect(document.title).toContain('Shepherd Jr. (1924)'));
  });

  it('an episode: the heading is the show and a line reads the code and the episode title', async () => {
    await open(
      jobDetail({
        media: {
          ...jobDetail().media,
          title: 'The Bramblewood Family',
          season: 1,
          episode: 17,
          episodeTitle: "Ada's Dilemma",
        },
      }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'The Bramblewood Family' })).toBeTruthy();
    expect(document.querySelector('.job-year')).toBeNull();
    expect(document.querySelector('.job-sub')?.textContent).toBe("S01E17 · Ada's Dilemma");
    // No poster on this job: the placeholder.
    expect(document.querySelector('.job-head .poster-empty')).not.toBeNull();
    expect(document.querySelector('.job-head .poster img')).toBeNull();
  });

  it('shows the full path and Copy path writes it, with a toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const job = movie();
    await open(job);
    expect(screen.getByText(job.filePath)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(job.filePath));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it("a refused write toasts that the path couldn't be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open(movie());
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(await screen.findByText("Couldn't copy the path")).toBeTruthy();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('the facts: Library, Workflow, Run and When, linked as before', async () => {
    const job = movie();
    await open(job);
    const list = document.querySelector('dl.job-facts') as HTMLElement;
    const link = (name: string) => within(list).getByRole('link', { name }) as HTMLAnchorElement;
    expect(fact('Library')?.textContent).toBe('Shows');
    expect(link('Shows').getAttribute('href')).toBe('/libraries');
    expect(link('TV cleanup v7').getAttribute('href')).toBe('/workflows/w1?version=7');
    expect(link('Run').getAttribute('href')).toBe('/runs/r1');
    expect(fact('Run')?.textContent).toBe('Run');
    expect(fact('When')?.textContent).toBe(jobWhenLine(job, true));
  });

  it('Encoded on shows for a started job with a GPU, not for a queued one', async () => {
    await open(movie({ encodedOn: 'GPU 1' }));
    expect(fact('Encoded on')?.textContent).toBe('GPU 1');
    cleanup();
    await open(movie({ state: 'queued', encodedOn: 'GPU 1' }));
    expect(fact('Encoded on')).toBeNull();
    expect(fact('Encoding on')).toBeNull();
  });

  it('Original kept until and Original restored show only with their data', async () => {
    await open(movie());
    expect(fact('Original kept until')).toBeNull();
    expect(fact('Original restored')).toBeNull();
    cleanup();
    const keptUntil = '2026-12-01T10:00:00.000Z';
    await open(movie({ recycled: { path: '/bin/x.mkv', keptUntil } }));
    expect(fact('Original kept until')?.textContent).toBe(fmtDate(keptUntil));
  });

  it('the cancel dialog is titled with the job title', async () => {
    await open(runningJobDetail({ state: 'encoding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('dialog', { name: 'Cancel Otter and Finch S01E01?' }),
    ).toBeTruthy();
  });
});
