import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SubworkflowSetting, WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import {
  type Issue,
  type JsonValue,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBeforeNavigate } from '../../lib/navigation.tsx';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { tiggerPoohSub } from '../../test/fixtures/graphs.ts';
import { nodeStateFor } from '../model/issues.ts';
import type { ApplyOptions, GraphOp } from './Canvas.tsx';
import { OverridesEditor } from './OverridesEditor.tsx';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: { workflows: { get: mocks.get } },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { RunSubworkflowInspector } from './RunSubworkflowInspector.tsx';

afterEach(cleanup);

const summaryOf = (id: string, name: string, currentVersion: number): WorkflowSummary => ({
  id,
  name,
  kind: 'subworkflow',
  active: null,
  currentVersion,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  usedBy: [],
  createdAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
});

// "Audio fixes" first: the picker must still put the pinned one first.
const subworkflows = [
  summaryOf('sub-audio', 'Audio fixes', 2),
  summaryOf('sub-lang', 'Language cleanup', 3),
];

type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);

/** What the server's `subworkflowSettings` answers for a child graph (start/end/Run excluded). */
function settingsOf(graph: WorkflowGraph): SubworkflowSetting[] {
  const skip = new Set([SUBWORKFLOW_START_TYPE, SUBWORKFLOW_END_TYPE, RUN_SUBWORKFLOW_TYPE]);
  const out: SubworkflowSetting[] = [];
  for (const n of graph.nodes) {
    const def = catalogFixture.byType.get(n.type);
    if (skip.has(n.type) || !def || !isObject(def.settingsSchema)) continue;
    const properties = def.settingsSchema.properties;
    if (!isObject(properties)) continue;
    for (const [settingKey, schema] of Object.entries(properties)) {
      const own = isObject(n.settings) ? n.settings[settingKey] : undefined;
      const fallback = isObject(schema) ? schema.default : undefined;
      out.push({
        key: `${n.id}.${settingKey}`,
        nodeId: n.id,
        nodeTitle: n.label ?? def.title,
        settingKey,
        schema,
        default: own ?? fallback ?? null,
      });
    }
  }
  return out;
}

function childDetail(graph = tiggerPoohSub(), settings = settingsOf(graph)): WorkflowDetail {
  return {
    ...summaryOf('sub-lang', 'Language cleanup', 3),
    version: 3,
    graph,
    issues: [],
    activeIssues: [],
    settings,
  };
}

function runNode(settings: JsonValue): NodeInstance {
  return {
    id: 'run-a',
    type: RUN_SUBWORKFLOW_TYPE,
    typeVersion: 1,
    settings,
    position: { x: 0, y: 0 },
  };
}

const pinned = (overrides: JsonObject = {}, subworkflowId = 'sub-lang', version = 3) =>
  runNode({ subworkflowId, version, overrides });

function renderRun(
  instance: NodeInstance,
  opts: {
    issues?: Issue[];
    readOnly?: boolean;
    list?: WorkflowSummary[];
    focusField?: string | null;
  } = {},
) {
  const dispatch = vi.fn((_op: GraphOp, _opts?: ApplyOptions) => true);
  const graph: WorkflowGraph = {
    formatVersion: 2,
    kind: 'workflow',
    nodes: [instance],
    edges: [],
    groups: [],
  };
  const view = render(
    <RunSubworkflowInspector
      instance={instance}
      state={nodeStateFor(instance.id, opts.issues ?? [])}
      subworkflows={opts.list ?? subworkflows}
      readOnly={opts.readOnly ?? false}
      dispatch={dispatch}
      focusField={opts.focusField ?? null}
    />,
  );
  /** The Run node's settings after the last dispatched op. */
  const lastSettings = (): JsonValue => {
    const op = dispatch.mock.calls.at(-1)?.[0];
    if (!op) throw new Error('nothing dispatched');
    const result = op(graph);
    if (!result.ok) throw new Error(result.refusal.reason);
    return result.graph.nodes[0]?.settings ?? null;
  };
  return { ...view, dispatch, lastSettings };
}

