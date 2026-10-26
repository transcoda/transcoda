import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast.tsx';
import { resetCatalogCache } from '../../hooks/useCatalog.ts';
import { nodesFixture } from '../../test/fixtures/catalog.ts';
import { renderAt } from '../../test/render.tsx';

const mocks = vi.hoisted(() => ({
  deactivate: vi.fn(),
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
      workflows: {
        deactivate: mocks.deactivate,
        activate: mocks.activate,
        versions: mocks.versions,
        get: mocks.get,
      },
      jobs: { list: mocks.jobsList },
      nodes: { list: mocks.nodesList },
      libraries: { list: mocks.librariesList },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import {
  ActivationControl,
  activateBlocked,
  activationPill,
  fixErrorsReason,
  hasActivation,
} from './ActivationControl.tsx';

const active3 = {
  version: 3,
  runnable: true,
  activatedAt: '2026-10-16T09:00:00.000Z',
  activatedBy: 'u1',
};

const base: WorkflowSummary = {
  id: 'wf1',
  name: 'TV cleanup',
  kind: 'workflow',
  active: null,
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

/** The status pill (the toast region is a status too). */
const pill = () =>
  screen.getAllByRole('status').find((e) => e.classList.contains('activation-pill')) as HTMLElement;

function renderControl(props: Partial<Parameters<typeof ActivationControl>[0]> = {}) {
  const onChanged = vi.fn();
  const view = renderAt(
    '/',
    <ActivationControl
      workflow={{ ...base, active: active3 }}
      shown={{ version: 6, blocked: null }}
      readOnly={false}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { ...view, onChanged };
}

beforeEach(() => {
  resetCatalogCache();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.nodesList.mockResolvedValue({ nodes: nodesFixture });
  mocks.versions.mockResolvedValue({ versions: [] });
  mocks.get.mockRejectedValue(new Error('not needed here'));
  mocks.jobsList.mockResolvedValue({ jobs: [] });
  mocks.librariesList.mockResolvedValue({ libraries: [], notices: [] });
});
afterEach(cleanup);

describe('ActivationControl', () => {
  it('activateBlocked: a LIBRARY_MISSING warning blocks activation with "Pick a library that exists first", after "Save first" and the errors reason', () => {
    const missing: Issue = {
      severity: 'warning',
      code: 'LIBRARY_MISSING',
      message: 'Library input: no library with this id',
      nodeId: 'in',
    };
    const error: Issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'No trigger' };
    expect(activateBlocked(false, [missing])).toEqual({
      reason: 'Pick a library that exists first',
    });
    expect(activateBlocked(true, [missing])).toEqual({ reason: 'Save first' });
    expect(activateBlocked(false, [missing, error])).toEqual({ reason: fixErrorsReason(1) });
  });

  it('activateBlocked: unsaved changes do not block activating the saved version when it is valid; its own errors do', () => {
    const error: Issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'No trigger' };
    // The draft's errors are the draft's: the saved version is what gets activated.
    expect(activateBlocked(true, [error], { valid: true, errorCount: 0 })).toBeNull();
    expect(activateBlocked(true, [], { valid: false, errorCount: 2 })).toEqual({
      reason: fixErrorsReason(2),
    });
  });

  it('a version older than the active one reads "Roll back to vN", the verb its dialog uses', () => {
    renderControl({
      workflow: { ...base, active: { ...active3, version: 5 } },
      shown: { version: 3, blocked: null },
    });
    expect(screen.getByRole('button', { name: 'Roll back to v3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activate v3' })).toBeNull();
  });

  it('the pill has one look everywhere: neutral Not active, lime Active, never the dry-run eye', () => {
    expect(activationPill(null)).toEqual({ cls: 'is-off', icon: 'pause', text: 'Not active' });
    expect(activationPill({ ...active3 }).cls).toBe('is-active');
    expect(activationPill({ ...active3, runnable: false }).icon).toBe('alert');
    for (const a of [null, active3, { ...active3, runnable: false }]) {
      expect(activationPill(a).icon).not.toBe('eye');
    }
  });

  it('pill: "Not active" / "Active v3" with a check icon / "Active v3 · can\'t run" with the first active issue as title; a sub-workflow renders nothing', () => {
    const { rerender, container } = renderControl({ workflow: base });
    expect(pill().textContent).toBe('Not active');
    expect(pill().className).toContain('is-off');

    const rerenderWith = (workflow: WorkflowSummary, activeIssue?: string) =>
      rerender(
        <ToastProvider>
          <ActivationControl
            workflow={workflow}
            shown={{ version: 6, blocked: null }}
            {...(activeIssue !== undefined ? { activeIssue } : {})}
            readOnly={false}
            onChanged={() => {}}
          />
        </ToastProvider>,
      );
    rerenderWith({ ...base, active: active3 });
    const el = pill();
    expect(el.textContent).toBe('Active v3');
    expect(el.className).toContain('is-active');
    expect(el.querySelector('svg')).not.toBeNull();

    rerenderWith({ ...base, active: { ...active3, runnable: false } }, 'Node "Encode" is missing');
    expect(pill().textContent).toBe("Active v3 · can't run");
    expect(pill().className).toContain('is-danger');
    expect(pill().getAttribute('title')).toBe('Node "Encode" is missing');
    expect(
      screen.getByRole('status', { name: 'Active v3 · can\'t run: Node "Encode" is missing' }),
    ).toBeTruthy();

    rerenderWith({ ...base, kind: 'subworkflow' });
    expect(container.textContent).toBe('');
    expect(hasActivation({ kind: 'subworkflow' })).toBe(false);
  });

  it('"Activate v6" shows on a non-active shown version; aria-disabled with "Save first" when dirty and "Fix 2 errors before activating" with errors; hidden on the active version, where "Deactivate" shows', () => {
    const { rerender } = renderControl();
    expect(
      screen.getByRole('button', { name: 'Activate v6' }).getAttribute('aria-disabled'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();

    const rerenderWith = (shown: Parameters<typeof ActivationControl>[0]['shown']) =>
      rerender(
        <ToastProvider>
          <ActivationControl
            workflow={{ ...base, active: active3 }}
            shown={shown}
            readOnly={false}
            onChanged={() => {}}
          />
        </ToastProvider>,
      );
    rerenderWith({ version: 6, blocked: activateBlocked(true, []) });
    let button = screen.getByRole('button', { name: 'Activate v6' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('Save first');
    const describedBy = (b: HTMLElement) =>
      document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(describedBy(button)).toBe('Save first');
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();

    const error: Issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'm' };
    rerenderWith({ version: 6, blocked: activateBlocked(false, [error, error]) });
    button = screen.getByRole('button', { name: 'Activate v6' });
    expect(button.getAttribute('title')).toBe('Fix 2 errors before activating');
    expect(describedBy(button)).toBe('Fix 2 errors before activating');
    expect(fixErrorsReason(1)).toBe('Fix 1 error before activating');

    rerenderWith({ version: 6, blocked: null });
    expect(
      screen.getByRole('button', { name: 'Activate v6' }).hasAttribute('aria-describedby'),
    ).toBe(false);

    rerenderWith({ version: 3, blocked: null });
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
  });

  it('Deactivate calls workflows.deactivate, toasts "<name> is not active" and reports the summary; a failure is an error toast with Try again', async () => {
    const off = { ...base, active: null };
    mocks.deactivate.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(off);
    const { onChanged } = renderControl({ shown: { version: 3, blocked: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByText('Could not deactivate, try again');
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('TV cleanup is not active');
    expect(mocks.deactivate).toHaveBeenLastCalledWith({ id: 'wf1' });
    expect(onChanged).toHaveBeenCalledWith(off);
  });

  it('clicking Activate opens the dialog titled "Activate v6 of TV cleanup?"', async () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Activate v6' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Activate v6 of TV cleanup?' })).toBeTruthy(),
    );
  });

  it('after a successful activation focus returns to the pill', async () => {
    mocks.activate.mockResolvedValue({ ...base, active: { ...active3, version: 6 } });
    mocks.versions.mockResolvedValue({ versions: [] });
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Activate v6' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate v6 of TV cleanup?' });
    const go = within(dialog).getByRole('button', { name: 'Activate v6' }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(document.activeElement).toBe(pill()));
  });

  it('read-only: no Activate, but Deactivate stays reachable while a version is active', () => {
    renderControl({ readOnly: true, shown: { version: 2, blocked: null } });
    expect(pill().textContent).toBe('Active v3');
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
  });

  it('read-only and not active: pill only', () => {
    renderControl({ readOnly: true, workflow: { ...base, active: null } });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('active v3 shown as v6: both "Deactivate" and "Activate v6" are offered; Deactivate calls the API', async () => {
    mocks.deactivate.mockResolvedValue({ ...base, active: null });
    const { onChanged } = renderControl({ shown: { version: 6, blocked: null } });
    expect(screen.getByRole('button', { name: 'Activate v6' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mocks.deactivate).toHaveBeenCalledWith({ id: 'wf1' });
  });
});
