import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { JobDetail } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentNode } from '../editor/trace/traceOverlay.ts';
import { activitySummary, ringState } from '../jobs/activity.ts';
import { detailLine, type Job } from '../jobs/jobText.ts';
import type { Activity } from '../jobs/useActivity.ts';

const state = vi.hoisted(() => ({
  activity: null as Activity | null,
  detailsFor: [] as Array<readonly string[]>,
  listeners: new Set<() => void>(),
}));
vi.mock('../jobs/useActivity.ts', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (fn: () => void) => {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  };
  return {
    useActivity: (opts: { detailsFor: readonly string[] }) => {
      state.detailsFor.push(opts.detailsFor);
      return useSyncExternalStore(subscribe, () => state.activity);
    },
  };
});
// Built here, not from test/fixtures/catalog.ts: that file imports this module (a mock cycle).
vi.mock('../hooks/useCatalog.ts', async (importActual) => {
  const actual = await importActual<typeof import('../hooks/useCatalog.ts')>();
  const { NodesListOutputSchema } = await import('@transcoda/contract');
  const raw = (await import('../test/fixtures/nodes.json')).default;
  const catalog = actual.buildCatalog(NodesListOutputSchema.parse(raw).nodes);
  return { ...actual, useCatalog: () => ({ catalog, error: null, reload() {} }) };
});

import { fx, job } from '../test/fixtures/jobs.ts';
import { ELSE_PATH, ELSE_TRACE, jobDetail } from '../test/fixtures/trace.ts';
import { renderAt } from '../test/render.tsx';
import { ActivityButton } from './ActivityButton.tsx';

const A = job({ ...fx.running, id: 'a', workflowName: 'TV cleanup', workflowVersion: 3 });
const B = job({ ...fx.verifying, id: 'b', fileName: 'Severance S02E01.mkv' });

function activity(
  running: Job[],
  queued: number,
  paused = false,
  details: ReadonlyMap<string, JobDetail> = new Map(),
  current: ReadonlyMap<string, CurrentNode | null> = new Map(),
): Activity {
  return {
    summary: activitySummary({ running, queued, paused }),
    running,
    queued,
    paused,
    ring: ringState(running),
    details,
    current,
  };
}

/** Sets what the hook answers; a mounted widget re-renders with it. */
function setUp(a: Activity) {
  state.activity = a;
  act(() => {
    for (const fn of state.listeners) fn();
  });
}

function show(path = '/', phone = false) {
  return renderAt(
    path,
    <>
      <main id="main-content" tabIndex={-1}>
        <button type="button">elsewhere</button>
      </main>
      <ActivityButton phone={phone} />
    </>,
  );
}

const button = () => screen.getByRole('button', { name: /^Activity/ });

beforeEach(() => {
  state.detailsFor = [];
  setUp(activity([A], 3));
});
afterEach(() => cleanup());