const picker = () => screen.getByRole('combobox', { name: 'Sub-workflow' }) as HTMLSelectElement;
const optionNames = () =>
  within(picker())
    .getAllByRole('option')
    .map((o) => o.textContent);

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(childDetail());
});

describe('RunSubworkflowInspector', () => {
  it("focuses the picker when the card's summary asks for the sub-workflow field (N12)", () => {
    renderRun(pinned({}), { focusField: 'subworkflowId' });
    expect(document.activeElement).toBe(picker());
  });

  it("lists sub-workflows in the picker and switching re-pins to the chosen one's current version with empty overrides", async () => {
    const { lastSettings } = renderRun(pinned({ 'keep.languages': ['en', 'de', 'tr'] }));
    expect(optionNames()).toEqual(['Language cleanup', 'Audio fixes']);
    expect(picker().value).toBe('sub-lang');
    await screen.findByRole('heading', { level: 3, name: 'Keep languages' });
    expect(mocks.get).toHaveBeenCalledWith({ id: 'sub-lang', version: 3 });

    fireEvent.change(picker(), { target: { value: 'sub-audio' } });
    expect(lastSettings()).toEqual({ subworkflowId: 'sub-audio', version: 2, overrides: {} });
  });

  it('a Run node without a sub-workflow offers "Choose a sub-workflow" and loads nothing', () => {
    const { lastSettings } = renderRun(runNode({ overrides: {} }));
    expect(optionNames()).toEqual(['Choose a sub-workflow', 'Audio fixes', 'Language cleanup']);
    expect(picker().value).toBe('');
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Open sub-workflow' })).toBeNull();
    fireEvent.change(picker(), { target: { value: 'sub-lang' } });
    expect(lastSettings()).toEqual({ subworkflowId: 'sub-lang', version: 3, overrides: {} });
  });

  it('shows "v3 pinned · v4 available" with "Update to v4" from the SUBWORKFLOW_OUTDATED issue and dispatches setPinnedVersion', async () => {
    const outdated: Issue = {
      severity: 'warning',
      code: 'SUBWORKFLOW_OUTDATED',
      message: 'Run sub-workflow uses version 3; the latest is 4',
      nodeId: 'run-a',
    };
    // The list still says v3 (loaded earlier); the issue alone knows about v4.
    const { lastSettings } = renderRun(pinned({ 'keep.languages': ['en'] }), {
      issues: [outdated],
    });
    expect(screen.getByText('v3 pinned · v4 available')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open sub-workflow' });
    expect(link.getAttribute('href')).toBe('/workflows/sub-lang?version=3');

    fireEvent.click(screen.getByRole('button', { name: 'Update to v4' }));
    expect(lastSettings()).toEqual({
      subworkflowId: 'sub-lang',
      version: 4,
      overrides: { 'keep.languages': ['en'] },
    });
    await screen.findByRole('heading', { level: 3, name: 'Keep languages' });
  });

  it('"Open sub-workflow" asks the leave guard (a dirty draft gets the leave dialog first)', async () => {
    const asked: string[] = [];
    const release = setBeforeNavigate((target) => {
      asked.push('to' in target ? target.to : 'run');
      return false;
    });
    try {
      renderRun(pinned({}));
      fireEvent.click(screen.getByRole('link', { name: 'Open sub-workflow' }));
      expect(asked).toEqual(['/workflows/sub-lang?version=3']);
      await screen.findByRole('heading', { level: 3, name: 'Keep languages' });
    } finally {
      release();
    }
  });

  it('a newer version in the list alone also offers the update; an up-to-date pin offers none', async () => {
    const { unmount } = renderRun(pinned({}, 'sub-lang', 2));
    expect(screen.getByText('v2 pinned · v3 available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update to v3' })).toBeTruthy();
    await screen.findByRole('heading', { level: 3, name: 'Keep languages' });
    unmount();

    renderRun(pinned());
    expect(screen.getByText('v3 pinned')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
    await screen.findByRole('heading', { level: 3, name: 'Keep languages' });
  });

  it('renders overrides grouped by node title with the child default; switching Override on sets the key, off removes it', async () => {
    const { lastSettings, unmount } = renderRun(pinned());
    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Keep languages',
      'Set default track',
      'Reorder tracks',
    ]);
    const keep = screen.getByRole('region', { name: 'Keep languages' });
    const row = within(keep).getByText('Languages to keep').closest('.override-row') as HTMLElement;
    expect(within(row).getByText('en, de')).toBeTruthy();
    expect(within(keep).getAllByText('yes')).toHaveLength(2);
    // Off: the default only, no control.
    expect(within(row).queryByRole('group', { name: 'Languages to keep' })).toBeNull();
    const toggle = within(row).getByRole('switch', { name: 'Override Languages to keep' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    // Starts from the child's value.
    expect(lastSettings()).toEqual({
      subworkflowId: 'sub-lang',
      version: 3,
      overrides: { 'keep.languages': ['en', 'de'] },
    });
    unmount();

    const on = renderRun(pinned({ 'keep.languages': ['en', 'de', 'tr'] }));
    await screen.findAllByRole('heading', { level: 3 });
    const onRow = screen
      .getAllByText('Languages to keep')[0]
      ?.closest('.override-row') as HTMLElement;
    const onToggle = within(onRow).getByRole('switch', { name: 'Override Languages to keep' });
    expect(onToggle.getAttribute('aria-checked')).toBe('true');
    const chips = within(onRow).getByRole('group', { name: 'Languages to keep' });
    expect(within(chips).getByText('Turkish')).toBeTruthy();
    // The row shows the label once; the control's own label is for screen readers only.
    const labels = within(onRow).getAllByText('Languages to keep');
    expect(labels.filter((l) => !l.classList.contains('sr-only'))).toHaveLength(1);

    fireEvent.click(onToggle);
    expect(on.lastSettings()).toEqual({ subworkflowId: 'sub-lang', version: 3, overrides: {} });
  });

  it('while another pin loads it shows "Loading settings…", not the previous pin\'s settings (final review M1)', async () => {
    const view = renderRun(pinned());
    await screen.findAllByRole('heading', { level: 3 });
    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    const next = pinned({}, 'sub-audio', 2);
    view.rerender(
      <RunSubworkflowInspector
        instance={next}
        state={nodeStateFor(next.id, [])}
        subworkflows={subworkflows}
        readOnly={false}
        dispatch={view.dispatch}
      />,
    );
    expect(mocks.get).toHaveBeenLastCalledWith({ id: 'sub-audio', version: 2 });
    expect(screen.getByText('Loading settings…')).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a stale override key renders "will be dropped on save: keep.gone" with Remove now', async () => {
    const { lastSettings } = renderRun(
      pinned({ 'keep.gone': true, 'keep.languages': ['en', 'de', 'tr'] }),
    );
    expect(await screen.findByText('will be dropped on save: keep.gone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove now' }));
    expect(lastSettings()).toEqual({
      subworkflowId: 'sub-lang',
      version: 3,
      overrides: { 'keep.languages': ['en', 'de', 'tr'] },
    });
  });

  it('a deleted sub-workflow renders "(no longer exists)" in the picker and "Sub-workflow no longer exists" instead of the editor', async () => {
    mocks.get.mockRejectedValue(
      new ORPCError('NOT_FOUND', { defined: true, status: 404, message: 'Not found' }),
    );
    const issue: Issue = {
      severity: 'error',
      code: 'SUBWORKFLOW_MISSING',
      message: 'Run sub-workflow: sub-workflow gone-id version 3 does not exist',
      nodeId: 'run-a',
    };
    const { lastSettings } = renderRun(pinned({ 'keep.languages': ['tr'] }, 'gone-id'), {
      issues: [issue],
    });
    expect(await screen.findByText('Sub-workflow no longer exists')).toBeTruthy();
    expect(optionNames()).toEqual([
      'gone-id (no longer exists)',
      'Audio fixes',
      'Language cleanup',
    ]);
    expect(picker().value).toBe('gone-id');
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.queryByText(/will be dropped on save/)).toBeNull();

    // The picker still works.
    fireEvent.change(picker(), { target: { value: 'sub-lang' } });
    expect(lastSettings()).toEqual({ subworkflowId: 'sub-lang', version: 3, overrides: {} });
  });

  it('another load failure says so with "Try again"', async () => {
    mocks.get.mockRejectedValueOnce(new TypeError('fetch failed'));
    renderRun(pinned());
    expect(
      await screen.findByText('Could not load its settings: Could not reach the server'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 3, name: 'Keep languages' });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('lists only the child settings schema: never start, end or nested Run node settings', async () => {
    const graph = tiggerPoohSub();
    graph.nodes.push({
      id: 'nested',
      type: RUN_SUBWORKFLOW_TYPE,
      typeVersion: 1,
      settings: { subworkflowId: 'sub-audio', version: 1, overrides: {} },
      position: { x: 0, y: 0 },
    });
    const leaked = (nodeId: string, nodeTitle: string, settingKey: string): SubworkflowSetting => ({
      key: `${nodeId}.${settingKey}`,
      nodeId,
      nodeTitle,
      settingKey,
      schema: { type: 'string', description: `Leaked ${nodeId}` },
      default: 'x',
    });
    // A server answer that (wrongly) included them must still not offer them.
    mocks.get.mockResolvedValue(
      childDetail(graph, [
        ...settingsOf(graph),
        leaked('start', 'Start', 'x'),
        leaked('end', 'End', 'x'),
        leaked('nested', 'Run sub-workflow', 'subworkflowId'),
      ]),
    );
    renderRun(pinned());
    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Keep languages',
      'Set default track',
      'Reorder tracks',
    ]);
    expect(screen.queryByText(/^Leaked/)).toBeNull();
    // An override of such a key is stale, not editable.
    cleanup();
    renderRun(pinned({ 'nested.subworkflowId': 'sub-lang' }));
    expect(await screen.findByText('will be dropped on save: nested.subworkflowId')).toBeTruthy();
  });

  it('read-only: picker, update, switches and Remove now are disabled', async () => {
    renderRun(pinned({ 'keep.gone': 1 }, 'sub-lang', 2), { readOnly: true });
    await screen.findAllByRole('heading', { level: 3 });
    expect(picker().disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Update to v3' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const s of screen.getAllByRole('switch')) {
      expect((s as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole('button', { name: 'Remove now' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('OverridesEditor', () => {
  const settings = settingsOf(tiggerPoohSub());

  it('an override cleared to nothing keeps its control open until switched off', () => {
    const onSet = vi.fn();
    const { rerender } = render(
      <OverridesEditor settings={settings} overrides={{}} readOnly={false} onSet={onSet} />,
    );
    const row = () =>
      screen.getAllByText('Language order')[0]?.closest('.override-row') as HTMLElement;
    fireEvent.click(within(row()).getByRole('switch', { name: 'Override Language order' }));
    expect(onSet).toHaveBeenLastCalledWith('rt.languages', ['en', 'de']);
    // The parent's draft now has the override; the user removes every chip.
    rerender(
      <OverridesEditor
        settings={settings}
        overrides={{ 'rt.languages': [] }}
        readOnly={false}
        onSet={onSet}
      />,
    );
    rerender(<OverridesEditor settings={settings} overrides={{}} readOnly={false} onSet={onSet} />);
    // Still on (the user did not switch it off), so the control stays.
    expect(
      within(row())
        .getByRole('switch', { name: 'Override Language order' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(row()).getByRole('switch', { name: 'Override Language order' }));
    expect(onSet).toHaveBeenLastCalledWith('rt.languages', undefined);
    expect(
      within(row())
        .getByRole('switch', { name: 'Override Language order' })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('shows the server message for an invalid override under its control', () => {
    render(
      <OverridesEditor
        settings={settings}
        overrides={{ 'keep.languages': ['english'] }}
        issues={new Map([['keep.languages', 'Invalid string: must match pattern']])}
        readOnly={false}
        onSet={vi.fn()}
      />,
    );
    expect(screen.getByText('Invalid string: must match pattern')).toBeTruthy();
  });

  it('renders nothing for an empty settings list', async () => {
    const { container } = render(
      <OverridesEditor settings={[]} overrides={{}} readOnly={false} onSet={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.textContent).toBe('This sub-workflow has no settings to override'),
    );
  });
});
