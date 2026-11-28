import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Library, LibraryFile, NodeInfo } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';

const mocks = vi.hoisted(() => ({
  libraries: { get: vi.fn(), files: vi.fn() },
  jobs: { queue: vi.fn() },
  nodes: { list: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { resetCatalogCache } from '../hooks/use-catalog.ts';
import { EventsProvider } from '../hooks/use-events.ts';
import { fakeEventSource } from '../testing/fake-event-stream.ts';
import { job } from '../testing/fixtures/jobs.ts';
import { renderAt } from '../testing/render.tsx';
import { LibraryHealthPage } from './LibraryHealthPage.tsx';

const at = '2026-11-20T18:00:00.000Z';
const LIBRARY: Library = {
  id: 'l1',
  name: 'Movies',
  path: '/media/movies',
  recycleFolder: null,
  processHardlinked: false,
  verifyFullDecode: false,
  runHours: null,
  watchFolder: true,
  feeds: { workflowId: 'w1', name: 'Movie check', version: 2 },
  namedByInactive: [],
  createdAt: at,
  updatedAt: at,
};
const CLOCK = { now: at, timeZone: 'UTC' };
const REPLACE_STEP = 'Replace damaged file (Radarr)';

function damaged(id: string, title: string, reason: string, finishedAt: string): LibraryFile {
  const fileName = `${title} (1931).mkv`;
  const path = `/media/movies/${title} (1931)/${fileName}`;
  return {
    id,
    path,
    fileName,
    sizeBytes: 1000,
    originalBytes: null,
    mtime: at,
    gone: false,
    poster: null,
    latest: job({
      id: `j-${id}`,
      state: 'kept_original',
      media: {
        kind: 'movie',
        title,
        year: 1931,
        season: null,
        episode: null,
        episodeTitle: null,
        source: 'filename',
        poster: false,
      },
      fileName,
      filePath: path,
      libraryId: 'l1',
      libraryName: 'Movies',
      workflowId: 'w1',
      workflowName: 'Movie check',
      startedAt: finishedAt,
      finishedAt,
      reason,
      result: {
        outcome: 'kept_original',
        beforeBytes: 1000,
        afterBytes: null,
        replacedTo: null,
        sourceDamaged: true,
      },
    }),
  };
}

const FILES = [
  damaged(
    'f1',
    'Lanternfish',
    'source is damaged: decode errors at 00:12:04',
    '2026-11-20T17:00:00.000Z',
  ),
  damaged('f2', 'The Copper Kettle', 'source has decode errors; nothing was replaced', at),
];

function replaceNode(available = true): NodeInfo {
  return {
    type: 'radarr:replace-damaged',
    version: 1,
    kind: 'finish',
    title: REPLACE_STEP,
    description: '',
    icon: 'plug',
    inputs: [],
    outputs: [],
    settingsSchema: {},
    onNodeSettings: [],
    source: { kind: 'plugin', name: 'radarr', version: '1.1.0' },
    availability: available ? { available: true } : { available: false, reason: 'stopped' },
    finishPhase: 'library-manager',
    damagedOnly: true,
  };
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  resetCatalogCache();
  mocks.events.subscribe.mockReset().mockImplementation(fakeEventSource().subscribe);
  mocks.libraries.get.mockReset().mockResolvedValue({
    ...LIBRARY,
    clock: CLOCK,
    fileCount: 40,
    damagedCount: 2,
    replaceDamaged: [],
  });
  mocks.libraries.files.mockReset().mockResolvedValue({ files: FILES, total: 2 });
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: [] });
  mocks.jobs.queue.mockReset().mockResolvedValue({
    runId: 'r9',
    jobIds: ['j9'],
    dryRun: false,
    note: null,
    workflowVersion: 2,
    testEncode: false,
  });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  cleanup();
});

function open(path = '/libraries/l1/health') {
  return renderAt(
    path,
    <EventsProvider>
      <Route path="/libraries/:id/health">
        <LibraryHealthPage />
      </Route>
    </EventsProvider>,
  );
}

function phone() {
  window.matchMedia = (query: string) =>
    ({
      matches: query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

describe('LibraryHealthPage', () => {
  it('lists the damaged files, newest first, with what is wrong, when and a link to the job', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Damaged files' })).toBeTruthy();
    expect(mocks.libraries.files).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1', damaged: true, sort: 'lastRun', desc: true }),
    );
    const table = await screen.findByRole('table', { name: 'Damaged files' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    // The reason without the "source is damaged:" lead-in the whole page already says.
    expect(within(first).getByText('Decode errors at 00:12:04')).toBeTruthy();
    expect(
      within(first)
        .getByRole('link', { name: /Lanternfish/ })
        .getAttribute('href'),
    ).toBe('/libraries/l1/files/f1');
    expect(within(first).getByRole('link', { name: 'Job' }).getAttribute('href')).toBe(
      '/jobs/j-f1',
    );
    expect(within(first).getByText(/Movie check/)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Source has decode errors')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Movies' }).getAttribute('href')).toBe('/libraries/l1');
    expect(document.title).toMatch(/^Damaged files · Movies/);
  });

  it('says so when nothing is damaged', async () => {
    mocks.libraries.files.mockResolvedValue({ files: [], total: 0 });
    open();
    expect(await screen.findByText(/No damaged files in Movies/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows cards on a phone', async () => {
    phone();
    const { container } = open();
    await screen.findByRole('link', { name: /Lanternfish/ });
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelectorAll('.phone-card')).toHaveLength(2);
  });

  it('a library whose feeder has a Replace damaged file step offers Replace on each row', async () => {
    mocks.libraries.get.mockResolvedValue({
      ...LIBRARY,
      clock: CLOCK,
      fileCount: 40,
      damagedCount: 2,
      replaceDamaged: [REPLACE_STEP],
    });
    open();
    const buttons = await screen.findAllByRole('button', { name: /^Replace/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Replace Lanternfish?' });
    expect(dialog.textContent).toContain(
      `Movie check runs on this file again. If it is still damaged, ${REPLACE_STEP} asks Radarr`,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(mocks.jobs.queue).toHaveBeenCalledWith({
        path: FILES[0]?.path,
        workflowId: 'w1',
        dryRun: false,
        force: true,
        fileOnly: true,
      }),
    );
    expect(await screen.findByText(/Queued Lanternfish/)).toBeTruthy();
  });

  it('a refused Replace says why and stays on the page', async () => {
    mocks.libraries.get.mockResolvedValue({
      ...LIBRARY,
      clock: CLOCK,
      fileCount: 40,
      damagedCount: 2,
      replaceDamaged: [REPLACE_STEP],
    });
    mocks.jobs.queue.mockRejectedValue(
      new ORPCError('PATH_REJECTED', {
        defined: true,
        status: 400,
        message: 'rejected',
        data: { path: FILES[0]?.path, reason: 'file not found' },
      }),
    );
    open();
    fireEvent.click((await screen.findAllByRole('button', { name: /^Replace/ }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText("Couldn't queue Lanternfish: file not found")).toBeTruthy();
  });

  it('with the plugin set up but no step in the feeder, says where to add it; no Replace buttons', async () => {
    mocks.nodes.list.mockResolvedValue({ nodes: [replaceNode()] });
    open();
    const note = await screen.findByText(/can ask Radarr for a new copy/);
    expect(note.textContent).toMatch(`${REPLACE_STEP} can ask Radarr for a new copy`);
    expect(screen.getByRole('link', { name: 'Movie check' }).getAttribute('href')).toBe(
      '/workflows/w1',
    );
    expect(screen.queryByRole('button', { name: /^Replace/ })).toBeNull();
  });

  it('with no plugin step set up, points to Plugins', async () => {
    mocks.nodes.list.mockResolvedValue({ nodes: [replaceNode(false)] });
    open();
    await screen.findByRole('table', { name: 'Damaged files' });
    const link = await screen.findByRole('link', { name: 'Plugins' });
    expect(link.getAttribute('href')).toBe('/plugins');
    expect(screen.queryByRole('button', { name: /^Replace/ })).toBeNull();
  });

  it('an unknown library is not found', async () => {
    mocks.libraries.get.mockRejectedValue(
      new ORPCError('NOT_FOUND', { defined: true, status: 404, message: 'Not found' }),
    );
    open('/libraries/gone/health');
    expect(await screen.findByRole('link', { name: /Back to libraries/ })).toBeTruthy();
  });
});