describe('ActivityButton', () => {
  it('renders nothing when there is nothing to show', () => {
    setUp(activity([], 0, true));
    const { container } = show();
    expect(container.querySelector('.activity')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Activity/ })).toBeNull();
  });

  it('is a disclosure button named by the summary; its visible text is hidden from readers', () => {
    show();
    const b = button();
    expect(b.getAttribute('aria-label')).toBe(
      'Activity: encoding 1 job at 42%, 3 queued. Show details',
    );
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-controls')).toBe('activity-panel');
    const text = b.querySelector('.activity-text') as HTMLElement;
    expect(text.textContent).toBe('Encoding 1 · 3 queued');
    expect(text.getAttribute('aria-hidden')).toBe('true');
    expect(b.querySelector('.activity-ring')).not.toBeNull();
    // No live region: progress ticks are never announced.
    const root = b.closest('.activity') as HTMLElement;
    expect(root.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it('draws a determinate ring for one encoding job and a neutral one otherwise', () => {
    const view = show();
    const ring = view.container.querySelector('.activity-ring') as SVGElement;
    expect(ring.classList.contains('is-determinate')).toBe(true);
    expect(ring.querySelector('.activity-ring-value')?.getAttribute('stroke-dashoffset')).not.toBe(
      null,
    );
    cleanup();
    setUp(activity([A, B], 0));
    const two = show();
    const neutral = two.container.querySelector('.activity-ring') as SVGElement;
    expect(neutral.classList.contains('is-neutral')).toBe(true);
    expect(neutral.querySelector('.activity-ring-value')).toBeNull();
  });

  it('opens a panel with each job, its workflow and version, step and progress, and Open Jobs', () => {
    const detail = jobDetail({ id: 'a', state: 'encoding', path: ELSE_PATH, trace: ELSE_TRACE });
    setUp(activity([A, B], 3, false, new Map([['a', detail]])));
    show();
    expect(state.detailsFor.at(-1)).toEqual([]);
    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(state.detailsFor.at(-1)).toEqual(['a', 'b']);

    const panel = screen.getByRole('region', { name: 'Activity' });
    expect(panel.id).toBe('activity-panel');
    const rows = panel.querySelectorAll('.activity-job');
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByRole('link', { name: A.fileName }).getAttribute('href')).toBe('/jobs/a');
    expect(first.getByText('TV cleanup v3')).toBeTruthy();
    expect(first.getByText('Encode video')).toBeTruthy();
    expect(first.getByText('42% · about 3 min left')).toBeTruthy();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByRole('link', { name: B.fileName }).getAttribute('href')).toBe('/jobs/b');
    // No detail yet: the phase words.
    expect(second.getByText(detailLine(B))).toBeTruthy();
    expect(within(panel).getByText('3 queued')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open Jobs' }).getAttribute('href')).toBe(
      '/jobs',
    );
    // Links only (Jan): no queue controls in the popover.
    expect(within(panel).queryByRole('button', { name: /pause|resume/i })).toBeNull();
  });

  it('an encoding job shows a progress bar at its percent; a job without one shows none', () => {
    setUp(activity([A, B], 0));
    show();
    fireEvent.click(button());
    const panel = screen.getByRole('region', { name: 'Activity' });
    const bar = within(panel).getByRole('progressbar', { name: `${A.fileName} progress` });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('42%');
    expect(within(panel).getAllByRole('progressbar')).toHaveLength(1);
  });

  it('says when the queue is paused', () => {
    setUp(activity([], 3, true));
    show();
    fireEvent.click(button());
    const panel = screen.getByRole('region', { name: 'Activity' });
    expect(within(panel).getByText('Queue paused · 3 queued')).toBeTruthy();
    expect(panel.querySelectorAll('.activity-job')).toHaveLength(0);
  });

  it('Escape closes and puts focus back on the button', () => {
    show();
    fireEvent.click(button());
    const link = screen.getByRole('link', { name: 'Open Jobs' });
    link.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button());
  });

  it('a mousedown outside closes; one inside does not', () => {
    show();
    fireEvent.click(button());
    fireEvent.mouseDown(screen.getByRole('region', { name: 'Activity' }));
    expect(screen.queryByRole('region', { name: 'Activity' })).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
  });

  it('choosing a link closes the panel', () => {
    const view = show('/libraries');
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('link', { name: 'Open Jobs' }));
    expect(view.location()).toBe('/jobs');
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
  });

  it('when everything finishes while open, it goes away and focus moves to the main content', () => {
    show();
    fireEvent.click(button());
    screen.getByRole('link', { name: 'Open Jobs' }).focus();
    setUp(activity([], 0));
    expect(screen.queryByRole('button', { name: /^Activity/ })).toBeNull();
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('leaves focus alone when it was elsewhere', () => {
    show();
    fireEvent.click(button());
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    act(() => elsewhere.focus());
    setUp(activity([], 0));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('shows the Dry run badge only when every running job is a dry run, and says so', () => {
    setUp(activity([{ ...A, dryRun: true }], 0));
    show();
    expect(button().querySelector('.badge-dry')).not.toBeNull();
    expect(button().getAttribute('aria-label')).toBe(
      'Activity, dry run: encoding 1 job at 42%. Show details',
    );
    cleanup();
    setUp(activity([{ ...A, dryRun: true }, B], 0));
    show();
    expect(button().querySelector('.badge-dry')).toBeNull();
    fireEvent.click(button());
    const rows = document.querySelectorAll('.activity-job');
    expect(rows[0]?.querySelector('.badge-dry')).not.toBeNull();
    expect(rows[1]?.querySelector('.badge-dry')).toBeNull();
  });

  it('on a phone shows the count only; the name still carries the full text', () => {
    show('/', true);
    const b = button();
    expect(b.querySelector('.activity-text')).toBeNull();
    const count = b.querySelector('.activity-count') as HTMLElement;
    expect(count.textContent).toBe('4');
    expect(count.getAttribute('aria-hidden')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe(
      'Activity: encoding 1 job at 42%, 3 queued. Show details',
    );
  });
});
