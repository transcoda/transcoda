import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { JobDetail, WorkflowDetail } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import * as example from '../test/fixtures/beforeAfter.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import { chainMainReplace } from '../test/fixtures/graphs.ts';
import { blueyPlan, blueyProbe, blueyResult } from '../test/fixtures/plan.ts';
import { renderAt } from '../test/render.tsx';

const mocks = vi.hoisted(() => ({
  jobGet: vi.fn(),
  jobLog: vi.fn(),
  queue: vi.fn(),
  workflowGet: vi.fn(),
  activate: vi.fn(),
  versions: vi.fn(),
  jobsList: vi.fn(),
  librariesList: vi.fn(),
  browse: vi.fn(),
  nodesList: vi.fn(),
  workflowsList: vi.fn(async () => ({ workflows: [] })),
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      jobs: { get: mocks.jobGet, log: mocks.jobLog, queue: mocks.queue, list: mocks.jobsList },
      nodes: { list: mocks.nodesList },
      workflows: {
        get: mocks.workflowGet,
        versions: mocks.versions,
        activate: mocks.activate,
        list: mocks.workflowsList,
      },
      libraries: { list: mocks.librariesList, browse: mocks.browse },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { JobPage } from './JobPage.tsx';

const AT = '2026-10-16T18:00:00.000Z';

function trace(nodeId: string, seq: number, reason: string) {
  return {
    seq,
    attempt: 1,
    nodeId,
    workflowPath: [],
    phase: 'decide' as const,
    port: 'out',
    reason,
    findings: {},
    startedAt: AT,
    endedAt: AT,
  };
}

function job(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'j1',
    runId: 'r1',
    state: 'dry_run',
    paused: false,
    lane: null,
    attempt: 1,
    priority: 0,
    heldByRunHours: null,
    dryRun: true,
    testEncode: false,
    testOutput: null,
    testOutputNote: null,
    fileName: 'Bluey S01E03.mp4',
    filePath: '/media/Shows/Bluey/Season 01/Bluey S01E03.mp4',
    libraryId: 'l1',
    libraryName: 'Shows',
    workflowId: 'wf1',
    workflowVersion: 7,
    workflowName: 'TV cleanup',
    progress: null,
    queuedAt: AT,
    startedAt: AT,
    finishedAt: AT,
    reason: null,
    trace: [
      trace('in', 1, 'manual'),
      trace('keep', 2, 'kept en, de, ja'),
      trace('ro', 3, 'would replace'),
    ],
    result: blueyResult(),
    problems: [],
    estimatedBytes: null,
    planSummary: null,
    dependsOnSize: null,
    probe: blueyProbe(),
    outputProbe: null,
    graph: chainMainReplace(),
    plan: blueyPlan(),
    path: [
      { workflowPath: [], nodeId: 'in', port: 'out' },
      { workflowPath: [], nodeId: 'keep', port: 'out' },
      { workflowPath: [], nodeId: 'ro', port: null },
    ],
    ...over,
  };
}

const workflow: WorkflowDetail = {
  id: 'wf1',
  name: 'TV cleanup',
  kind: 'workflow',
  active: null,
  currentVersion: 7,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  usedBy: [],
  createdAt: AT,
  updatedAt: AT,
  version: 7,
  graph: chainMainReplace(),
  issues: [],
  activeIssues: [],
  settings: null,
};

const scrolled: string[] = [];

beforeEach(() => {
  resetCatalogCache();
  mocks.nodesList.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.jobGet.mockReset().mockResolvedValue(job());
  mocks.jobLog.mockReset().mockResolvedValue({ log: '' });
  mocks.workflowGet.mockReset().mockResolvedValue(workflow);
  mocks.queue.mockReset().mockResolvedValue({ runId: 'r2', jobIds: ['j2'] });
  mocks.activate.mockReset();
  mocks.versions.mockReset().mockResolvedValue({ versions: [] });
  mocks.jobsList.mockReset().mockResolvedValue({ jobs: [] });
  mocks.librariesList.mockReset().mockResolvedValue({ libraries: [], notices: [] });
  mocks.browse.mockReset();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent ?? '');
  };
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function renderJob(path = '/jobs/j1') {
  return renderAt(path, <Route path="/jobs/:id" component={JobPage} />);
}

describe('JobPage dry-run plan (Task 24)', () => {
  it('renders the plan above the steps and the command for a dry run', async () => {
    renderJob();
    expect(await screen.findByText('Nothing on disk changed')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Bluey S01E03.mp4' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Audio' })).toBeTruthy();
    const decisions = screen.getByRole('region', { name: 'What the workflow would do' });
    expect(within(decisions).getAllByRole('listitem')).toHaveLength(3);
    expect(decisions.textContent).toContain('Kept en, de, ja');
    // A dry run never ran it; the command is only inside the collapsed raw ffmpeg output.
    const raw = screen.getByText('Raw ffmpeg output').closest('details') as HTMLDetailsElement;
    expect(raw.open).toBe(false);
    const command = within(raw).getByRole('region', { name: 'ffmpeg command (not run)' });
    expect(command.textContent).toContain('ffmpeg -i "Bluey S01E03.mp4"');
    // The plan comes before the decisions in the page.
    const audio = screen.getByRole('region', { name: 'Audio' });
    expect(audio.compareDocumentPosition(decisions) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('a test-encode ran its command: the command block has no "not run" note', async () => {
    mocks.jobGet.mockResolvedValue(job({ testEncode: true }));
    renderJob();
    await screen.findByRole('heading', { level: 1, name: 'Bluey S01E03.mp4' });
    expect(screen.getByRole('region', { name: 'ffmpeg command' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'ffmpeg command (not run)' })).toBeNull();
  });

  it('badges the dry run and words its write step as what it does', async () => {
    mocks.jobGet.mockResolvedValue(
      job({
        trace: [
          trace('in', 1, 'manual'),
          trace('keep', 2, 'kept en, de, ja'),
          trace('ro', 3, 'replace the original (recycle folder: library default)'),
        ],
      }),
    );
    renderJob();
    const decisions = await screen.findByRole('region', { name: 'What the workflow would do' });
    expect(decisions.textContent).toContain(
      "Replaces the original, which moves to this library's recycle folder",
    );
    expect(within(decisions).getByText('Dry run')).toBeTruthy();
    expect(screen.getAllByText('Dry run').length).toBeGreaterThan(0);
    expect(
      document.querySelector('.job-head-chips .badge-dry, .job-head-chips .job-chip.is-dry'),
    ).not.toBeNull();
  });

  it('a real run that wrote words its write step in the past', async () => {
    mocks.jobGet.mockResolvedValue(
      job({
        dryRun: false,
        state: 'done',
        trace: [
          trace('in', 1, 'manual'),
          trace('keep', 2, 'kept en, de, ja'),
          trace('ro', 3, 'replace the original (recycle folder: library default)'),
        ],
      }),
    );
    renderJob();
    const decisions = await screen.findByRole('region', { name: 'What the workflow did' });
    expect(decisions.textContent).toContain('Replaced the original');
    expect(within(decisions).queryByText('Dry run')).toBeNull();
  });

  it('toolbar "Try this node" navigates with ?node=<id> and JobPage preselects it', async () => {
    renderJob('/jobs/j1?node=keep');
    const decisions = await screen.findByRole('region', { name: 'What the workflow would do' });
    await waitFor(() => expect(within(decisions).getAllByRole('listitem')).toHaveLength(3));
    const selected = within(decisions)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('Kept en, de, ja');
    await waitFor(() => expect(scrolled.some((t) => t.includes('Kept en, de, ja'))).toBe(true));
  });

  it('"Activate v7 of TV cleanup…" opens the dialog for v7 with its library sentence; hidden when v7 is active; "Dry run another file" opens the picker', async () => {
    renderJob();
    fireEvent.click(await screen.findByRole('button', { name: 'Activate v7 of TV cleanup…' }));
    const activate = await screen.findByRole('dialog', { name: 'Activate v7 of TV cleanup?' });
    // v7 has a Manual input: no library sends it files.
    await waitFor(() =>
      expect(activate.textContent).toContain(
        'No library sends files to v7; it runs only when you use Run on a file.',
      ),
    );
    fireEvent.click(within(activate).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Dry run another file' }));
    const picker = await screen.findByRole('dialog', { name: 'Dry run TV cleanup on a file' });
    expect(await within(picker).findByText('Create a library first')).toBeTruthy();
  });

  it('activating from the dialog removes the button', async () => {
    mocks.activate.mockResolvedValue({
      ...workflow,
      active: { version: 7, runnable: true, activatedAt: AT, activatedBy: 'u1' },
    });
    renderJob();
    fireEvent.click(await screen.findByRole('button', { name: 'Activate v7 of TV cleanup…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate v7 of TV cleanup?' });
    const primary = within(dialog).getByRole('button', { name: 'Activate v7' });
    await waitFor(() => expect((primary as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(primary);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.activate).toHaveBeenCalledWith({ id: 'wf1', version: 7, confirm: true });
    expect(screen.queryByRole('button', { name: /^Activate v7 of/ })).toBeNull();
  });

  it("hides the button when the job's version is the active one", async () => {
    mocks.workflowGet.mockResolvedValue({
      ...workflow,
      active: { version: 7, runnable: true, activatedAt: AT, activatedBy: 'u1' },
    });
    renderJob();
    await screen.findByText('Nothing on disk changed');
    await waitFor(() => expect(mocks.workflowGet).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^Activate v7 of/ })).toBeNull();
  });

  it('a failed workflow load says so with "Try again"; once it loads, "Activate …" appears', async () => {
    mocks.workflowGet.mockRejectedValueOnce(new TypeError('fetch failed'));
    renderJob();
    const alert = await screen.findByText(
      'Could not check which version of TV cleanup is active: Could not reach the server',
    );
    expect(screen.queryByRole('button', { name: 'Activate v7 of TV cleanup…' })).toBeNull();
    fireEvent.click(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: 'Try again',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Activate v7 of TV cleanup…' })).toBeTruthy();
    expect(screen.queryByText(/Could not check which/)).toBeNull();
  });

  it('a job without a plan shows no plan view', async () => {
    mocks.jobGet.mockResolvedValue(job({ state: 'probing', plan: null, result: null }));
    renderJob();
    await screen.findByRole('heading', { level: 1, name: 'Bluey S01E03.mp4' });
    expect(screen.queryByRole('region', { name: 'Audio' })).toBeNull();
    // Without the plan's eyebrow, the header says it is a dry run.
    expect(screen.getAllByText('Dry run · Nothing on disk changed')).toHaveLength(1);
  });
});

describe('JobPage before and after', () => {
  const encoded = () => {
    const e = example.testEncode();
    return job({
      fileName: 'Film.mkv',
      testEncode: true,
      probe: e.probe,
      outputProbe: e.outputProbe,
      plan: e.plan,
      result: {
        ...blueyResult(),
        outcome: 'dry_run',
        beforeBytes: 11_580_000_000,
        afterBytes: 2_120_000_000,
      },
    });
  };

  it('a test-encode shows the panel under the result, and the result says each size once', async () => {
    mocks.jobGet.mockResolvedValue(encoded());
    renderJob();
    const panel = await screen.findByRole('region', { name: 'Before and after' });
    const result = screen.getByRole('region', { name: 'Result' });
    expect(result.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(result.textContent?.match(/2\.12 GB/g)).toHaveLength(1);
    expect(within(panel).getByRole('row', { name: /^Audio 1/ }).textContent).toContain('downmixed');
  });

  it('a job still running has no panel', async () => {
    mocks.jobGet.mockResolvedValue({ ...encoded(), state: 'encoding', result: null });
    renderJob();
    await screen.findByRole('heading', { level: 1, name: 'Film.mkv' });
    expect(screen.queryByRole('region', { name: 'Before and after' })).toBeNull();
  });
});
