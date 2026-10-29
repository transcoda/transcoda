import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { TraceChanges } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Decision } from '../editor/trace/traceOverlay.ts';
import { renderAt } from '../test/render.tsx';
import { JobSteps } from './JobSteps.tsx';
import type { StepContext } from './steps.ts';

const none: TraceChanges = {
  dropped: [],
  added: [],
  converted: [],
  defaults: [],
  reordered: false,
  other: false,
};

const d = (over: Partial<Decision> & Pick<Decision, 'key' | 'nodeId' | 'title'>): Decision => ({
  attempt: 1,
  depth: 0,
  reason: '',
  findings: {},
  workflowPath: [],
  kind: 'action',
  type: null,
  settings: {},
  phase: 'build',
  changes: null,
  within: null,
  plugin: false,
  port: 'file',
  untaken: false,
  branch: null,
  ...over,
});

const CTX: StepContext = {
  dryRun: true,
  state: 'dry_run',
  probe: null,
  libraryName: 'Shows',
  workflowId: 'w1',
  dependsOnSize: false,
  replacedTo: null,
};

const ITEMS: Decision[] = [
  d({
    key: '1',
    nodeId: 'in',
    title: 'Library input',
    kind: 'trigger',
    type: 'core:input-library',
    phase: 'pass',
  }),
  d({
    key: '2',
    nodeId: 'sdt',
    title: 'Set default track',
    type: 'core:set-default-track',
    changes: {
      ...none,
      defaults: [
        {
          index: 1,
          type: 'audio',
          codec: 'aac',
          language: 'eng',
          forced: false,
          before: false,
          after: true,
        },
      ],
    },
  }),
  d({
    key: '3',
    nodeId: 'ev',
    title: 'Encode video',
    type: 'core:encode-video',
    changes: none,
    settings: { skipIf: 'plays-on-all-targets' },
  }),
  d({
    key: '4',
    nodeId: 'ev',
    title: 'Encode video',
    type: 'core:encode-video',
    attempt: 2,
    reason: 'failed: no hevc encoder is available',
  }),
];

afterEach(cleanup);

function show(items = ITEMS, onSelect = vi.fn(), reveal: string | null = null) {
  renderAt(
    '/jobs/j1',
    <JobSteps items={items} context={CTX} selected={null} onSelect={onSelect} reveal={reveal} />,
  );
  return { onSelect, section: screen.getByRole('region', { name: 'What the workflow would do' }) };
}

describe('JobSteps', () => {
  it('names each node with its kind, says what it does, and badges it', () => {
    const { section } = show();
    const list = within(section).getByRole('list', { name: 'What the workflow would do' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('Trigger')).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByText('Picked up from the Shows library'),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Changes file')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('No change')).toBeTruthy();
    expect(within(section).getByText('Dry run')).toBeTruthy();
  });

  it('only a row with details has the chevron; it expands the before/after table', () => {
    const { section } = show();
    const rows = within(section).getAllByRole('listitem');
    expect(
      within(rows[0] as HTMLElement).queryByRole('button', { name: /^Details for/ }),
    ).toBeNull();
    const more = within(rows[1] as HTMLElement).getByRole('button', {
      name: 'Details for Set default track',
    });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const table = within(rows[1] as HTMLElement).getByRole('table');
    expect(table.closest(`[id="${more.getAttribute('aria-controls')}"]`)).not.toBeNull();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Track', 'Language', 'Default before', 'Default after']);
    expect(
      within(table)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['audio #1', 'English', 'no', 'yes']);
  });

  it('an unmet precondition is a note under its row with a link to fix it; the head counts the steps', () => {
    const { section } = show();
    const note = within(section).getByText(/Playback compatibility wasn't checked/);
    expect(
      within(note.closest('p') as HTMLElement)
        .getByRole('link', { name: 'Add targets in the workflow' })
        .getAttribute('href'),
    ).toBe('/workflows/w1');
    expect(section.querySelector('.section-count')?.textContent).toBe('4 steps');
  });

  it("a later attempt's steps are under Retry", () => {
    const { section } = show();
    expect(within(section).getByRole('heading', { level: 3, name: 'Retry' })).toBeTruthy();
    const retry = within(section).getByRole('list', { name: 'Retry' });
    expect(within(retry).getByText('No hevc encoder is available')).toBeTruthy();
    expect(within(retry).getByText('Failed')).toBeTruthy();
  });

  it('clicking a row selects its node', () => {
    const { section, onSelect } = show();
    fireEvent.click(within(section).getByText('Picked up from the Shows library'));
    expect(onSelect).toHaveBeenCalledWith({ workflowPath: [], nodeId: 'in' });
  });

  it('the All / Changes pills filter to the steps that change the file', () => {
    const { section } = show();
    const all = within(section).getByRole('button', { name: 'All 4' });
    const changes = within(section).getByRole('button', { name: 'Changes 1' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(changes);
    expect(changes.getAttribute('aria-pressed')).toBe('true');
    expect(within(section).queryByText('No change')).toBeNull();
    fireEvent.click(all);
    expect(within(section).getByText('No change')).toBeTruthy();
  });

  it('no pills when they would not narrow the list', () => {
    show(ITEMS.slice(0, 1));
    expect(document.querySelector('.job-steps-filter')).toBeNull();
  });

  it('nothing decided (yet, or ever for a failed job): no section at all', () => {
    renderAt('/jobs/j1', <JobSteps items={[]} context={CTX} selected={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('region')).toBeNull();
    cleanup();
    renderAt(
      '/jobs/j1',
      <JobSteps
        items={[]}
        context={{ ...CTX, dryRun: false, state: 'failed' }}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region')).toBeNull();
  });
});
