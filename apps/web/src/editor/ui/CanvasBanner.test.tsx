import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { renderAt } from '../../test/render.tsx';
import { CanvasBanner, PastVersionBanner } from './CanvasBanner.tsx';

afterEach(cleanup);

const workflow: WorkflowSummary = {
  id: 'wf1',
  name: 'Smoke',
  kind: 'workflow',
  active: null,
  currentVersion: 3,
  valid: false,
  errorCount: 2,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  usedBy: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const issues: Issue[] = [
  { severity: 'warning', code: 'NODE_UNREACHABLE', message: 'Never reached', nodeId: 'a' },
  {
    severity: 'error',
    code: 'UNKNOWN_NODE_VERSION',
    message: '“Refresh in Jellyfin” needs the Jellyfin plugin.',
    nodeId: 'b',
  },
  { severity: 'error', code: 'NO_FINISH_PATH', message: 'No path reaches a finish node' },
];

const stale = (over: Partial<NonNullable<WorkflowSummary['active']>> = {}) => ({
  version: 3,
  runnable: false,
  activatedAt: '2026-10-01T00:00:00.000Z',
  activatedBy: 'u1',
  ...over,
});
const activeIssue: Issue = {
  severity: 'error',
  code: 'UNKNOWN_NODE_VERSION',
  message: 'Needs the Jellyfin plugin.',
};
const none = { activeIssues: [] as Issue[], activatable: null };

describe('CanvasBanner', () => {
  it('says "Can\'t activate: …. Dry runs still work." for the first error', () => {
    const { rerender, container } = render(
      <CanvasBanner issues={issues} workflow={workflow} {...none} />,
    );
    const banners = screen.getAllByRole('status');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toBe(
      "Can't activate: “Refresh in Jellyfin” needs the Jellyfin plugin. Dry runs still work.",
    );
    rerender(<CanvasBanner issues={issues.slice(0, 1)} workflow={workflow} {...none} />);
    expect(container.textContent).toBe('');
  });

  it('the sub-workflow wording ends "can\'t be activated"', () => {
    render(
      <CanvasBanner issues={issues} workflow={{ ...workflow, kind: 'subworkflow' }} {...none} />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      "Needs a fix: “Refresh in Jellyfin” needs the Jellyfin plugin. Workflows that run this version can't be activated.",
    );
  });

  it('leads a node error with the node name unless the message names it; the error text is not live', () => {
    const graph = chainMainReplace();
    const error = (nodeId: string, message: string): Issue[] => [
      { severity: 'error', code: 'INPUT_UNCONNECTED', message, nodeId },
    ];
    const { rerender } = render(
      <CanvasBanner
        issues={error('ro', 'Input file is not connected')}
        workflow={workflow}
        graph={graph}
        catalog={catalogFixture}
        {...none}
      />,
    );
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe(
      "Can't activate: Replace original: Input file is not connected. Dry runs still work.",
    );
    expect(banner.getAttribute('aria-live')).toBe('off');

    rerender(
      <CanvasBanner
        issues={error('ro', 'Replace original: input File is not connected')}
        workflow={workflow}
        graph={graph}
        catalog={catalogFixture}
        {...none}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      "Can't activate: Replace original: input File is not connected. Dry runs still work.",
    );

    rerender(
      <CanvasBanner
        issues={error('gone', 'Input file is not connected')}
        workflow={workflow}
        graph={graph}
        catalog={catalogFixture}
        {...none}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      "Can't activate: Removed node: Input file is not connected. Dry runs still work.",
    );
  });

  it('shows "Active v3 can\'t run: <issue>. Real runs are refused until you activate a version that runs." with "Activate v6" when activatable, without it otherwise; no banner when active is runnable or null', () => {
    const onActivate = vi.fn();
    const sick = { ...workflow, active: stale() };
    const { rerender, container } = render(
      <CanvasBanner
        issues={[]}
        workflow={sick}
        activeIssues={[activeIssue]}
        activatable={{ version: 6, onActivate }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      "Active v3 can't run: Needs the Jellyfin plugin. Real runs are refused until you activate a version that runs.Activate v6",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activate v6' }));
    expect(onActivate).toHaveBeenCalledOnce();

    rerender(<CanvasBanner issues={[]} workflow={sick} activeIssues={[]} activatable={null} />);
    expect(screen.getByRole('status').textContent).toBe(
      "Active v3 can't run: it has errors. Real runs are refused until you activate a version that runs.",
    );
    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <CanvasBanner
        issues={[]}
        workflow={{ ...workflow, active: stale({ runnable: true }) }}
        {...none}
      />,
    );
    expect(container.textContent).toBe('');
    rerender(<CanvasBanner issues={[]} workflow={workflow} {...none} />);
    expect(container.textContent).toBe('');
  });

  it("when the draft has an error and the active version can't run, only the can't-run banner shows", () => {
    render(
      <CanvasBanner
        issues={issues}
        workflow={{ ...workflow, active: stale() }}
        activeIssues={[activeIssue]}
        activatable={null}
      />,
    );
    const banners = screen.getAllByRole('status');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toMatch(/^Active v3 can't run/);
  });

  it('shows the pin notice for a dirty sub-workflow that others use', () => {
    render(
      <CanvasBanner
        issues={[]}
        workflow={{ ...workflow, kind: 'subworkflow', usedBy: [{ id: 'a', name: 'A' }] as never }}
        dirty
        {...none}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/^1 workflow pins an older version/);
  });

  it('a draft that switches library says where real runs still take files from (info); with no library in the draft, that activating stops it', () => {
    const feeding = { ...workflow, valid: true, errorCount: 0 };
    const { rerender, container } = render(
      <CanvasBanner
        issues={[]}
        workflow={feeding}
        libraryShift={{ activeVersion: 3, from: 'Shows', to: 'Movies' }}
        {...none}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Real runs still take files from Shows (v3 active). Activate this version to switch to Movies.',
    );
    expect(container.querySelector('.canvas-banner.is-info')).toBeTruthy();
    rerender(
      <CanvasBanner
        issues={[]}
        workflow={feeding}
        libraryShift={{ activeVersion: 3, from: 'Shows', to: null }}
        {...none}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Real runs still take files from Shows (v3 active). Activating this version stops that.',
    );
  });

  it('the draft-error banner wins over the library banner', () => {
    render(
      <CanvasBanner
        issues={issues}
        workflow={workflow}
        libraryShift={{ activeVersion: 3, from: 'Shows', to: 'Movies' }}
        {...none}
      />,
    );
    const banners = screen.getAllByRole('status');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toMatch(/^Can't activate/);
  });
});

describe('PastVersionBanner', () => {
  const base = { current: 7, editHref: '/workflows/wf1', restoring: false, onRestore: vi.fn() };

  it('offers "Activate vN" beside "Restore as new version"', () => {
    const onClick = vi.fn();
    renderAt('/', <PastVersionBanner {...base} viewing={2} activate={{ onClick }} />);
    expect(screen.getByRole('button', { name: 'Restore as new version' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activate v2' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('on the current version: "Viewing v3 — active" with "Edit it" and, when offered, Activate', () => {
    const onClick = vi.fn();
    renderAt(
      '/',
      <PastVersionBanner {...base} viewing={7} current={7} viewingActive activate={null} />,
    );
    expect(screen.getByText('Viewing v7 — active')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit it' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
    cleanup();
    renderAt('/', <PastVersionBanner {...base} viewing={7} current={7} activate={{ onClick }} />);
    expect(screen.getByText('Viewing v7 — the current version')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit it' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activate v7' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('the active version says "Viewing v3 — active" with no Activate', () => {
    renderAt('/', <PastVersionBanner {...base} viewing={3} viewingActive activate={null} />);
    expect(screen.getByText('Viewing v3 — active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
  });
});
