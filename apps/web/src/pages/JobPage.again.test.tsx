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
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { Route, Switch } from 'wouter';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { EventsProvider } from '../hooks/useEvents.ts';
import { fakeEventSource } from '../test/fakeEventStream.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import {
  COMMAND,
  entry,
  jobDetail,
  PATH,
  runningJobDetail,
  SUB_ID,
  TRACE,
  traceSub,
} from '../test/fixtures/trace.ts';
import { renderAt } from '../test/render.tsx';
import { JobPage } from './JobPage.tsx';

const FILE = '/media/Shows/Tigger and Pooh/Tigger and Pooh S01E01.mkv';
const LIBRARY = {
  id: 'l1',
  name: 'Shows',
  path: '/media/Shows',
  recycleFolder: null,
  processHardlinked: false,
  verifyFullDecode: false,
  defaultWorkflowId: 'w1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

let fake: ReturnType<typeof fakeEventSource>;

const SUB = { id: SUB_ID, name: 'Language cleanup', kind: 'subworkflow', version: 3 };
const MAIN = {
  id: 'w1',
  name: 'TV cleanup',
  kind: 'workflow',
  version: 9,
  active: { version: 7, runnable: true },
};
async function workflowById({ id }: { id: string }) {
  return id === SUB_ID ? { ...SUB, graph: traceSub() } : MAIN;
}

beforeEach(() => {
  resetCatalogCache();
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.workflows.get.mockReset().mockImplementation(workflowById);
  mocks.workflows.list
    .mockReset()
    .mockResolvedValue({ workflows: [{ id: 'w1', active: MAIN.active }] });
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.jobs.get.mockReset().mockResolvedValue(jobDetail({ state: 'already_processed' }));
  mocks.jobs.log.mockReset().mockResolvedValue({ log: '' });
  mocks.jobs.queue.mockReset();
  mocks.libraries.get.mockReset().mockResolvedValue(LIBRARY);
  mocks.queue.status
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null }, preparing: [] });
});
afterEach(() => cleanup());

