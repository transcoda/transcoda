import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue, JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture, nodesFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { type EditorState, editorReducer } from '../model/editor-state.ts';
import { nodeStateFor } from '../model/issues.ts';
import { defaultSettings } from '../model/schema-fields.ts';
import type { ApplyOptions, GraphOp } from './Canvas.tsx';
import { headerIssues, Inspector } from './Inspector.tsx';
import { NodeForm } from './NodeForm.tsx';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const summary: WorkflowSummary = {
  id: 'wf1',
  name: 'Smoke',
  kind: 'workflow',
  active: null,
  currentVersion: 3,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  usedBy: [],
  createdAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
};

function stateOf(
  graph: WorkflowGraph,
  selection: EditorState['selection'],
  issues: Issue[] = [],
): EditorState {
  const loaded = editorReducer(null, {
    type: 'loaded',
    workflow: summary,
    version: 3,
    graph,
    issues,
    activeIssues: [],
    readOnly: false,
  });
  if (!loaded) throw new Error('not loaded');
  return { ...loaded, selection };
}

function renderInspector(
  state: EditorState,
  opts: { readOnly?: boolean; focusField?: string | null } = {},
) {
  const dispatch = vi.fn((_op: GraphOp, _opts?: ApplyOptions) => true);
  const onFocused = vi.fn();
  const joinGroup = vi.fn();
  const groupSelection = vi.fn();
  const view = render(
    <Inspector
      state={state}
      catalog={catalogFixture}
      dispatch={dispatch}
      readOnly={opts.readOnly ?? false}
      focusField={opts.focusField ?? null}
      onFocused={onFocused}
      joinGroup={joinGroup}
      groupSelection={groupSelection}
    />,
  );
  /** Runs the last dispatched op on the state's draft. */
  const lastGraph = (): WorkflowGraph => {
    const op = dispatch.mock.calls.at(-1)?.[0];
    if (!op) throw new Error('nothing dispatched');
    const result = op(state.draft);
    if (!result.ok) throw new Error(result.refusal.reason);
    return result.graph;
  };
  return { ...view, dispatch, onFocused, joinGroup, groupSelection, lastGraph };
}

const keepSelected = (issues: Issue[] = [], graph = chainMainReplace()) =>
  stateOf(graph, { nodes: ['keep'], edges: [] }, issues);

const nodeOf = (g: WorkflowGraph, id: string) => g.nodes.find((n) => n.id === id);

function withNode(patch: Partial<NodeInstance> & { id: string }): WorkflowGraph {
  const g = chainMainReplace();
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === patch.id ? ({ ...n, ...patch } as NodeInstance) : n)),
  };
}

