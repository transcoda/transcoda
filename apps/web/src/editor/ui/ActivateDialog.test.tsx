import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { JOBS_LIST_MAX, type WorkflowSummary } from '@transcoda/contract';
import type { NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthValue } from '../../auth/AuthProvider.tsx';
import { ToastProvider } from '../../components/Toast.tsx';
import { resetCatalogCache } from '../../hooks/useCatalog.ts';
import { nodesFixture } from '../../test/fixtures/catalog.ts';
import { renderAt } from '../../test/render.tsx';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  versions: vi.fn(),
  get: vi.fn(),
  jobsList: vi.fn(),
  nodesList: vi.fn(),
  librariesList: vi.fn(),
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      workflows: { activate: mocks.activate, versions: mocks.versions, get: mocks.get },
      jobs: { list: mocks.jobsList },
      nodes: { list: mocks.nodesList },
      libraries: { list: mocks.librariesList },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { ActivateDialog } from './ActivateDialog.tsx';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const auth: AuthValue = {
  status: 'authenticated',
  user: { id: 'u1', username: 'jan', createdAt: minutesAgo(9999) },
  blockedHost: null,
  appearance: { theme: 'system', serverName: null },
  setAppearance: () => {},
  refresh: async () => {},
  logout: async () => {},
};

const workflow: WorkflowSummary = {
  id: 'wf1',
  name: 'TV cleanup',
  kind: 'workflow',
  active: { version: 3, runnable: true, activatedAt: minutesAgo(120), activatedBy: 'u1' },
  currentVersion: 6,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  usedBy: [],
  createdAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
};

const node = (id: string, label: string): NodeInstance => ({
  id,
  type: 'core:test',
  typeVersion: 1,
  settings: {},
  position: { x: 0, y: 0 },
  label,
});
const onShows: NodeInstance = {
  id: 'in',
  type: 'core:input-library',
  typeVersion: 1,
  settings: { libraryId: 'l1' },
  position: { x: 0, y: 0 },
};
const graph = (...nodes: NodeInstance[]): WorkflowGraph => ({
  formatVersion: 1,
  kind: 'workflow',
  nodes: [onShows, ...nodes],
  edges: [],
  groups: [],
});
const graphs: Record<number, WorkflowGraph> = {
  2: graph(node('a', 'Size gate')),
  3: graph(node('a', 'Size gate')),
  6: graph(node('a', 'Size gate'), node('b', 'Encode video')),
};

const library = (feeds: { workflowId: string; name: string; version: number } | null = null) => ({
  id: 'l1',
  name: 'Shows',
  path: '/media/Shows',
  recycleFolder: null,
  processHardlinked: false,
  verifyFullDecode: false,
  feeds,
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(600),
});

const TAKEN = 'Shows is fed by Archive v2. Deactivate it or point this Library input elsewhere.';
const SCAN_LINE =
  'From now on, Scan now on Shows runs v6. Each original moves to the recycle folder and is kept there for up to 7 days.';

const versionList = [6, 5, 4, 3, 2, 1].map((v) => ({
  version: v,
  note: v === 4 ? 'Layout only' : v === 5 ? null : `note ${v}`,
  createdBy: v === 5 ? 'u2' : 'u1',
  createdAt: minutesAgo(v * 10),
}));

const job = (workflowId: string, dryRun = false) => ({ workflowId, dryRun });

function renderDialog(props: Partial<Parameters<typeof ActivateDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onActivated = vi.fn();
  const view = renderAt(
    '/',
    <AuthContext.Provider value={auth}>
      <ActivateDialog
        open
        workflow={workflow}
        version={6}
        issues={null}
        onClose={onClose}
        onActivated={onActivated}
        {...props}
      />
    </AuthContext.Provider>,
  );
  return { ...view, onClose, onActivated };
}

const primary = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  resetCatalogCache();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.nodesList.mockResolvedValue({ nodes: nodesFixture });
  mocks.versions.mockResolvedValue({ versions: versionList });
  mocks.get.mockImplementation(({ version }: { version: number }) =>
    Promise.resolve({ graph: graphs[version] }),
  );
  mocks.jobsList.mockResolvedValue({ jobs: [] });
  mocks.librariesList.mockResolvedValue({
    libraries: [library({ workflowId: 'wf1', name: 'TV cleanup', version: 3 })],
    notices: [],
  });
  mocks.activate.mockResolvedValue({ ...workflow, active: { ...workflow.active, version: 6 } });
});
afterEach(cleanup);