async function open(path = '/jobs/j1') {
  const view = renderAt(
    path,
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

describe('JobPage: Process again', () => {
  it('a running job offers neither Process again nor Dry run again', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail());
    await open();
    expect(screen.queryByRole('button', { name: 'Process again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dry run again' })).toBeNull();
  });

  it('asks first, naming the recycle folder, then queues the file with force for the active version and opens the new job', async () => {
    mocks.jobs.queue.mockResolvedValue({
      runId: 'r2',
      jobIds: ['j2'],
      dryRun: false,
      note: null,
      workflowVersion: 7,
    });
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Process Tigger and Pooh S01E01.mkv again?',
    });
    await waitFor(() => expect(dialog.textContent).toContain('/media/Shows/.transcoda-recycle'));
    expect(dialog.textContent).toContain('TV cleanup');
    expect(mocks.libraries.get).toHaveBeenCalledWith({ id: 'l1' });
    expect(mocks.jobs.queue).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Process again' }));
    await waitFor(() => expect(mocks.jobs.queue).toHaveBeenCalledTimes(1));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: FILE,
      workflowId: 'w1',
      force: true,
    });
    await waitFor(() => expect(view.location()).toBe('/jobs/j2'));
  });

  it('names a custom recycle folder', async () => {
    mocks.libraries.get.mockResolvedValue({ ...LIBRARY, recycleFolder: '/media/recycle' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('/media/recycle'));
  });

  it('opens the dialog only once the workflow and the library have loaded, and says it is working meanwhile', async () => {
    let release: (v: unknown) => void = () => {};
    mocks.libraries.get.mockReturnValue(new Promise((r) => (release = r)));
    await open();
    const button = screen.getByRole('button', { name: 'Process again' });
    fireEvent.click(button);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(/Checking TV cleanup/).textContent).toContain('Checking');
    await act(async () => release(LIBRARY));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('/media/Shows/.transcoda-recycle');
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('with no active version, Process again is not offered as a second dry run: it is disabled with the reason', async () => {
    mocks.workflows.get.mockImplementation(async () => ({ ...MAIN, active: null }));
    mocks.workflows.list.mockResolvedValue({ workflows: [{ id: 'w1', active: null }] });
    await open();
    const button = await screen.findByRole('button', { name: 'Process again' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));
    const hint = screen.getByText('Activate a version to run for real');
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Dry run again is the one action left.
    expect(screen.getByRole('button', { name: 'Dry run again' })).toBeTruthy();
  });

  it("when the active version can't run the dialog says so and the primary button is disabled", async () => {
    mocks.workflows.get.mockImplementation(async () => ({
      ...MAIN,
      active: { version: 7, runnable: false },
    }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("TV cleanup v7 is active but can't run");
    expect(
      (within(dialog).getByRole('button', { name: 'Process again' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.jobs.queue).not.toHaveBeenCalled();
  });

  it('Cancel in the dialog queues nothing', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.jobs.queue).not.toHaveBeenCalled();
  });

  it('Dry run again queues a forced dry run of the active version without asking', async () => {
    mocks.jobs.queue.mockResolvedValue({
      runId: 'r3',
      jobIds: ['j3'],
      dryRun: true,
      note: null,
      workflowVersion: 7,
    });
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run again' }));
    await waitFor(() => expect(mocks.jobs.queue).toHaveBeenCalledTimes(1));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: FILE,
      workflowId: 'w1',
      dryRun: true,
      force: true,
      workflowVersion: 7,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(view.location()).toBe('/jobs/j3'));
  });

  describe('a plan-only dry run its size gate decides (#41)', () => {
    const dependsJob = () =>
      jobDetail({
        state: 'dry_run',
        dryRun: true,
        dependsOnSize: { minSavingPercent: 25 },
        // The gate's step leaves by no port in a plan-only dry run: the result decides.
        path: PATH.map((p) => (p.nodeId === 'sg' ? { ...p, port: null } : p)),
        trace: [
          ...TRACE.slice(0, 9),
          entry(10, 'sg', 'finish', 'file', 'size gate: at least 25% smaller'),
          entry(
            11,
            'sg',
            'finish',
            null,
            'Size gate: decides after encoding: keep if it saves less than 25%',
            { findings: { minSavingPercent: 25 } },
          ),
          entry(
            11,
            'ro-a',
            'finish',
            'file',
            'replace the original (recycle folder: library default)',
          ),
        ],
        result: {
          outcome: 'dry_run',
          beforeBytes: 315_000_000,
          afterBytes: null,
          estimatedBytes: 190_000_000,
          command: COMMAND,
          replacedTo: null,
          warnings: [],
          problems: [],
        },
      });

    it('says the replace is conditional, the size is decided after encoding, and the gate decides after encoding', async () => {
      mocks.jobs.get.mockResolvedValue(dependsJob());
      await open();
      expect(screen.getAllByText('Would replace if it saves ≥ 25%').length).toBeGreaterThan(0);
      expect(screen.getByText('315 MB → ? · decided after encoding')).toBeTruthy();
      const steps = screen.getByRole('region', { name: 'What the workflow would do' });
      expect(
        within(steps).getByText(
          "If the size gate passes, replaces the original and moves it to this library's recycle folder; otherwise keeps it",
        ),
      ).toBeTruthy();
      // One row for the gate (its decision stands in for its build entry), checked after encode.
      const gate = within(steps).getByText('Keeps the result only if it is at least 25% smaller');
      expect(
        within(gate.closest('li') as HTMLElement).getByText('Checked after encode'),
      ).toBeTruthy();
      expect(within(steps).getAllByText('Size gate')).toHaveLength(1);
    });

    it('Test-encode this file queues a test-encode dry run of the same version and opens it', async () => {
      mocks.jobs.get.mockResolvedValue(dependsJob());
      mocks.jobs.queue.mockResolvedValue({
        runId: 'r4',
        jobIds: ['j4'],
        dryRun: true,
        note: null,
        workflowVersion: 7,
        testEncode: true,
      });
      const view = await open();
      fireEvent.click(screen.getByRole('button', { name: 'Test-encode this file' }));
      await waitFor(() => expect(mocks.jobs.queue).toHaveBeenCalledTimes(1));
      expect(mocks.jobs.queue).toHaveBeenCalledWith({
        path: FILE,
        workflowId: 'w1',
        workflowVersion: 7,
        dryRun: true,
        testEncode: true,
        force: true,
      });
      await waitFor(() => expect(view.location()).toBe('/jobs/j4'));
    });

    it('Test-encode this file says it is queuing while the request runs', async () => {
      mocks.jobs.get.mockResolvedValue(dependsJob());
      let answer: (v: unknown) => void = () => {};
      mocks.jobs.queue.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Test-encode this file' }));
      const busy = await screen.findByRole('button', { name: 'Queuing…' });
      expect(busy.getAttribute('aria-busy')).toBe('true');
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      await act(async () =>
        answer({ runId: 'r4', jobIds: [], dryRun: true, note: null, workflowVersion: 7 }),
      );
      const idle = await screen.findByRole('button', { name: 'Test-encode this file' });
      expect(idle.getAttribute('aria-busy')).toBeNull();
    });

    it('a dry run that does not depend on size has no such action', async () => {
      mocks.jobs.get.mockResolvedValue({ ...dependsJob(), dependsOnSize: null });
      await open();
      expect(screen.queryByRole('button', { name: 'Test-encode this file' })).toBeNull();
    });
  });

  it('a failed queue says why and stays on the job', async () => {
    mocks.jobs.queue.mockRejectedValue(new Error('boom'));
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run again' }));
    await screen.findByText(/Couldn't queue Tigger and Pooh S01E01.mkv again/);
    expect(view.location()).toBe('/jobs/j1');
  });
});
