import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  activate: vi.fn(),
  versions: vi.fn(),
  get: vi.fn(),
  duplicate: vi.fn(),
}));
const otherMocks = vi.hoisted(() => ({
  jobsList: vi.fn(),
  nodesList: vi.fn(),
  librariesList: vi.fn(),
  browse: vi.fn(),
  queue: vi.fn(),
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      workflows: mocks,
      jobs: { list: otherMocks.jobsList, queue: otherMocks.queue },
      nodes: { list: otherMocks.nodesList },
      libraries: { list: otherMocks.librariesList, browse: otherMocks.browse },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { WorkflowsPage } from './WorkflowsPage.tsx';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function summary(over: Partial<WorkflowSummary>): WorkflowSummary {
  return {
    id: 'w',
    name: 'w',
    kind: 'workflow',
    active: null,
    currentVersion: 1,
    valid: true,
    errorCount: 0,
    usesOutdatedSubworkflow: false,
    feedsLibrary: null,
    libraryInput: null,
    usedBy: [],
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(5),
    ...over,
  };
}

function activeV(version: number, runnable: boolean): WorkflowSummary['active'] {
  return { version, runnable, activatedAt: minutesAgo(60), activatedBy: 'u1' };
}

const rows: WorkflowSummary[] = [
  summary({ id: 'w1', name: 'TV cleanup', active: activeV(7, true), currentVersion: 7 }),
  summary({
    id: 'w2',
    name: 'Movies',
    valid: false,
    errorCount: 2,
    active: activeV(3, false),
    currentVersion: 3,
  }),
  summary({
    id: 's1',
    name: 'Audio tidy',
    kind: 'subworkflow',
    currentVersion: 2,
    usedBy: [
      { id: 'w1', name: 'TV cleanup' },
      { id: 'w2', name: 'Movies' },
    ],
  }),
];

const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({ workflows: rows });
  mocks.create.mockReset();
  mocks.save.mockReset();
  mocks.rename.mockReset();
  mocks.delete.mockReset();
  mocks.activate.mockReset();
  mocks.versions.mockReset().mockResolvedValue({ versions: [] });
  mocks.get.mockReset().mockRejectedValue(new Error('not needed here'));
  otherMocks.jobsList.mockReset().mockResolvedValue({ jobs: [] });
  otherMocks.nodesList.mockReset().mockResolvedValue({ nodes: [] });
  otherMocks.librariesList.mockReset().mockResolvedValue({ libraries: [], notices: [] });
  resetCatalogCache();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('WorkflowsPage', () => {
  it('lists workflows first, then a "Sub-workflows" section with its own h2 and count', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Audio tidy' });
    const wfHeading = screen.getByRole('heading', { level: 2, name: /^Workflows\b/ });
    const subHeading = screen.getByRole('heading', { level: 2, name: /^Sub-workflows\b/ });
    expect(wfHeading.textContent).toContain('2');
    expect(subHeading.textContent).toContain('1');
    const wfTable = screen.getByRole('table', { name: /^Workflows\b/ });
    const subTable = screen.getByRole('table', { name: /^Sub-workflows\b/ });
    expect(within(wfTable).getByRole('link', { name: 'TV cleanup' })).toBeTruthy();
    expect(within(wfTable).getByRole('link', { name: 'Movies' })).toBeTruthy();
    expect(within(wfTable).queryByRole('link', { name: 'Audio tidy' })).toBeNull();
    expect(within(subTable).getByRole('link', { name: 'Audio tidy' })).toBeTruthy();
    expect(within(subTable).getByText('TV cleanup, Movies').getAttribute('title')).toBe(
      'TV cleanup, Movies',
    );
    expect(
      wfHeading.compareDocumentPosition(subHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      wfTable.compareDocumentPosition(subTable) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides a section that has no rows', async () => {
    mocks.list.mockResolvedValue({ workflows: [rows[0] as WorkflowSummary] });
    const first = renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'TV cleanup' });
    expect(screen.queryByRole('heading', { level: 2, name: /^Sub-workflows/ })).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    first.unmount?.();
    cleanup();
    mocks.list.mockResolvedValue({ workflows: [rows[2] as WorkflowSummary] });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Audio tidy' });
    expect(screen.queryByRole('heading', { level: 2, name: /^Workflows/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: /^Sub-workflows/ })).toBeTruthy();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Start with where files come from' })).toBeNull();
  });

  it('styles the section heads next to the workflow table rules', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.wf-section-head\s*\{/);
    expect(css).toMatch(/\.wf-count\s*\{[^}]*color:\s*var\(--muted\)/);
  });

  it('the page title says "Workflows" once, with the count beside it; the table heading is for screen readers', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Audio tidy' });
    const title = screen.getByRole('heading', { level: 1, name: 'Workflows' });
    const count = title.parentElement?.querySelector('.wf-count') as HTMLElement;
    expect(count.textContent).toBe('2');
    expect(count.getAttribute('aria-hidden')).toBe('true');
    const wfHeading = screen.getByRole('heading', { level: 2, name: /^Workflows\b/ });
    expect(wfHeading.className).toBe('sr-only');
    expect(wfHeading.textContent).toBe('Workflows 2');
    const subHeading = screen.getByRole('heading', { level: 2, name: /^Sub-workflows\b/ });
    expect(subHeading.className).toBe('wf-section-head');
  });

  it('the workflow table has Name, Library, Active, Last edited and the row menu; no Status column', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'TV cleanup' });
    const wfTable = screen.getByRole('table', { name: /^Workflows\b/ });
    expect(
      within(wfTable)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Library', 'Active', 'Last edited', 'Actions']);
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Version' })).toBeNull();
  });

  it('the Library column names the library a workflow processes, or says it runs on a file only', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({
          id: 'a',
          name: 'Shows',
          active: activeV(2, true),
          currentVersion: 2,
          feedsLibrary: { id: 'l1', name: 'TV' },
        }),
        summary({ id: 'b', name: 'Loose', currentVersion: 1 }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Shows' });
    const shows = rowOf('Shows').querySelector('.wf-library') as HTMLElement;
    expect(shows.textContent).toBe('TV');
    expect(within(shows).getByText('TV').getAttribute('title')).toBe('TV');
    const loose = within(rowOf('Loose')).getByText('Run on a file only');
    expect(loose.className).toContain('wf-quiet');
  });

  it('lists active workflows first, then the rest, each A–Z ignoring case; sub-workflows A–Z', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: '1', name: 'zebra' }),
        summary({ id: '2', name: 'Movies', active: activeV(1, true) }),
        summary({ id: '3', name: 'apple' }),
        summary({ id: '4', name: 'anime', active: activeV(1, false) }),
        summary({ id: '5', name: 'Banana' }),
        summary({ id: 's1', name: 'tidy', kind: 'subworkflow' }),
        summary({ id: 's2', name: 'Audio', kind: 'subworkflow' }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'zebra' });
    const names = (table: RegExp) =>
      within(screen.getByRole('table', { name: table }))
        .getAllByRole('link')
        .map((a) => a.textContent);
    expect(names(/^Workflows\b/)).toEqual(['anime', 'Movies', 'apple', 'Banana', 'zebra']);
    expect(names(/^Sub-workflows\b/)).toEqual(['Audio', 'tidy']);
  });

  it('a valid row shows no chip; problems show as chips next to the name', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'TV cleanup' });
    expect(rowOf('TV cleanup').querySelector('.chip')).toBeNull();
    expect(rowOf('Audio tidy').querySelector('.chip')).toBeNull();
    expect(screen.queryByText('Valid')).toBeNull();
    const name = rowOf('Movies').querySelector('.wf-name') as HTMLElement;
    expect(within(name).getByText('2 errors')).toBeTruthy();
    expect(within(name).getByText("can't run")).toBeTruthy();
  });

  it('Last edited shows an older date this year without the year, and the full date as its title', async () => {
    // Only Date is faked, so the list's promises and waitFor still run on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T12:00:00'));
    const thisYear = new Date('2026-01-02T12:00:00').toISOString();
    const lastYear = new Date('2025-10-27T12:00:00').toISOString();
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: 'a', name: 'Old', currentVersion: 12, updatedAt: thisYear }),
        summary({ id: 'b', name: 'Older', currentVersion: 1, updatedAt: lastYear }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Old' });
    const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
    const edited = (name: string) =>
      (rowOf(name).querySelector('.wf-version span') as HTMLElement) ?? null;
    expect(edited('Old').textContent).toBe(`v12 · ${day.format(new Date(thisYear))}`);
    expect(edited('Old').getAttribute('title')).toBe(new Date(thisYear).toLocaleString());
    expect(edited('Older').textContent).toContain(String(new Date(lastYear).getFullYear()));
  });

  it('a sub-workflow used by nothing says "Not used"', async () => {
    mocks.list.mockResolvedValue({
      workflows: [summary({ id: 's', name: 'Spare', kind: 'subworkflow' })],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Spare' });
    expect(within(rowOf('Spare')).getByText('Not used').className).toContain('wf-quiet');
    expect(within(rowOf('Spare')).queryByText(/Used by/)).toBeNull();
  });

  it('a sub-workflow row has no ACTIVE column or activation chip, and no review chip', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        rows[0] as WorkflowSummary,
        summary({
          id: 's2',
          name: 'Lang tidy',
          kind: 'subworkflow',
          usedBy: [{ id: 'w1', name: 'TV cleanup' }],
        }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Lang tidy' });
    const sub = rowOf('Lang tidy');
    expect(within(sub).queryByRole('button', { name: /^Activate/ })).toBeNull();
    const subTable = screen.getByRole('table', { name: /^Sub-workflows\b/ });
    expect(within(subTable).queryByRole('columnheader', { name: 'Active' })).toBeNull();
    expect(
      within(subTable)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Used by', 'Last edited', 'Actions']);
    expect(sub.textContent).not.toContain('never active');
    expect(sub.querySelector('.activation-pill')).toBeNull();
    expect(within(sub).queryByText("can't run")).toBeNull();
    expect(sub.querySelector('.chip')).toBeNull();
    expect(within(sub).getByText('TV cleanup').getAttribute('title')).toBe('TV cleanup');
    expect(within(rowOf('TV cleanup')).getByText('Active v7')).toBeTruthy();
  });

  it('the used-by column spans library and active, so both tables end alike; no kind eyebrow', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Audio tidy' });
    const colClasses = (name: RegExp) =>
      [...screen.getByRole('table', { name }).querySelectorAll('col')].map((c) => c.className);
    expect(colClasses(/^Workflows\b/)).toEqual([
      'wf-col-name',
      'wf-col-library',
      'wf-col-active',
      'wf-col-edited',
      'wf-col-actions',
    ]);
    expect(colClasses(/^Sub-workflows\b/)).toEqual([
      'wf-col-name',
      'wf-col-used-by',
      'wf-col-edited',
      'wf-col-actions',
    ]);
    expect(document.querySelector('.eyebrow-kind')).toBeNull();
    expect(screen.queryByText('Workflow')).toBeNull();
    expect(screen.queryByText('Sub-workflow')).toBeNull();
  });

  it('lists name, active pill, problem chips and the version once, with when it was edited', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'TV cleanup' });

    const tv = rowOf('TV cleanup');
    expect(within(tv).getByText('Active v7')).toBeTruthy();
    expect(within(tv).getByText('v7 · 5 min ago')).toBeTruthy();
    expect(within(tv).getAllByText(/\bv7\b/)).toHaveLength(2); // "Active v7" and "v7 · 5 min ago"
    expect(screen.getByRole('link', { name: 'TV cleanup' }).getAttribute('href')).toBe(
      '/workflows/w1',
    );

    const movies = rowOf('Movies');
    expect(within(movies).getByText('Active v3')).toBeTruthy();
    expect(within(movies).getByText('2 errors')).toBeTruthy();
    expect(within(movies).getByText("can't run").closest('[title]')?.getAttribute('title')).toBe(
      "This version can't run; open the workflow to see why",
    );
    expect(within(movies).getByText(/^v3 · \d+ min ago/)).toBeTruthy();

    const sub = rowOf('Audio tidy');
    const usedBy = within(sub).getByText('TV cleanup, Movies');
    expect(usedBy.getAttribute('title')).toBe('TV cleanup, Movies');
    expect(within(sub).queryByText('Outdated sub-workflow')).toBeNull();

    expect(screen.getByRole('link', { name: 'New workflow' }).getAttribute('href')).toBe(
      '/workflows/new?kind=workflow',
    );
    // One entry point: the new-workflow page offers workflow or sub-workflow.
    expect(screen.queryByRole('link', { name: 'New sub-workflow' })).toBeNull();
  });

  it('shows the error count in the singular and the outdated sub-workflow chip', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: 'a', name: 'One', valid: false, errorCount: 1 }),
        summary({ id: 'b', name: 'Two', usesOutdatedSubworkflow: true }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'One' });
    expect(within(rowOf('One')).getByText('1 error')).toBeTruthy();
    const outdated = within(rowOf('Two')).getByText('Outdated sub-workflow');
    // Amber like the can't-run chip, not a colour of its own.
    expect(outdated.className).toBe('chip chip-warning');
    expect(within(rowOf('Two')).getAllByText(/./, { selector: '.chip' })).toHaveLength(1);
  });

  it('shows an "Invalid" chip for an invalid workflow that reports no error count', async () => {
    mocks.list.mockResolvedValue({
      workflows: [summary({ id: 'a', name: 'Odd', valid: false, errorCount: 0 })],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Odd' });
    expect(within(rowOf('Odd')).getByText('Invalid')).toBeTruthy();
    expect(within(rowOf('Odd')).queryByText('Valid')).toBeNull();
  });

  it('shows a load error with Try again and recovers on reload', async () => {
    mocks.list
      .mockReset()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ workflows: rows });
    renderAt('/', <WorkflowsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the workflows: Could not reach the server');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Movies' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the empty state with the screen copy when there are no workflows', async () => {
    mocks.list.mockResolvedValue({ workflows: [] });
    renderAt('/', <WorkflowsPage />);
    expect(
      await screen.findByRole('heading', { name: 'Start with where files come from' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Add a trigger, then the actions you want in the single ffmpeg rewrite, then what happens after it is verified.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a trigger' })).toBeTruthy();
    // The three core examples, each with what it does; no plugin example and no TV cleanup.
    const examples = within(screen.getByRole('group', { name: 'Or start from an example' }))
      .getAllByRole('button')
      .map((b) => [b.querySelector('strong')?.textContent, (b as HTMLButtonElement).disabled]);
    expect(examples).toEqual([
      ['Save space', false],
      ['Play everywhere', false],
      ['Keep my languages', false],
    ]);
    expect(screen.getByRole('button', { name: /^Save space/ }).textContent).toContain(
      'at least 15% smaller',
    );
    expect(screen.queryByText(/TV cleanup/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Examples' })).toBeNull();
    // The shortcut lives in the editor: the hint says so instead of promising it here.
    expect(screen.getByText(/to search nodes/).textContent).toBe(
      'In the editor, press / to search nodes',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('empty state: "Add a trigger" creates "Untitled workflow" and navigates with ?focus=palette', async () => {
    mocks.list.mockResolvedValue({ workflows: [] });
    const pending = deferred<WorkflowSummary>();
    mocks.create.mockReturnValue(pending.promise);
    const view = renderAt('/', <WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a trigger' }));
    expect(mocks.create).toHaveBeenCalledWith({ name: 'Untitled workflow', kind: 'workflow' });
    // Busy while pending: both actions are disabled.
    expect(isDisabled(screen.getByRole('button', { name: 'Add a trigger' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: /^Save space/ }))).toBe(true);
    pending.resolve(summary({ id: 'new1', name: 'Untitled workflow' }));
    await waitFor(() => expect(view.location()).toBe('/workflows/new1?focus=palette'));
  });

  it('"Add a trigger" failing shows an error toast and enables the buttons again', async () => {
    mocks.list.mockResolvedValue({ workflows: [] });
    mocks.create.mockRejectedValue(new TypeError('Failed to fetch'));
    const view = renderAt('/', <WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a trigger' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not create the workflow: Could not reach the server',
    );
    expect(isDisabled(screen.getByRole('button', { name: 'Add a trigger' }))).toBe(false);
    expect(view.location()).toBe('/');
  });

  it('empty state: an example becomes a workflow whose version 1 is its graph, and opens it', async () => {
    mocks.list.mockResolvedValue({ workflows: [] });
    const pending = deferred<unknown>();
    mocks.create.mockReturnValueOnce(pending.promise);
    const view = renderAt('/', <WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Keep my languages/ }));
    expect(isDisabled(screen.getByRole('button', { name: 'Add a trigger' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: /^Save space/ }))).toBe(true);
    pending.resolve({ id: 'k1', version: 1 });
    await waitFor(() => expect(view.location()).toBe('/workflows/k1'));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Keep my languages',
        kind: 'workflow',
        graph: expect.any(Object),
      }),
    );
  });

  it('an example failing shows an error toast and stays on the list', async () => {
    mocks.list.mockResolvedValue({ workflows: [] });
    mocks.create.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = renderAt('/', <WorkflowsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Save space/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not create the Save space example: Could not reach the server',
    );
    expect(isDisabled(screen.getByRole('button', { name: /^Save space/ }))).toBe(false);
    expect(view.location()).toBe('/');
  });

  it('a non-empty list offers the example from the header "Examples" menu', async () => {
    mocks.create.mockResolvedValueOnce({ id: 's1', version: 1 });
    const view = renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    expect(screen.queryByRole('button', { name: 'Add a trigger' })).toBeNull();
    const menuButton = screen.getByRole('button', { name: 'Examples' });
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menuButton);
    const menu = screen.getByRole('menu', { name: 'Examples' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Start from “Save space” example',
      'Start from “Play everywhere” example',
      'Start from “Keep my languages” example',
      'Start from “Keep my languages with plugins” exampleneeds the Sonarr, Jellyfin and ntfy plugins',
      'Import a workflow file…',
    ]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(items[0] as HTMLElement);
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(view.location()).toBe('/workflows/s1'));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('the row menu offers "Run on a file" for a workflow (first), disabled with its reason when it cannot run, and never for a sub-workflow', async () => {
    mocks.list.mockResolvedValue({
      workflows: [...rows, summary({ id: 'w3', name: 'Drafts', currentVersion: 2 })],
    });
    otherMocks.browse.mockReset().mockResolvedValue({ dirs: [], files: [] });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for TV cleanup' }));
    let menu = screen.getByRole('menu', { name: 'Actions for TV cleanup' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Run on a file', 'Dry run on a file', 'Duplicate', 'Rename', 'Delete']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Run on a file' }));
    expect(await screen.findByRole('dialog', { name: 'Run TV cleanup v7 on a file' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    menu = screen.getByRole('menu', { name: 'Actions for Movies' });
    const blocked = within(menu).getByRole('menuitem', { name: 'Run on a file' });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    expect(blocked.getAttribute('title')).toBe("v3 can't run. Activate a version that runs");
    fireEvent.keyDown(blocked, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Drafts' }));
    menu = screen.getByRole('menu', { name: 'Actions for Drafts' });
    const off = within(menu).getByRole('menuitem', { name: 'Run on a file' });
    expect(off.getAttribute('title')).toBe('Activate a version to run for real');
    fireEvent.click(off);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(off, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Audio tidy' }));
    menu = screen.getByRole('menu', { name: 'Actions for Audio tidy' });
    expect(within(menu).queryByRole('menuitem', { name: 'Run on a file' })).toBeNull();
    expect(otherMocks.queue).not.toHaveBeenCalled();
  });

  it('a bundled example becomes a workflow whose version 1 is its graph, and opens it', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'd1', version: 1 });
    const view = renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Examples' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Start from “Save space” example/ }));
    await waitFor(() => expect(view.location()).toBe('/workflows/d1'));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Save space', kind: 'workflow', graph: expect.any(Object) }),
    );
  });

  it('imports a workflow file under a name from the file name; a file that is not JSON says so', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'i1', version: 1 });
    const view = renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    const input = screen.getByLabelText('Workflow file to import') as HTMLInputElement;
    const graph = { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] };
    fireEvent.change(input, {
      target: { files: [new File([JSON.stringify(graph)], 'my-movie_flow.json')] },
    });
    await waitFor(() => expect(view.location()).toBe('/workflows/i1'));
    expect(mocks.create).toHaveBeenCalledWith({ name: 'My movie flow', kind: 'workflow', graph });

    fireEvent.change(input, { target: { files: [new File(['nope'], 'notes.txt')] } });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'notes.txt is not a JSON file.',
    );
  });

  it('Duplicate copies a workflow as "<name> copy" and reloads the list', async () => {
    mocks.duplicate.mockResolvedValue({ id: 'w9' });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for TV cleanup' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(mocks.duplicate).toHaveBeenCalledWith({
        id: expect.any(String),
        name: 'TV cleanup copy',
      }),
    );
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it('a disabled row item shows its reason under it, not only as a tooltip', async () => {
    mocks.list.mockResolvedValue({
      workflows: [...rows, summary({ id: 'w3', name: 'Drafts', currentVersion: 2 })],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Drafts' }));
    const hint = screen.getByText('Activate a version to run for real');
    expect(hint.className).toBe('row-menu-hint');
  });

  it('Escape closes the "Examples" menu and returns focus to its button', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    const menuButton = screen.getByRole('button', { name: 'Examples' });
    fireEvent.click(menuButton);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('the rename input sits in the name cell next to an Enter/Esc hint, which describes it', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'New name for Movies' });
    const hint = screen.getByText('Enter to save · Esc to cancel');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    // The cell stays a table cell: renaming does not turn the row into something else.
    const cell = input.closest('td') as HTMLElement;
    expect(cell.className).toContain('wf-name');
    expect(cell.querySelector('.wf-name-line')).not.toBeNull();
  });

  it('renames inline and calls workflows.rename with the trimmed name', async () => {
    mocks.rename.mockResolvedValue(summary({ id: 'w2', name: 'Films' }));
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'New name for Movies' });
    fireEvent.change(input, { target: { value: '  Films  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith({ id: 'w2', name: 'Films' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('textbox', { name: 'New name for Movies' })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Actions for Movies' }),
      ),
    );
  });

  it('keeps the rename input focused with its text after a failed save', async () => {
    mocks.rename.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'New name for Movies' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Films' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not rename Movies: Could not reach the server',
    );
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Films');
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('cancels the inline rename with Escape', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'New name for Movies' });
    fireEvent.change(input, { target: { value: 'Other' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Movies' })).toBeTruthy();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Movies' }));
  });

  it('delete asks for confirmation and shows the IN_USE names when the server refuses', async () => {
    mocks.delete.mockRejectedValue(
      new ORPCError('IN_USE', {
        defined: true,
        status: 409,
        message: 'The sub-workflow is used by other workflows',
        data: {
          usedBy: [
            { id: 'w1', name: 'TV cleanup' },
            { id: 'w2', name: 'Movies' },
          ],
        },
      }),
    );
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Audio tidy' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Audio tidy' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Audio tidy?' });
    expect(
      within(dialog).getByText(
        'This removes the workflow and its versions. Jobs that already ran keep their history.',
      ),
    ).toBeTruthy();
    expect(mocks.delete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith({ id: 's1' }));

    const used = await within(dialog).findByRole('alert');
    expect(used.textContent).toBe(
      'Used by: TV cleanup, Movies — open them to remove the reference first',
    );
    expect(within(used).getByRole('link', { name: 'TV cleanup' }).getAttribute('href')).toBe(
      '/workflows/w1',
    );
    expect(within(used).getByRole('link', { name: 'Movies' }).getAttribute('href')).toBe(
      '/workflows/w2',
    );
    expect(within(dialog).queryByText(/This removes the workflow/)).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('a successful delete moves focus to the list heading, not the removed row (final review)', async () => {
    mocks.delete.mockResolvedValue({ ok: true });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Audio tidy' });
    mocks.list.mockResolvedValue({ workflows: rows.filter((w) => w.id !== 's1') });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Audio tidy' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Audio tidy?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Audio tidy' })).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 1, name: 'Workflows' }),
    );
  });

  it('focuses Cancel in the delete dialog and shows other failures inline with Try again', async () => {
    mocks.delete
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Movies?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Could not reach the server');
    expect(screen.getByRole('dialog', { name: 'Delete Movies?' })).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('returns focus to the row actions button when the delete dialog is cancelled', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    const actions = screen.getByRole('button', { name: 'Actions for Movies' });
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Movies?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(actions);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('deletes after confirmation and reloads the list', async () => {
    mocks.delete.mockResolvedValue({ ok: true });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Movies' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Movies' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Movies?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith({ id: 'w2' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Active column: Active v7, and a can\'t-run "Active v3" with the reason as its title; none for a sub-workflow', async () => {
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'TV cleanup' });
    expect(within(rowOf('TV cleanup')).getByText('Active v7')).toBeTruthy();
    const movies = within(rowOf('Movies')).getByText('Active v3');
    expect(movies.closest('[title]')?.getAttribute('title')).toBe(
      "This version can't run; open the workflow to see why",
    );
    expect(screen.getAllByRole('columnheader', { name: 'Active' })).toHaveLength(1);
    expect(screen.queryByRole('columnheader', { name: 'MODE' })).toBeNull();
  });

  it('a can\'t-run pill shows "Active v3" (the name\'s chip says can\'t run), read as "Active v3 · can\'t run" plus the reason', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        // Active and newest are the same version: the pill is not inside an Activate button.
        summary({ id: 'g', name: 'Gate', active: activeV(3, false), currentVersion: 3 }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Gate' });
    const row = rowOf('Gate');
    const visible = within(row).getByText('Active v3');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    const pill = visible.closest('.activation-pill') as HTMLElement;
    expect(pill.className).toContain('is-danger');
    // What a screen reader reaches: the full wording, then the reason.
    const spoken = within(pill).getByText("Active v3 · can't run");
    expect(spoken.className).toContain('sr-only');
    expect(
      within(pill).getByText("This version can't run; open the workflow to see why").className,
    ).toContain('sr-only');
    expect(within(row).queryByText("Active v3 · can't run", { ignore: '.sr-only' })).toBeNull();
  });

  it('a runnable or inactive pill keeps its one visible text (no shortened copy)', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: 'n', name: 'Fresh', currentVersion: 1 }),
        summary({ id: 'a', name: 'Live', active: activeV(2, true), currentVersion: 2 }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Fresh' });
    expect(within(rowOf('Live')).getByText('Active v2').getAttribute('aria-hidden')).toBeNull();
    expect(within(rowOf('Fresh')).getByText('Not active').getAttribute('aria-hidden')).toBeNull();
  });

  it('"Not active" is quiet text, not a pill; a live version is the lime "Active vN" pill', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: 'n', name: 'Fresh', currentVersion: 1 }),
        summary({ id: 'a', name: 'Live', active: activeV(2, true), currentVersion: 2 }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Fresh' });
    const off = within(rowOf('Fresh')).getByText('Not active');
    expect(off.className).toBe('wf-activate');
    expect(rowOf('Fresh').querySelector('.activation-pill')).toBeNull();
    const on = within(rowOf('Live')).getByText('Active v2');
    expect(on.className).toContain('is-active');
  });

  it('a workflow that was never activated shows "Not active"', async () => {
    mocks.list.mockResolvedValue({
      workflows: [summary({ id: 'n', name: 'Fresh', currentVersion: 1 })],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Fresh' });
    expect(within(rowOf('Fresh')).getByText('Not active')).toBeTruthy();
  });

  it("the can't-run reason is reachable without hover: in the pill, in the can't-run chip, and as the Activate button's name and description", async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: 'x', name: 'Broke', active: activeV(3, false), currentVersion: 6 }),
        summary({ id: 'y', name: 'Fine', active: activeV(3, true), currentVersion: 6 }),
        summary({ id: 'z', name: 'Idle', currentVersion: 2 }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'Broke' });
    const reason = "This version can't run; open the workflow to see why";
    const broke = screen.getByRole('button', {
      name: "v6 not activated: activate v6 of Broke (active: v3 · can't run)",
    });
    expect(broke.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(broke.getAttribute('aria-describedby') as string)?.textContent,
    ).toBe(reason);
    expect(within(rowOf('Broke')).getByText(`: ${reason}`)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'v6 not activated: activate v6 of Fine (active: v3)' }),
    ).toBeTruthy();
    const idle = screen.getByRole('button', { name: 'Not active: activate v2 of Idle' });
    // A quiet text button, no bordered button box.
    expect(idle.className).toBe('wf-activate');
    expect(idle.textContent).toBe('Not active');
  });

  it('shows a "v6 not activated" button under the pill that opens the dialog; plain text when the newest has errors; nothing when the newest is the active one', async () => {
    mocks.list.mockResolvedValue({
      workflows: [
        summary({ id: 'a', name: 'TV cleanup', active: activeV(2, true), currentVersion: 6 }),
        summary({
          id: 'b',
          name: 'Broken',
          active: activeV(2, true),
          currentVersion: 6,
          valid: false,
          errorCount: 1,
        }),
        summary({ id: 'c', name: 'Current', active: activeV(4, true), currentVersion: 4 }),
      ],
    });
    renderAt('/', <WorkflowsPage />);
    await screen.findByRole('link', { name: 'TV cleanup' });
    const offer = within(rowOf('TV cleanup')).getByRole('button', { name: /^v6 not activated/ });
    expect(offer.textContent).toBe('v6 not activated');
    expect(within(rowOf('TV cleanup')).queryByText(/newest/)).toBeNull();
    expect(within(rowOf('Broken')).getByText('v6 not activated').tagName).toBe('SPAN');
    expect(within(rowOf('Broken')).queryByRole('button', { name: /activate/i })).toBeNull();
    expect(within(rowOf('Current')).queryByRole('button', { name: /activate/i })).toBeNull();
    expect(within(rowOf('Current')).queryByText(/not activated/)).toBeNull();
    fireEvent.click(offer);
    expect(await screen.findByRole('dialog', { name: /Activate/ })).toBeTruthy();
  });

  it('activating from the list reloads the list', async () => {
    const tv = summary({ id: 'w1', name: 'TV cleanup', currentVersion: 7 });
    mocks.list
      .mockResolvedValueOnce({ workflows: [tv] })
      .mockResolvedValue({ workflows: [{ ...tv, active: activeV(7, true) }] });
    mocks.activate.mockResolvedValue({ ...tv, active: activeV(7, true) });
    renderAt('/', <WorkflowsPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Not active: activate v7 of TV cleanup' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Activate/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Activate/ }));
    expect(mocks.activate).toHaveBeenCalledWith({ id: 'w1', version: 7, confirm: true });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(rowOf('TV cleanup')).getByText('Active v7')).toBeTruthy());
  });
});