describe('ActivateDialog', () => {
  it('shows the title, the lead naming v3 and who activated it, the versions in between, the node changes and the library line; primary "Activate v6" enables once the summary loaded; no checkbox exists', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Activate v6 of TV cleanup?' });
    expect(primary('Activate v6').disabled).toBe(true);
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    const text = dialog.textContent ?? '';
    expect(text).toContain(
      'From now on, real runs use v6. v3 is active now (activated 2 h ago by jan).',
    );
    expect(text).toContain('What changes');
    expect(text).toContain('v4 · Layout only · jan');
    expect(text).toContain('v5 · saved · another user');
    expect(text).not.toContain('v6 ·');
    expect(text).toContain('This version vs v3:');
    expect(within(dialog).getByText('Added Encode video')).toBeTruthy();
    await waitFor(() => expect(dialog.textContent).toContain(SCAN_LINE));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1', version: 3 });
    expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1', version: 6 });
    expect(primary('Keep v3 active')).toBeTruthy();
  });

  it('rollback (active v6, version 2): title "Roll back TV cleanup to v2?", skipped versions listed, buttons "Keep v6" / "Roll back to v2"', async () => {
    renderDialog({
      workflow: {
        ...workflow,
        active: { version: 6, runnable: true, activatedAt: minutesAgo(5), activatedBy: 'u1' },
      },
      version: 2,
    });
    const dialog = screen.getByRole('dialog', { name: 'Roll back TV cleanup to v2?' });
    await waitFor(() => expect(primary('Roll back to v2').disabled).toBe(false));
    expect(primary('Keep v6')).toBeTruthy();
    const items = [...dialog.querySelectorAll('.activate-summary-versions li')].map(
      (li) => li.textContent,
    );
    expect(items).toEqual([
      'v5 · saved · another user',
      'v4 · Layout only · jan',
      'v3 · note 3 · jan',
    ]);
    expect(dialog.textContent).toContain('v2 vs v6:');
    expect(within(dialog).getByText('Removed Encode video')).toBeTruthy();
  });

  it('nothing active: lead "No version is active now; TV cleanup only runs dry runs.", the version note only, buttons "Cancel" / "Activate v6"', async () => {
    renderDialog({ workflow: { ...workflow, active: null } });
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    expect(dialog.textContent).toContain(
      'No version is active now; TV cleanup only runs dry runs.',
    );
    expect(dialog.textContent).toContain('v6 · note 6 · jan');
    expect(dialog.textContent).not.toContain('This version vs');
    expect(dialog.querySelector('.activate-summary-versions')).toBeNull();
    expect(primary('Cancel')).toBeTruthy();
    // Only the version's own graph (for its library); no diff without an active version.
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1', version: 6 });
  });

  it('names 2 waiting jobs and running jobs; a full page says "At least 200 waiting jobs"; a failed jobs.list shows neither line and the primary still enables', async () => {
    mocks.jobsList.mockImplementation(({ state }: { state: unknown }) =>
      Promise.resolve({
        jobs:
          state === 'queued'
            ? [job('wf1'), job('wf1'), job('wf1', true), job('other')]
            : [job('wf1')],
      }),
    );
    const first = renderDialog();
    await screen.findByText('2 waiting jobs will run on v6 when they start.');
    expect(screen.getByText('Jobs already running finish on their version.')).toBeTruthy();
    expect(mocks.jobsList).toHaveBeenCalledWith({ state: 'queued', limit: JOBS_LIST_MAX });
    expect(
      mocks.jobsList.mock.calls.some(([i]) => Array.isArray(i.state) && i.state.length > 0),
    ).toBe(true);
    first.unmount();

    mocks.jobsList.mockImplementation(({ state }: { state: unknown }) =>
      Promise.resolve({
        jobs: state === 'queued' ? Array.from({ length: JOBS_LIST_MAX }, () => job('wf1')) : [],
      }),
    );
    const second = renderDialog();
    await screen.findByText('At least 200 waiting jobs will run on v6 when they start.');
    second.unmount();

    mocks.jobsList.mockRejectedValue(new Error('offline'));
    renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    await waitFor(() => expect(mocks.jobsList).toHaveBeenCalledTimes(2 + 2 + 2));
    expect(screen.queryByText(/waiting job/)).toBeNull();
    expect(screen.queryByText(/already running/)).toBeNull();
  });

  it('Activate calls workflows.activate({ id, version: 6, confirm: true }), toasts "TV cleanup: v6 is active" and reports the summary', async () => {
    const { onActivated } = renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    fireEvent.click(primary('Activate v6'));
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
    expect(mocks.activate).toHaveBeenCalledWith({ id: 'wf1', version: 6, confirm: true });
    expect(screen.getByText('TV cleanup: v6 is active')).toBeTruthy();
    expect(onActivated.mock.calls[0]?.[0]).toMatchObject({ id: 'wf1' });
  });

  it('WORKFLOW_INVALID shows "Can\'t activate: 1 error" with the message and disables Activate; another failure is inline with the dialog usable', async () => {
    const issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'Node "Encode" is missing' };
    mocks.activate.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(
      new ORPCError('WORKFLOW_INVALID', {
        defined: true,
        status: 422,
        data: { issues: [issue] },
      }),
    );
    renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    fireEvent.click(primary('Activate v6'));
    await screen.findByText('Could not activate, try again');
    expect(primary('Activate v6').disabled).toBe(false);
    fireEvent.click(primary('Activate v6'));
    await screen.findByText("Can't activate: 1 error");
    expect(screen.getByText('Node "Encode" is missing')).toBeTruthy();
    expect(primary('Activate v6').disabled).toBe(true);
  });

  it('WORKFLOW_INVALID with no issues is a generic failure and the primary stays usable', async () => {
    mocks.activate.mockRejectedValue(
      new ORPCError('WORKFLOW_INVALID', { defined: true, status: 422, data: { issues: [] } }),
    );
    renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    fireEvent.click(primary('Activate v6'));
    await screen.findByText('Could not activate, try again');
    expect(screen.queryByText(/Can't activate/)).toBeNull();
    expect(primary('Activate v6').disabled).toBe(false);
  });

  it('starts in the refused state when the caller already knows errors', async () => {
    renderDialog({ issues: [{ severity: 'error', code: 'TRIGGER_COUNT', message: 'No trigger' }] });
    expect(screen.getByText("Can't activate: 1 error")).toBeTruthy();
    expect(primary('Activate v6').disabled).toBe(true);
    await waitFor(() => expect(mocks.versions).toHaveBeenCalled());
  });

  it('focus starts on the secondary button; reopening resets the state', async () => {
    const issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'Node "Encode" is missing' };
    mocks.activate.mockRejectedValue(
      new ORPCError('WORKFLOW_INVALID', { defined: true, status: 422, data: { issues: [issue] } }),
    );
    const { rerender } = renderDialog();
    expect(document.activeElement).toBe(primary('Keep v3 active'));
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    fireEvent.click(primary('Activate v6'));
    await screen.findByText("Can't activate: 1 error");

    const again = (open: boolean) =>
      rerender(
        <ToastProvider>
          <AuthContext.Provider value={auth}>
            <ActivateDialog
              open={open}
              workflow={workflow}
              version={6}
              issues={null}
              onClose={() => {}}
              onActivated={() => {}}
            />
          </AuthContext.Provider>
        </ToastProvider>,
      );
    again(false);
    again(true);
    expect(screen.queryByText("Can't activate: 1 error")).toBeNull();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
  });

  it('Shows fed by another workflow (Archive v2): the taken text shows and Activate stays disabled; fed by this workflow itself it is not taken', async () => {
    mocks.librariesList.mockResolvedValue({
      libraries: [library({ workflowId: 'wf9', name: 'Archive', version: 2 })],
      notices: [],
    });
    const first = renderDialog();
    await screen.findByText(TAKEN);
    await waitFor(() => expect(mocks.versions).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(SCAN_LINE)).toBeNull());
    expect(primary('Activate v6').disabled).toBe(true);
    first.unmount();

    mocks.librariesList.mockResolvedValue({ libraries: [library(null)], notices: [] });
    renderDialog();
    await screen.findByText(SCAN_LINE);
    expect(screen.queryByText(TAKEN)).toBeNull();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
  });

  it('a server LIBRARY_TAKEN shows the same text from its data and disables Activate', async () => {
    mocks.activate.mockRejectedValue(
      new ORPCError('LIBRARY_TAKEN', {
        defined: true,
        status: 409,
        data: {
          library: { id: 'l1', name: 'Shows' },
          workflow: { id: 'wf9', name: 'Archive', version: 2 },
        },
      }),
    );
    renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    fireEvent.click(primary('Activate v6'));
    await screen.findByText(TAKEN);
    // announced: the refusal arrives after the click
    expect(screen.getByRole('alert').textContent).toBe(TAKEN);
    expect(primary('Activate v6').disabled).toBe(true);
    expect(screen.queryByText('Could not activate, try again')).toBeNull();
  });

  it('a server LIBRARY_MISSING says the library no longer exists', async () => {
    mocks.activate.mockRejectedValue(
      new ORPCError('LIBRARY_MISSING', { defined: true, status: 400, data: { libraryId: 'l1' } }),
    );
    renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    fireEvent.click(primary('Activate v6'));
    await screen.findByText(
      'The Library input names a library that no longer exists. Pick a library first.',
    );
    expect(primary('Activate v6').disabled).toBe(true);
  });

  it('a version without a Library input says it runs only from Run on a file', async () => {
    mocks.get.mockResolvedValue({ graph: { ...graphs[6], nodes: [node('a', 'Size gate')] } });
    renderDialog();
    await screen.findByText(
      'No library sends files to v6; it runs only when you use Run on a file.',
    );
    expect(screen.queryByText(/Scan now/)).toBeNull();
  });

  it('when libraries.list fails the library sentence is left out and Activate stays possible', async () => {
    mocks.librariesList.mockRejectedValue(new Error('offline'));
    renderDialog();
    await waitFor(() => expect(primary('Activate v6').disabled).toBe(false));
    await waitFor(() => expect(mocks.librariesList).toHaveBeenCalled());
    expect(screen.queryByText(/Scan now/)).toBeNull();
    expect(screen.queryByText(/No library sends/)).toBeNull();
  });
});
