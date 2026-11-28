import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainMainReplace } from '../../testing/fixtures/graphs.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  versions: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  jobsList: vi.fn(),
  nodesList: vi.fn(),
  queue: vi.fn(),
  librariesList: vi.fn(),
  browse: vi.fn(),
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      workflows: {
        get: mocks.get,
        list: mocks.list,
        validate: mocks.validate,
        save: mocks.save,
        rename: mocks.rename,
        versions: mocks.versions,
        activate: mocks.activate,
        deactivate: mocks.deactivate,
      },
      nodes: { list: mocks.nodesList },
      jobs: { queue: mocks.queue, list: mocks.jobsList },
      libraries: { list: mocks.librariesList, browse: mocks.browse },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import {
  detail,
  loadedEditor,
  menuItem,
  minutesAgo,
  paletteButton,
  pill,
  saveOk,
  setupEditorPageMocks,
  summary,
} from './testing.tsx';

setupEditorPageMocks(mocks);
afterEach(cleanup);

describe('EditorPage activation (Task 17, activation Task 9)', () => {
  const activeV3 = (runnable = true): NonNullable<WorkflowSummary['active']> => ({
    version: 3,
    runnable,
    activatedAt: minutesAgo(30),
    activatedBy: 'u1',
  });

  it('sits in the header; an unsaved edit leaves the saved, valid version activatable; saved errors say "Fix N errors before activating"', async () => {
    await loadedEditor();
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
    const activate = () => menuItem('Activate v3') as HTMLElement;
    expect(activate().getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(paletteButton('Action', 'Keep languages'));
    // The server activates the saved v3, which is valid: the draft's state does not block it.
    expect(activate().getAttribute('aria-disabled')).toBeNull();
    expect(activate().hasAttribute('title')).toBe(false);

    const issues: Issue[] = [
      { severity: 'error', code: 'TRIGGER_COUNT', message: 'First' },
      { severity: 'error', code: 'INPUT_UNCONNECTED', message: 'Second' },
      { severity: 'warning', code: 'NODE_UNREACHABLE', message: 'Third' },
    ];
    mocks.save.mockResolvedValue({ ...saveOk(4), valid: false, issues });
    // The server validates the same graph to the same issues. The palette edit above armed the
    // 400 ms validation debounce, and on a loaded machine it fires after the save has answered: a
    // validate mock that said "valid" would then wipe the saved errors mid-test.
    mocks.validate.mockResolvedValue({ issues, valid: false });
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    await screen.findByText('Saved v4');
    await waitFor(() =>
      expect(menuItem('Activate v4')?.getAttribute('title')).toBe('Fix 2 errors before activating'),
    );
    expect(menuItem('Activate v4')?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(menuItem('Activate v4') as HTMLElement);
    expect(screen.queryByRole('dialog', { name: /^Activate v4/ })).toBeNull();
  });

  it('the header shows "Active v3" and "Activate v4" after a save; the toast reads "Saved v4 · v3 stays active" and the changes banner lists the save\'s changes once', async () => {
    mocks.get.mockResolvedValue({ ...detail(), active: activeV3() });
    await loadedEditor();
    expect(pill().textContent).toBe('Active v3 · saved 2 min ago');
    expect(pill().className).toContain('is-active');
    expect(menuItem('Deactivate')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    mocks.save.mockResolvedValue({
      ...saveOk(4),
      active: activeV3(),
      changes: ['Added Keep languages', 'Moved 2 nodes'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    expect(await screen.findByText('Saved v4 · v3 stays active')).toBeTruthy();
    expect(screen.getByText('This version: Added Keep languages; Moved 2 nodes')).toBeTruthy();
    expect(pill().textContent).toMatch(/^v4 · Active v3 · /);
    expect(pill().className).not.toContain('is-active');
    expect(menuItem('Activate v4')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // The next edit drops the changes banner.
    fireEvent.click(paletteButton('Action', 'Remux'));
    expect(screen.queryByText(/^This version:/)).toBeNull();
  });

  it('"Activate v4" opens the dialog; on success the pill reads "Active v4" and the button is gone', async () => {
    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 4), currentVersion: 4 });
    mocks.activate.mockResolvedValue({
      ...summary,
      currentVersion: 4,
      active: { ...activeV3(), version: 4 },
    });
    await loadedEditor();
    fireEvent.click(menuItem('Activate v4') as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Activate v4 of Smoke?' });
    const confirm = within(dialog).getByRole('button', {
      name: 'Activate v4',
    }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(pill().textContent).toMatch(/^Active v4 · /));
    expect(mocks.activate).toHaveBeenCalledWith({ id: 'wf1', version: 4, confirm: true });
    expect(menuItem('Activate v4')).toBeNull();
    expect(menuItem('Deactivate')).toBeTruthy();
  });

  it('a past version shows "Roll back to v2" beside "Restore as new version"; the active version shows "Viewing v3 — active" without it', async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 2),
      currentVersion: 3,
      active: activeV3(),
    });
    await loadedEditor('/workflows/wf1?version=2');
    expect(screen.getByText('Viewing v2 — current is v3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore as new version' })).toBeTruthy();
    // Read-only: the header menu has no Activate, the past-version banner has the one, with the
    // dialog's verb (v2 is below the active v3).
    expect(screen.getAllByRole('button', { name: 'Roll back to v2' })).toHaveLength(1);
    expect(menuItem('Roll back to v2')).toBeNull();
    cleanup();

    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 3),
      currentVersion: 4,
      active: activeV3(),
    });
    await loadedEditor('/workflows/wf1?version=3');
    expect(screen.getByText('Viewing v3 — active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Activate v/ })).toBeNull();
    expect(menuItem(/^Activate v/)).toBeNull();
  });

  it('a workflow whose active version can\'t run shows the danger banner with "Activate v6" (error-free current) and none when the current version has errors', async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 6),
      currentVersion: 6,
      active: activeV3(false),
      activeIssues: [
        { severity: 'error', code: 'UNKNOWN_NODE_VERSION', message: 'Needs a plugin.' },
      ],
    });
    await loadedEditor();
    const banner = screen
      .getByText(/^Active v3 can't run: Needs a plugin\./)
      .closest('[role="status"]');
    expect(banner?.className).toContain('is-danger');
    expect(within(banner as HTMLElement).getByRole('button', { name: 'Activate v6' })).toBeTruthy();
    cleanup();

    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 6),
      currentVersion: 6,
      active: activeV3(false),
      issues: [{ severity: 'error', code: 'TRIGGER_COUNT', message: 'First' }],
      activeIssues: [
        { severity: 'error', code: 'UNKNOWN_NODE_VERSION', message: 'Needs a plugin.' },
      ],
    });
    await loadedEditor();
    const danger = screen.getByText(/^Active v3 can't run/).closest('[role="status"]');
    expect(within(danger as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('an active version whose plugin is not running carries the plugin reason through the danger banner', async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 6),
      currentVersion: 6,
      active: activeV3(false),
      activeIssues: [
        {
          severity: 'error',
          code: 'PLUGIN_UNAVAILABLE',
          message: "Example can't run: plugin example not running (stopped: exited with code 3)",
        },
      ],
    });
    await loadedEditor();
    const banner = screen
      .getByText(
        /^Active v3 can't run: Example can't run: plugin example not running \(stopped: exited with code 3\)/,
      )
      .closest('[role="status"]');
    expect(banner?.className).toContain('is-danger');
  });

  it('Deactivate stays reachable when the current version is newer than the active one, and on a past-version view', async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 4),
      currentVersion: 4,
      active: activeV3(),
    });
    mocks.deactivate.mockResolvedValue({ ...summary, currentVersion: 4, active: null });
    await loadedEditor();
    expect(menuItem('Activate v4')).toBeTruthy();
    fireEvent.click(menuItem('Deactivate') as HTMLElement);
    await waitFor(() => expect(pill().textContent).toMatch(/^v4 · Not active · /));
    expect(mocks.deactivate).toHaveBeenCalledWith({ id: 'wf1' });
    cleanup();

    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 2),
      currentVersion: 4,
      active: activeV3(),
    });
    await loadedEditor('/workflows/wf1?version=2');
    expect(menuItem('Deactivate')).toBeTruthy();
  });

  it("no Activate in the can't-run banner on a past version (the past-version banner has it)", async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 2),
      currentVersion: 6,
      active: activeV3(false),
      activeIssues: [
        { severity: 'error', code: 'UNKNOWN_NODE_VERSION', message: 'Needs a plugin.' },
      ],
    });
    await loadedEditor('/workflows/wf1?version=2');
    const danger = screen
      .getByText(/^Active v3 can't run/)
      .closest('[role="status"]') as HTMLElement;
    expect(within(danger).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Roll back to v2' })).toHaveLength(1);
  });

  it("focus returns to the header pill after a rollback and after activating from the can't-run banner", async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 2),
      currentVersion: 3,
      active: activeV3(),
    });
    mocks.activate.mockResolvedValue({
      ...summary,
      currentVersion: 3,
      active: { ...activeV3(), version: 2 },
    });
    await loadedEditor('/workflows/wf1?version=2');
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to v2' }));
    let dialog = await screen.findByRole('dialog', { name: 'Roll back Smoke to v2?' });
    const go = within(dialog).getByRole('button', { name: 'Roll back to v2' }) as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(document.activeElement).toBe(pill()));
    expect(pill().textContent).toMatch(/^Active v2 · /);
    cleanup();

    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 6),
      currentVersion: 6,
      active: activeV3(false),
      activeIssues: [
        { severity: 'error', code: 'UNKNOWN_NODE_VERSION', message: 'Needs a plugin.' },
      ],
    });
    mocks.activate.mockResolvedValue({
      ...summary,
      currentVersion: 6,
      active: { ...activeV3(), version: 6 },
    });
    await loadedEditor();
    const banner = screen
      .getByText(/^Active v3 can't run/)
      .closest('[role="status"]') as HTMLElement;
    fireEvent.click(within(banner).getByRole('button', { name: 'Activate v6' }));
    dialog = await screen.findByRole('dialog', { name: 'Activate v6 of Smoke?' });
    const go2 = within(dialog).getByRole('button', { name: 'Activate v6' }) as HTMLButtonElement;
    await waitFor(() => expect(go2.disabled).toBe(false));
    fireEvent.click(go2);
    await waitFor(() => expect(document.activeElement).toBe(pill()));
    expect(pill().textContent).toMatch(/^Active v6 · /);
  });

  it("the danger banner's Activate opens the dialog for the shown version", async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 6),
      currentVersion: 6,
      active: activeV3(false),
      activeIssues: [
        { severity: 'error', code: 'UNKNOWN_NODE_VERSION', message: 'Needs a plugin.' },
      ],
    });
    await loadedEditor();
    const banner = screen
      .getByText(/^Active v3 can't run/)
      .closest('[role="status"]') as HTMLElement;
    fireEvent.click(within(banner).getByRole('button', { name: 'Activate v6' }));
    expect(await screen.findByRole('dialog', { name: 'Activate v6 of Smoke?' })).toBeTruthy();
  });
});