describe('Inspector', () => {
  it('renders header, every field of keep-languages and the "On the canvas" section for the selected node', () => {
    renderInspector(keepSelected());
    expect(document.querySelector('.eyebrow-kind')?.textContent).toBe('Action · core');
    expect(screen.getByRole('heading', { level: 2, name: 'Keep languages' })).toBeTruthy();
    expect(
      screen.getByText('Removes audio and subtitle tracks that are not in the chosen languages.'),
    ).toBeTruthy();
    // keep-languages: languages (chips), keepOriginal and keepUntagged (switches).
    const chips = screen.getByRole('group', { name: 'Languages to keep' });
    expect(within(chips).getByText('English')).toBeTruthy();
    expect(within(chips).getByRole('button', { name: 'Add language' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Keep the original language' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Keep tracks without a language tag' })).toBeTruthy();

    const toggle = screen.getByRole('button', { name: 'On the canvas' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const section = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!section) throw new Error('no section');
    const name = within(section).getByRole('textbox', { name: 'Name on the canvas' });
    expect((name as HTMLInputElement).maxLength).toBe(120);
    expect((name as HTMLInputElement).placeholder).toBe('Keep languages');
    const bypass = within(section).getByRole('switch', { name: 'Bypass' });
    expect(bypass.getAttribute('aria-checked')).toBe('false');
    expect(within(section).getByText('The file passes through unchanged')).toBeTruthy();
    const group = within(section).getByRole('combobox', { name: 'Group' });
    expect(within(group).getByRole('option', { name: 'None' })).toBeTruthy();

    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove node' })).toBeTruthy();
  });

  it('changing a field dispatches setSettings with the merged object; clearing removes the key', () => {
    const { dispatch, lastGraph } = renderInspector(keepSelected());
    fireEvent.click(screen.getByRole('switch', { name: 'Keep the original language' }));
    expect(nodeOf(lastGraph(), 'keep')?.settings).toEqual({
      languages: ['en'],
      keepOriginal: false,
      keepUntagged: true,
    });
    // One undo step per field while typing; a different field is a new step.
    expect(dispatch.mock.calls.at(-1)?.[1]).toEqual({
      coalesce: 'settings',
      key: 'keep:keepOriginal',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear Languages to keep' }));
    expect(nodeOf(lastGraph(), 'keep')?.settings).toEqual({
      keepOriginal: true,
      keepUntagged: true,
    });
  });

  it('shows the server\'s INVALID_SETTINGS message under the field by settingPath and the amber "needs a setting" state line', () => {
    renderInspector(
      keepSelected([
        {
          severity: 'error',
          code: 'INVALID_SETTINGS',
          message: 'Needs a setting',
          nodeId: 'keep',
          settingPath: 'languages',
        },
      ]),
    );
    const field = document.querySelector('[data-field="languages"]') as HTMLElement;
    expect(within(field).getByText('Needs a setting')).toBeTruthy();
    const line = screen.getByText(/needs a setting/i, {
      selector: '.inspector-state *, .inspector-state',
    });
    expect(line.closest('.inspector-state')?.classList).toContain('tone-amber');
  });

  it('a nested settingPath reaches its top-level field; a path-less one sits above the form', () => {
    renderInspector(
      keepSelected([
        {
          severity: 'error',
          code: 'INVALID_SETTINGS',
          message: 'Invalid language code',
          nodeId: 'keep',
          settingPath: 'languages.1',
        },
        {
          severity: 'error',
          code: 'INVALID_SETTINGS',
          message: 'Unrecognized key: "extra"',
          nodeId: 'keep',
        },
      ]),
    );
    const field = document.querySelector('[data-field="languages"]') as HTMLElement;
    expect(within(field).getByText('Invalid language code')).toBeTruthy();
    expect(screen.getByText('Unrecognized key: "extra"')).toBeTruthy();
  });

  it('renders the raw JSON editor when settings is null or an array, without throwing', () => {
    for (const settings of [null, [1, 2], 7] as JsonValue[]) {
      const message = 'Invalid input: expected object';
      const { lastGraph } = renderInspector(
        keepSelected(
          [{ severity: 'error', code: 'INVALID_SETTINGS', message, nodeId: 'keep' }],
          withNode({ id: 'keep', settings }),
        ),
      );
      const raw = screen.getByRole('textbox', { name: /raw/i }) as HTMLTextAreaElement;
      expect(JSON.parse(raw.value)).toEqual(settings);
      expect(screen.getAllByText(message)).toHaveLength(1);
      expect(screen.queryByRole('switch', { name: 'Keep the original language' })).toBeNull();
      fireEvent.change(raw, { target: { value: '{"languages":["de"]}' } });
      expect(nodeOf(lastGraph(), 'keep')?.settings).toEqual({ languages: ['de'] });
      cleanup();
    }
  });

  it('renders a raw editor for an unknown node type with the Unknown eyebrow', () => {
    renderInspector(
      keepSelected(
        [
          {
            severity: 'error',
            code: 'UNKNOWN_NODE_TYPE',
            message: 'Unknown node type plugin:gone',
            nodeId: 'keep',
          },
        ],
        withNode({ id: 'keep', type: 'plugin:gone', settings: { a: 1 } }),
      ),
    );
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'plugin:gone' })).toBeTruthy();
    const raw = screen.getByRole('textbox', { name: /raw/i }) as HTMLTextAreaElement;
    expect(JSON.parse(raw.value)).toEqual({ a: 1 });
    expect(screen.getByText('Plugin missing')).toBeTruthy();
    expect(screen.getByText('Unknown node type plugin:gone')).toBeTruthy();
  });

  it('focusField focuses the matching control once', () => {
    const state = keepSelected();
    const { rerender, onFocused, dispatch } = renderInspector(state, {
      focusField: 'keepUntagged',
    });
    const control = screen.getByRole('switch', { name: 'Keep tracks without a language tag' });
    expect(document.activeElement).toBe(control);
    expect(onFocused).toHaveBeenCalledTimes(1);

    // The page clears the request; later renders leave focus where the user put it.
    const name = screen.getByRole('textbox', { name: 'Name on the canvas' });
    name.focus();
    rerender(
      <Inspector
        state={{ ...state }}
        catalog={catalogFixture}
        dispatch={dispatch}
        readOnly={false}
        focusField={null}
        onFocused={onFocused}
        joinGroup={vi.fn()}
        groupSelection={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(name);
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it('"On the canvas" sets the label, toggles bypass and moves the node into a group', () => {
    const g = chainMainReplace();
    const grouped: WorkflowGraph = {
      ...g,
      groups: [
        {
          id: 'g1',
          name: 'Audio',
          collapsed: false,
          position: { x: 600, y: 300 },
          size: { width: 300, height: 200 },
        },
      ],
    };
    const { lastGraph, dispatch, joinGroup } = renderInspector(keepSelected([], grouped));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name on the canvas' }), {
      target: { value: 'Keep German' },
    });
    expect(nodeOf(lastGraph(), 'keep')?.label).toBe('Keep German');
    expect(dispatch.mock.calls.at(-1)?.[1]).toEqual({ coalesce: 'settings', key: 'label:keep' });

    fireEvent.click(screen.getByRole('switch', { name: 'Bypass' }));
    expect(nodeOf(lastGraph(), 'keep')?.bypassed).toBe(true);

    // The page joins the group with the card's measured size (graph-ops joinGroup).
    fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), { target: { value: 'g1' } });
    expect(joinGroup).toHaveBeenCalledWith('keep', 'g1');
  });

  it('clearing the name on the canvas removes the label', () => {
    const { lastGraph } = renderInspector(
      keepSelected([], withNode({ id: 'keep', label: 'Mine' })),
    );
    const name = screen.getByRole('textbox', { name: 'Name on the canvas' }) as HTMLInputElement;
    expect(name.value).toBe('Mine');
    // "optional" is part of the field's description.
    const described = (name.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.map((id) => document.getElementById(id)?.textContent)).toContain('optional');
    fireEvent.change(name, { target: { value: '' } });
    const node = nodeOf(lastGraph(), 'keep');
    expect(node && 'label' in node).toBe(false);
  });

  it('client check first: a missing required URL reads "Required" and the state line "Needs a setting"', () => {
    const graph = withNode({ id: 'keep', type: 'core:notify-webhook', settings: {} });
    renderInspector(
      keepSelected(
        [
          {
            severity: 'error',
            code: 'INVALID_SETTINGS',
            message: 'Needs a setting',
            nodeId: 'keep',
            settingPath: 'url',
          },
        ],
        graph,
      ),
    );
    const field = document.querySelector('[data-field="url"]') as HTMLElement;
    expect(within(field).getByText('Required')).toBeTruthy();
    expect(within(field).queryByText('Needs a setting')).toBeNull();
    const line = screen.getByRole('status');
    expect(line.textContent).toBe('Needs a setting');
    expect(line.classList).toContain('tone-amber');
  });

  it('the state line follows the client check before the server has answered', () => {
    // No issues from the server yet (a node just added): the form already knows.
    renderInspector(
      keepSelected([], withNode({ id: 'keep', type: 'core:notify-webhook', settings: {} })),
    );
    expect(screen.getByRole('status').textContent).toBe('Needs a setting');
  });

  it('a server message whose setting changed since validation is not shown', () => {
    const issue: Issue = {
      severity: 'error',
      code: 'INVALID_SETTINGS',
      message: 'Unknown language code',
      nodeId: 'keep',
      settingPath: 'languages',
    };
    const validated = keepSelected([issue]);
    // Same value as validated: the server's message shows (the client has none).
    renderInspector(validated);
    expect(screen.getByText('Unknown language code')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Check settings');
    cleanup();
    // The user picked another language; the issue describes the old value.
    const draft = withNode({
      id: 'keep',
      settings: { languages: ['de'], keepOriginal: true, keepUntagged: true },
    });
    renderInspector({ ...validated, draft });
    expect(screen.queryByText('Unknown language code')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('layout: fixed header, the body scrolls with the form and "On the canvas", footer pinned', () => {
    const { container } = renderInspector(keepSelected());
    const section = container.querySelector('.inspector') as HTMLElement;
    const parts = [...section.children].map((c) => c.className);
    expect(parts).toEqual(['inspector-head', 'inspector-body', 'inspector-footer']);
    const body = section.querySelector('.inspector-body') as HTMLElement;
    expect(within(body).getByRole('switch', { name: 'Keep the original language' })).toBeTruthy();
    expect(within(body).getByText('On the canvas')).toBeTruthy();
    const footer = section.querySelector('.inspector-footer') as HTMLElement;
    expect(within(footer).getByRole('button', { name: 'Remove node' })).toBeTruthy();
  });

  it('footer: Duplicate copies the node and Remove node removes it', () => {
    const { lastGraph } = renderInspector(keepSelected());
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(lastGraph().nodes.filter((n) => n.type === 'core:keep-languages')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove node' }));
    expect(nodeOf(lastGraph(), 'keep')).toBeUndefined();
  });

  it('NODE_OUTDATED is a note under the header; an unavailable node says why', () => {
    renderInspector(
      keepSelected([
        {
          severity: 'warning',
          code: 'NODE_OUTDATED',
          message: 'Keep languages v1 is outdated (v2 is installed)',
          nodeId: 'keep',
        },
      ]),
    );
    expect(
      screen.getByText(
        'Keep languages v1 is outdated (v2 is installed) — updated on the next server start',
      ),
    ).toBeTruthy();
    cleanup();

    renderInspector(
      keepSelected(
        [
          {
            severity: 'error',
            code: 'NODE_UNAVAILABLE',
            message: 'Generate subtitles is not available',
            nodeId: 'keep',
          },
        ],
        withNode({ id: 'keep', type: 'test:unavailable', settings: {} }),
      ),
    );
    expect(document.querySelector('.eyebrow-kind')?.textContent).toBe(
      'Action · plugin whisper 0.1.0',
    );
    expect(screen.getByText('Not on this server: Needs the Whisper plugin')).toBeTruthy();
    expect(screen.queryByText('Generate subtitles is not available')).toBeNull();
  });

  it('a node of a plugin that is not running says so, with the reason, in the state line', () => {
    renderInspector(
      keepSelected(
        [
          {
            severity: 'error',
            code: 'PLUGIN_UNAVAILABLE',
            message:
              "Keep languages can't run: plugin example not running (stopped: exited with code 3)",
            nodeId: 'keep',
          },
        ],
        withNode({ id: 'keep', type: 'test:unavailable', settings: {} }),
      ),
    );
    const line = document.querySelector('.inspector-state');
    expect(line?.textContent).toBe(
      'Plugin not running: plugin example not running (stopped: exited with code 3)',
    );
    expect(line?.classList).toContain('tone-red');
  });

  it('with nothing selected it shows the workflow itself: type, version and node count', () => {
    const g = chainMainReplace();
    renderInspector(stateOf(g, { nodes: [], edges: [] }));
    const region = screen.getByRole('region', { name: 'Selection' });
    const facts = [...region.querySelectorAll('.inspector-facts > div')].map((d) => d.textContent);
    expect(facts).toEqual(['TypeWorkflow', 'Saved versionv3', `Nodes${g.nodes.length}`]);
    expect(within(region).getByText('Select a node')).toBeTruthy();
  });

  it('empty, group and multi-node selections', () => {
    const g = chainMainReplace();
    const grouped: WorkflowGraph = {
      ...g,
      groups: [
        {
          id: 'g1',
          name: 'Audio',
          collapsed: false,
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
        },
      ],
    };
    renderInspector(stateOf(grouped, { nodes: [], edges: [] }));
    expect(
      within(screen.getByRole('region', { name: 'Selection' })).getByText('Select a node'),
    ).toBeTruthy();
    cleanup();
    renderInspector(stateOf(grouped, { nodes: [], edges: [], group: 'g1' }));
    expect(
      within(screen.getByRole('region', { name: 'Audio' })).getByRole('textbox', {
        name: 'Group name',
      }),
    ).toBeTruthy();
    cleanup();
    const { lastGraph, groupSelection } = renderInspector(
      stateOf(grouped, { nodes: ['keep', 'ro'], edges: [] }),
    );
    expect(
      within(screen.getByRole('region', { name: 'Selection' })).getByText('2 nodes selected'),
    ).toBeTruthy();
    // Grouping is offered here too, not only on the canvas toolbar (final review M16).
    fireEvent.click(screen.getByRole('button', { name: 'Group 2 nodes' }));
    expect(groupSelection).toHaveBeenCalledWith('Group');
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 nodes' }));
    expect(lastGraph().nodes.map((n) => n.id)).toEqual(['in']);
  });

  it('read-only: every control is disabled and nothing is dispatched', () => {
    const { dispatch } = renderInspector(keepSelected(), { readOnly: true });
    const sw = screen.getByRole('switch', { name: 'Keep the original language' });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Bypass' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('textbox', { name: 'Name on the canvas' }) as HTMLInputElement).readOnly,
    ).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Group' }) as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Remove node' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(sw);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('the "On the canvas" section remembers being closed', () => {
    renderInspector(keepSelected());
    fireEvent.click(screen.getByRole('button', { name: 'On the canvas' }));
    expect(localStorage.getItem('tc.inspector.on-the-canvas')).toBe('closed');
    expect(screen.queryByRole('textbox', { name: 'Name on the canvas' })).toBeNull();
    cleanup();
    renderInspector(keepSelected());
    const again = screen.getByRole('button', { name: 'On the canvas' });
    expect(again.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('headerIssues', () => {
  it('a Run node does not repeat what its inspector shows inline', () => {
    const on = (code: string, message: string, settingPath?: string): Issue =>
      ({
        severity: 'warning',
        code,
        message,
        nodeId: 'run',
        ...(settingPath ? { settingPath } : {}),
      }) as Issue;
    const issues = [
      on('SUBWORKFLOW_OUTDATED', 'Pins v1; the latest is 2'),
      on('OVERRIDE_DROPPED', 'Override keep.x will be dropped', 'overrides.keep.x'),
      on('INVALID_OVERRIDE', 'Bad override', 'overrides.keep.languages'),
      on('SUBWORKFLOW_MISSING', 'Sub-workflow s1 does not exist'),
      on('INPUT_UNCONNECTED', 'Input file is not connected'),
    ];
    const state = nodeStateFor('run', issues);
    expect(headerIssues(state, true).map((i) => i.code)).toEqual(['INPUT_UNCONNECTED']);
    // Any other node lists them all.
    expect(headerIssues(state, false)).toHaveLength(5);
  });
});

describe('NodeForm', () => {
  it('every core node except run-subworkflow renders without a raw-JSON fallback', () => {
    const coreDefs = nodesFixture.filter((d) => d.source.kind === 'core');
    expect(coreDefs.length).toBeGreaterThan(15);
    for (const def of coreDefs.filter((d) => d.type !== 'core:run-subworkflow')) {
      const instance: NodeInstance = {
        id: 'n',
        type: def.type,
        typeVersion: def.version,
        settings: defaultSettings(def.settingsSchema),
        position: { x: 0, y: 0 },
      };
      render(
        <NodeForm
          def={def}
          instance={instance}
          issues={new Map()}
          readOnly={false}
          onChange={() => {}}
          focusField={null}
        />,
      );
      expect(screen.queryByRole('textbox', { name: /raw/i })).toBeNull();
      cleanup();
    }
  });

  it('encode-video shows only the rate setting of the chosen rate control', () => {
    const def = catalogFixture.byType.get('core:encode-video');
    if (!def) throw new Error('fixture');
    const form = (settings: Record<string, JsonValue>, issues = new Map<string, Issue[]>()) =>
      render(
        <NodeForm
          def={def}
          instance={{
            id: 'n',
            type: def.type,
            typeVersion: def.version,
            settings,
            position: { x: 0, y: 0 },
          }}
          issues={issues}
          readOnly={false}
          onChange={() => {}}
          focusField={null}
        />,
      );
    form({ rateControl: 'quality', quality: 24, bitrateKbps: 6000 });
    expect(screen.getByLabelText('Quality (CRF)', { selector: 'input[type=number]' })).toBeTruthy();
    expect(screen.queryByLabelText('Target bitrate (kb/s)')).toBeNull();
    cleanup();
    form({ rateControl: 'bitrate' });
    expect(screen.getByLabelText('Target bitrate (kb/s)')).toBeTruthy();
    expect(screen.queryByLabelText('Quality (CRF)', { selector: 'input[type=number]' })).toBeNull();
    cleanup();
    // A hidden setting the server flags still shows, so its message has a place.
    const flagged = new Map<string, Issue[]>([
      [
        'quality',
        [
          {
            code: 'INVALID_SETTINGS',
            severity: 'error',
            nodeId: 'n',
            settingPath: 'quality',
            message: 'Too big',
          },
        ],
      ],
    ]);
    form({ rateControl: 'bitrate', quality: 30 }, flagged);
    expect(screen.getByText('Too big')).toBeTruthy();
  });

  it('a language setting on a node with a data:language input reads "Any language" when unset', () => {
    const def = catalogFixture.byType.get('core:has-stream');
    if (!def) throw new Error('fixture');
    render(
      <NodeForm
        def={def}
        instance={{
          id: 'n',
          type: def.type,
          typeVersion: def.version,
          settings: {},
          position: { x: 0, y: 0 },
        }}
        issues={new Map()}
        readOnly={false}
        onChange={() => {}}
        focusField={null}
      />,
    );
    expect(screen.getByText('Any language')).toBeTruthy();
  });
});

describe('NodeForm Advanced', () => {
  const video = nodesFixture.find((d) => d.type === 'core:encode-video');
  if (!video) throw new Error('no encode-video in the fixture');
  const encodeVideo = (settings: Record<string, JsonValue>): NodeInstance => ({
    id: 'enc',
    type: video.type,
    typeVersion: video.version,
    settings: { ...defaultSettings(video.settingsSchema), ...settings },
    position: { x: 0, y: 0 },
  });
  const form = (
    instance: NodeInstance,
    opts: { issues?: Map<string, Issue[]>; focusField?: string | null } = {},
  ) => (
    <NodeForm
      def={video}
      instance={instance}
      issues={opts.issues ?? new Map()}
      readOnly={false}
      onChange={() => {}}
      focusField={opts.focusField ?? null}
    />
  );

  it('keeps the encoder, preset and bitrate cap behind a closed Advanced, after the main settings', () => {
    render(form(encodeVideo({})));
    expect(screen.getByText('Target codec')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('switch', { name: 'Never above the source bitrate' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Never above the source bitrate' })).toBeTruthy();
    // Inside the disclosure's region, in schema order.
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    const keys = [...(region?.querySelectorAll<HTMLElement>('[data-field]') ?? [])].map(
      (f) => f.dataset.field,
    );
    expect(keys).toEqual(['encoder', 'neverIncreaseBitrate', 'preset']);
  });

  it('says how many advanced settings are off their default while closed', () => {
    render(form(encodeVideo({ preset: 'slow', neverIncreaseBitrate: false, encoder: 'auto' })));
    expect(screen.getByRole('button', { name: /Advanced/ }).textContent).toContain('2 changed');
  });

  it('opens for a message inside it', () => {
    const issue = {
      severity: 'error',
      code: 'INVALID_SETTINGS',
      message: 'Unknown preset',
      nodeId: 'enc',
      settingPath: 'preset',
    } as Issue;
    render(form(encodeVideo({ preset: 'warp' }), { issues: new Map([['preset', [issue]]]) }));
    expect(screen.getByRole('button', { name: /Advanced/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByText('Unknown preset')).toBeTruthy();
  });

  it('opens and focuses a field asked for by setting path', () => {
    render(form(encodeVideo({}), { focusField: 'preset' }));
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Encoder preset' }));
  });

  it('a node without advanced settings has no Advanced', () => {
    renderInspector(keepSelected());
    expect(screen.queryByRole('button', { name: /Advanced/ })).toBeNull();
  });
});
