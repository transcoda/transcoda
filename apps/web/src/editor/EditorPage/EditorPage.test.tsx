import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowDetail } from '@transcoda/contract';
import type { Issue, WorkflowGraph } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodesFixture } from '../../testing/fixtures/catalog.ts';
import { chainMainReplace, otterFinchMain, otterFinchSub } from '../../testing/fixtures/graphs.ts';
import { transformOf } from '../../testing/transform.ts';
import { VALIDATE_DEBOUNCE_MS } from '../ui/use-validation.ts';

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
  conflictError,
  deferred,
  detail,
  flowNode,
  loadedEditor,
  menuItem,
  minutesAgo,
  NODE_KEYS,
  paletteButton,
  pill,
  renderEditor,
  saveOk,
  setupEditorPageMocks,
  stubNarrow,
  summary,
} from './testing.tsx';

setupEditorPageMocks(mocks);
afterEach(cleanup);

describe('EditorPage', () => {
  it('loads the workflow and renders its nodes and header', async () => {
    await loadedEditor();
    expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1' });
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumb.textContent).toBe('Workflows/Smoke');
    expect(within(crumb).getByRole('link', { name: 'Workflows' }).getAttribute('href')).toBe('/');
    expect(within(crumb).getByRole('button', { name: 'Smoke' })).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
    expect(screen.getByRole('group', { name: /Trigger Manual input/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Finish Replace original/ })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save v4' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const tryIt = screen.getByRole('button', { name: 'Dry run on a file' }) as HTMLButtonElement;
    expect(tryIt.disabled).toBe(false);
    // Nothing selected: the column is the issues list alone, the header says the version.
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(within(inspector).getByRole('region', { name: 'Issues' })).toBeTruthy();
  });

  it('adding a node from the palette marks the draft dirty and shows "v3 · unsaved changes"', async () => {
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    expect(screen.getAllByRole('group', { name: /Action Keep languages/ })).toHaveLength(2);
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    expect((screen.getByRole('button', { name: 'Save v4' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('a node added from the palette is selected: the inspector shows it, not the last one', async () => {
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'keep'));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    await within(inspector).findByRole('heading', { level: 2, name: 'Keep languages' });
    fireEvent.click(paletteButton('Action', 'Encode audio'));
    expect(
      await within(inspector).findByRole('heading', { level: 2, name: 'Encode audio' }),
    ).toBeTruthy();
  });

  it('a refused add from the palette is a toast', async () => {
    await loadedEditor();
    fireEvent.click(paletteButton('Trigger', 'Library input'));
    expect(await screen.findByText('A workflow has exactly one trigger')).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
  });

  it('validation issues become node badges', async () => {
    const known = new Set(chainMainReplace().nodes.map((n) => n.id));
    mocks.validate.mockImplementation(async ({ graph }: { graph: WorkflowGraph }) => {
      const added = graph.nodes.find((n) => !known.has(n.id));
      const issues: Issue[] = added
        ? [
            {
              severity: 'error',
              code: 'INPUT_UNCONNECTED',
              message: 'Input file is not connected',
              nodeId: added.id,
            },
          ]
        : [];
      return { issues, valid: issues.length === 0 };
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Remux'));
    // The validation debounce, without waiting for it in real time.
    await act(() => vi.advanceTimersByTimeAsync(VALIDATE_DEBOUNCE_MS));
    expect(await screen.findByText('needs a connection')).toBeTruthy();
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.validate.mock.calls[0]?.[0]).toMatchObject({ id: 'wf1' });
    expect(screen.getByRole('group', { name: /Action Remux, needs a connection/ })).toBeTruthy();
  });

  it('save sends exactly { id, baseVersion: 3, graph } with no extra graph keys and shows "Saved v4"', async () => {
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    expect(await screen.findByText('Saved v4')).toBeTruthy();

    const [arg] = mocks.save.mock.calls[0] ?? [];
    expect(Object.keys(arg).sort()).toEqual(['baseVersion', 'graph', 'id']);
    expect(arg.id).toBe('wf1');
    expect(arg.baseVersion).toBe(3);
    expect(Object.keys(arg.graph).sort()).toEqual([
      'edges',
      'formatVersion',
      'groups',
      'kind',
      'nodes',
    ]);
    expect(arg.graph.nodes).toHaveLength(4);
    for (const n of arg.graph.nodes) {
      expect(Object.keys(n).every((k) => NODE_KEYS.includes(k))).toBe(true);
    }
    await waitFor(() => expect(pill().textContent).toBe('v4 · Not active · saved just now'));
    expect((screen.getByRole('button', { name: 'Save v5' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('saving after Quality check was turned off removes the Damaged edge, says so, and undo restores it', async () => {
    const base = chainMainReplace();
    const graph: WorkflowGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: 'r',
          type: 'core:render',
          typeVersion: 1,
          settings: { qualityCheck: true },
          position: { x: 420, y: 0 },
        },
        {
          id: 'nw',
          type: 'core:notify-webhook',
          typeVersion: 1,
          settings: { url: 'https://hooks.example.com/damaged', method: 'POST' },
          position: { x: 560, y: 200 },
        },
      ],
      edges: [
        base.edges[0] as WorkflowGraph['edges'][number],
        { id: 'keep-r', from: { node: 'keep', port: 'file' }, to: { node: 'r', port: 'file' } },
        { id: 'r-ro', from: { node: 'r', port: 'done' }, to: { node: 'ro', port: 'file' } },
        { id: 'r-nw', from: { node: 'r', port: 'damaged' }, to: { node: 'nw', port: 'file' } },
      ],
    };
    mocks.get.mockResolvedValue(detail(graph));
    const { container } = await loadedEditor();
    const edge = () => container.querySelector('.react-flow__edge[data-id="r-nw"]');
    await waitFor(() => expect(edge()).not.toBeNull());
    fireEvent.click(flowNode(container, 'r'));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const sw = await within(inspector).findByRole('switch', { name: 'Quality check' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    // Until the save, the connection stays drawn.
    expect(edge()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    expect(await screen.findByText('Removed the connection from Damaged')).toBeTruthy();
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    const [arg] = mocks.save.mock.calls[0] ?? [];
    expect((arg.graph as WorkflowGraph).edges.map((e) => e.id)).toEqual([
      'in-keep',
      'keep-r',
      'r-ro',
    ]);
    await waitFor(() => expect(edge()).toBeNull());

    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await waitFor(() => expect(edge()).not.toBeNull());
    expect(pill().textContent).toBe('v4 · Not active · unsaved changes');
  });

  it('VERSION_CONFLICT opens the conflict dialog; "Save over it" re-saves with baseVersion = currentVersion', async () => {
    mocks.save
      .mockRejectedValueOnce(
        new ORPCError('VERSION_CONFLICT', {
          defined: true,
          status: 409,
          message: 'The workflow was changed since you loaded it',
          data: { currentVersion: 5 },
        }),
      )
      .mockResolvedValueOnce(saveOk(6));
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Someone saved v5 while you were editing',
    });
    expect(dialog.textContent).toContain(
      'Your changes are still here. Reload the latest version to drop them, or save over it as a new version — v5 stays in the history.',
    );
    expect(within(dialog).getByRole('button', { name: 'Reload the latest version' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save over it' }));

    expect(await screen.findByText('Saved v6')).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({ id: 'wf1', baseVersion: 5 });
    expect(mocks.save.mock.calls[1]?.[0].graph.nodes).toHaveLength(4);
    // The toast comes from the save itself; the dialog closes a microtask later.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('"Reload the latest version" drops the draft and loads the current version', async () => {
    mocks.save.mockRejectedValueOnce(
      new ORPCError('VERSION_CONFLICT', {
        defined: true,
        status: 409,
        data: { currentVersion: 5 },
      }),
    );
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    const dialog = await screen.findByRole('dialog');
    mocks.get.mockResolvedValueOnce(detail(chainMainReplace(), 5));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload the latest version' }));
    await waitFor(() => expect(pill().textContent).toMatch(/^v5 · Not active · saved/));
    // The canvas drops the draft's node a render after the pill changes.
    await waitFor(() =>
      expect(screen.getAllByRole('group', { name: /Action Keep languages/ })).toHaveLength(1),
    );
  });

  it('an undefined 413 error keeps the draft dirty and shows the 2 MB message with "Try again"', async () => {
    mocks.save
      .mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }))
      .mockResolvedValueOnce(saveOk(4));
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The workflow is too large to save (2 MB limit)');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    expect(screen.getAllByRole('group', { name: /Action Keep languages/ })).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Save v4' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({ baseVersion: 3 });
  });

  it('a refused connection shows a toast and changes nothing', async () => {
    // jsdom has no layout: React Flow's click-to-connect falls back to the clicked handle.
    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
    const { container } = await loadedEditor();
    const handle = (node: string, port: string, side: 'source' | 'target') =>
      container.querySelector(
        `.react-flow__handle.${side}[data-nodeid="${node}"][data-handleid="${port}"]`,
      ) as HTMLElement;
    fireEvent.click(handle('in', 'file', 'source'));
    fireEvent.click(handle('keep', 'language', 'target'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      "Those ports don't match (file → data:language)",
    );
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it('Enter on a node moves focus into its toolbar', async () => {
    const { container } = await loadedEditor();
    const node = container.querySelector('.react-flow__node[data-id="keep"]') as HTMLElement;
    node.focus();
    fireEvent.keyDown(node, { key: 'Enter' });
    const toolbar = await screen.findByRole('toolbar', { name: 'Node actions' });
    await waitFor(() => expect(toolbar.contains(document.activeElement)).toBe(true));
    // The first enabled action: "Try this node" since the engine can try one (Task 24).
    expect(document.activeElement?.textContent).toBe('Try this node');
  });

  it('collapsing a group is an edit; on a past version it is view-only', async () => {
    mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1)));
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse group Cleanup' }));
    expect(screen.getByRole('button', { name: 'Expand group Cleanup' })).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    cleanup();

    mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1), 2));
    renderEditor('/workflows/wf1?version=2');
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse group Cleanup' }));
    expect(screen.getByRole('button', { name: 'Expand group Cleanup' })).toBeTruthy();
    expect(mocks.get).toHaveBeenLastCalledWith({ id: 'wf1', version: 2 });
    expect(pill().textContent).toMatch(/^v2 · Not active · saved/);
    expect(screen.queryByRole('button', { name: /^Save v/ })).toBeNull();
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    const remux = within(palette).getByRole('button', { name: 'Remux' });
    expect(remux.getAttribute('aria-disabled')).toBe('true');
  });
  it('EditorPage with a failing nodes.list shows "Node catalog unavailable — reload", renders nodes as unknown and disables Save', async () => {
    mocks.nodesList.mockRejectedValue(new ORPCError('UNAUTHORIZED', { status: 401 }));
    renderEditor();
    const banner = await screen.findByText('Node catalog unavailable — reload');
    expect(banner.closest('[role="status"]')).toBeTruthy();
    expect(await screen.findByRole('group', { name: /^Unknown core:keep-languages/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Unknown core:input-manual/ })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save v4' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Node catalog unavailable');
    // Read-only: no toolbar, Delete does nothing, nothing is validated or saved.
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
    expect(mocks.validate).not.toHaveBeenCalled();

    mocks.nodesList.mockResolvedValue({ nodes: nodesFixture });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('group', { name: /Action Keep languages/ })).toBeTruthy();
    expect(screen.queryByText('Node catalog unavailable — reload')).toBeNull();
  });

  it('EditorPage below 1024 px is read-only with the notice', async () => {
    stubNarrow(true);
    await loadedEditor();
    const notice = screen.getByText(
      'The editor needs a wider window (1024 px). You can look, not edit.',
    );
    expect(notice.closest('[role="status"]')).toBeTruthy();
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    const remux = within(palette).getByRole('button', { name: 'Remux' });
    expect(remux.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('toolbar', { name: 'Node actions' })).toBeNull();
  });

  it('below 1024 px the header actions sit in an overflow menu', async () => {
    stubNarrow(true);
    await loadedEditor();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dry run on a file' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Dry run on a file' })).toBeTruthy();
  });

  it('below 1024 px the read-only inspector is a bottom sheet that appears with a selection and closes it', async () => {
    stubNarrow(true);
    const { container } = await loadedEditor();
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    fireEvent.click(flowNode(container, 'keep'));
    const sheet = await screen.findByRole('complementary', { name: 'Inspector' });
    expect(sheet.classList.contains('is-sheet')).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('at desktop width the inspector column is always there, with no sheet or close button', async () => {
    await loadedEditor();
    const col = screen.getByRole('complementary', { name: 'Inspector' });
    expect(col.classList.contains('is-sheet')).toBe(false);
    expect(within(col).queryByRole('button', { name: 'Close inspector' })).toBeNull();
  });

  it('viewport is restored from localStorage when present', async () => {
    localStorage.setItem('tc.viewport.wf1', JSON.stringify({ x: 12, y: 34, zoom: 0.5 }));
    const { container } = await loadedEditor();
    const viewport = container.querySelector('.react-flow__viewport') as HTMLElement;
    expect(transformOf(viewport)).toEqual({ x: 12, y: 34, scale: 0.5 });
  });

  it('a stored viewport that is not {x,y,zoom} is ignored', async () => {
    localStorage.setItem('tc.viewport.wf1', '{"x":"a"}');
    const { container } = await loadedEditor();
    const viewport = container.querySelector('.react-flow__viewport') as HTMLElement;
    expect(viewport.style.transform).not.toContain('scale(0.5)');
  });

  it('EditorPage with ?focus=palette focuses the palette search', async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await loadedEditor('/workflows/wf1?focus=palette');
      const palette = screen.getByRole('complementary', { name: 'Node palette' });
      const search = within(palette).getByRole('searchbox', { name: 'Search nodes' });
      await waitFor(() => expect(document.activeElement).toBe(search));
      expect(scrolled).toEqual([within(palette).getByRole('group', { name: 'Trigger' })]);
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('without ?focus=palette the palette search is not focused', async () => {
    await loadedEditor();
    const search = screen.getByRole('searchbox', { name: 'Search nodes' });
    expect(document.activeElement).not.toBe(search);
  });

  it('the key explains the two line styles, and lists the five keys on an editable canvas', async () => {
    await loadedEditor();
    const key = screen.getByText('Key').closest('details') as HTMLElement;
    for (const text of ['data', 'leads to a broken node', 'next node', 'node actions', 'connect']) {
      expect(within(key).getAllByText(text).length).toBeGreaterThan(0);
    }
    expect([...key.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Tab',
      'Enter',
      'C',
      'Del',
      '/',
    ]);
  });

  it('below 1024 px the key leaves out the keyboard shortcuts (nothing there can be edited)', async () => {
    stubNarrow(true);
    await loadedEditor();
    const key = screen.getByText('Key').closest('details') as HTMLElement;
    expect(within(key).getByText('leads to a broken node')).toBeTruthy();
    expect(key.querySelectorAll('kbd')).toHaveLength(0);
    expect(within(key).queryByText('Keys')).toBeNull();
  });

  it('keyboard: Tab selects the next node, Delete removes it, Mod+Z brings it back, "/" opens the search', async () => {
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'in'));
    await waitFor(() => expect(flowNode(container, 'in').classList).toContain('selected'));
    flowNode(container, 'in').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
    await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
    expect(flowNode(container, 'in').classList).not.toContain('selected');
    expect(document.activeElement).toBe(flowNode(container, 'keep'));

    fireEvent.keyDown(document.activeElement as Element, { key: 'Delete' });
    await waitFor(() => expect(flowNode(container, 'keep')).toBeNull());
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(await screen.findByRole('group', { name: /Action Keep languages/ })).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');

    fireEvent.keyDown(document.body, { key: '/' });
    expect(await screen.findByRole('dialog', { name: 'Add a node' })).toBeTruthy();
  });

  it('"c" opens the search filtered to the selected node\'s free output', async () => {
    mocks.get.mockResolvedValue(
      detail({ ...chainMainReplace(), edges: chainMainReplace().edges.slice(0, 1) }),
    );
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'keep'));
    await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
    fireEvent.keyDown(flowNode(container, 'keep'), { key: 'c' });
    expect(
      await screen.findByRole('dialog', { name: /^Add the next node · \d+ matches$/ }),
    ).toBeTruthy();
  });

  it('"+" on Replace original lists only later finish steps and says why', async () => {
    const { container } = await loadedEditor();
    fireEvent.click(
      within(flowNode(container, 'ro')).getByRole('button', { name: 'Connect from File' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: /^Add the next node · \d+ matches$/,
    });
    expect(within(dialog).queryByRole('option', { name: 'Video is' })).toBeNull();
    expect(within(dialog).queryByRole('option', { name: 'Encode video' })).toBeNull();
    expect(within(dialog).getByRole('option', { name: 'Notify webhook' })).toBeTruthy();
    expect(
      within(dialog).getByText('After Replace original, only later finish steps are listed'),
    ).toBeTruthy();
  });

  it('Escape in the node toolbar returns focus to the node and keeps it selected', async () => {
    const { container } = await loadedEditor();
    const node = flowNode(container, 'keep');
    fireEvent.click(node);
    await waitFor(() => expect(node.classList).toContain('selected'));
    node.focus();
    // Default prevented: the key press must not also activate the button that takes focus.
    expect(fireEvent.keyDown(node, { key: 'Enter' })).toBe(false);
    const toolbar = await screen.findByRole('toolbar', { name: 'Node actions' });
    await waitFor(() => expect(toolbar.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(document.activeElement).toBe(flowNode(container, 'keep'));
    expect(flowNode(container, 'keep').classList).toContain('selected');
  });

  it('the issues panel and the canvas banner show the validation result; an entry selects its node', async () => {
    mocks.get.mockResolvedValue({
      ...detail(),
      issues: [
        {
          severity: 'error',
          code: 'INPUT_UNCONNECTED',
          message: 'Input file is not connected',
          nodeId: 'ro',
        },
        { severity: 'warning', code: 'NODE_UNREACHABLE', message: 'Never reached', nodeId: 'ro' },
      ],
    });
    const { container } = await loadedEditor();
    expect(
      screen.getByText(
        "Can't activate: Replace original: Input file is not connected. Dry runs still work.",
      ),
    ).toBeTruthy();
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(inspector.querySelector('summary')?.textContent).toBe('1 error · 1 warning');
    fireEvent.click(within(inspector).getByRole('button', { name: /Never reached/ }));
    await waitFor(() => expect(flowNode(container, 'ro').classList).toContain('selected'));
  });

  it('EditorPage: clicking an issues-panel entry with settingPath selects the node and focuses the field', async () => {
    mocks.get.mockResolvedValue({
      ...detail(),
      issues: [
        {
          severity: 'error',
          code: 'INVALID_SETTINGS',
          message: 'Expected boolean',
          nodeId: 'keep',
          settingPath: 'keepUntagged',
        },
      ],
    });
    const { container } = await loadedEditor();
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).queryByRole('region', { name: 'Selection' })).toBeNull();
    fireEvent.click(within(inspector).getByRole('button', { name: /Expected boolean/ }));
    await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
    expect(
      within(inspector).getByRole('heading', { level: 2, name: 'Keep languages' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(inspector).getByRole('switch', { name: 'Keep tracks without a language tag' }),
      ),
    );
    // The field shows the server's message; editing it is an edit of the draft.
    const field = inspector.querySelector('[data-field="keepUntagged"]') as HTMLElement;
    expect(within(field).getByText('Expected boolean')).toBeTruthy();
    fireEvent.click(within(field).getByRole('switch'));
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
  });

  it("the inspector's Group select joins the group and grows the box around the measured card", async () => {
    mocks.get.mockResolvedValue(
      detail({
        ...chainMainReplace(),
        groups: [
          {
            id: 'g1',
            name: 'Audio',
            collapsed: false,
            position: { x: 600, y: 300 },
            size: { width: 300, height: 200 },
          },
        ],
      }),
    );
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'keep'));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    await within(inspector).findByRole('heading', { level: 2, name: 'Keep languages' });
    fireEvent.click(within(inspector).getByRole('button', { name: 'Group None' }));
    fireEvent.click(within(inspector).getByRole('option', { name: 'Audio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const graph = mocks.save.mock.calls[0]?.[0].graph as WorkflowGraph;
    expect(graph.nodes.find((n) => n.id === 'keep')?.groupId).toBe('g1');
    // keep at (280, 0) measured 210 × 120 (jsdom stub) + 24 padding, joined with the old box.
    expect(graph.groups[0]).toMatchObject({
      position: { x: 256, y: -24 },
      size: { width: 644, height: 524 },
    });
  });

  it('the inspector edits the selected node; "Remove node" deletes it', async () => {
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'keep'));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    await within(inspector).findByRole('heading', { level: 2, name: 'Keep languages' });
    fireEvent.change(within(inspector).getByRole('textbox', { name: 'Name on the canvas' }), {
      target: { value: 'Keep German' },
    });
    expect(await screen.findByRole('group', { name: /Action Keep German/ })).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Remove node' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /Action Keep German/ })).toBeNull(),
    );
    expect(within(inspector).queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  describe('fix round (Task 10 review)', () => {
    it('"Reload the latest version" stays open and busy, shows a failure inline and retries', async () => {
      mocks.save.mockRejectedValueOnce(conflictError(5));
      await loadedEditor();
      fireEvent.click(paletteButton('Action', 'Keep languages'));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      const dialog = await screen.findByRole('dialog');

      const first = deferred<WorkflowDetail>();
      mocks.get.mockReturnValueOnce(first.promise);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reload the latest version' }));
      const reload = within(dialog).getByRole('button', { name: 'Reload the latest version' });
      expect((reload as HTMLButtonElement).disabled).toBe(true);
      expect(reload.getAttribute('aria-busy')).toBe('true');
      expect(within(dialog).getByRole('status').textContent).toBe('Loading the latest version…');

      first.reject(new TypeError('Failed to fetch'));
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain('Could not reach the server');
      // The draft is untouched while the dialog waits.
      expect(screen.getAllByRole('group', { name: /Action Keep languages/ })).toHaveLength(2);

      mocks.get.mockResolvedValueOnce(detail(chainMainReplace(), 5));
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(pill().textContent).toMatch(/^v5 · Not active · saved/);
      expect(screen.getAllByRole('group', { name: /Action Keep languages/ })).toHaveLength(1);
    });

    it('a failed "Save over it" shows the error inside the dialog and "Try again" saves over', async () => {
      mocks.save
        .mockRejectedValueOnce(conflictError(5))
        .mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }))
        .mockResolvedValueOnce(saveOk(6));
      await loadedEditor();
      fireEvent.click(paletteButton('Action', 'Keep languages'));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save over it' }));

      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain('The workflow is too large to save (2 MB limit)');
      expect(screen.queryByText('Saved v6')).toBeNull();
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Saved v6')).toBeTruthy();
      expect(mocks.save.mock.calls[2]?.[0]).toMatchObject({ baseVersion: 5 });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('an edit made during an in-flight save stays dirty', async () => {
      const pending = deferred<ReturnType<typeof saveOk>>();
      mocks.save.mockReturnValueOnce(pending.promise);
      await loadedEditor();
      fireEvent.click(paletteButton('Action', 'Keep languages'));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      fireEvent.click(paletteButton('Action', 'Remux'));
      pending.resolve(saveOk(4));
      expect(await screen.findByText('Saved v4')).toBeTruthy();
      expect(pill().textContent).toBe('v4 · Not active · unsaved changes');
      expect((screen.getByRole('button', { name: 'Save v5' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(mocks.save.mock.calls[0]?.[0].graph.nodes).toHaveLength(4);
    });

    it('a stale "Try again" does not save a clean draft', async () => {
      mocks.save
        .mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }))
        .mockResolvedValueOnce(saveOk(4));
      await loadedEditor();
      fireEvent.click(paletteButton('Action', 'Keep languages'));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      const alert = await screen.findByRole('alert');
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      expect(await screen.findByText('Saved v4')).toBeTruthy();
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      // Nothing waits on a timer here: flushing the pending promises is enough.
      await act(async () => {});
      expect(mocks.save).toHaveBeenCalledTimes(2);
    });

    it('a rename does not make the pill claim "saved just now"', async () => {
      mocks.rename.mockResolvedValue({ ...summary, name: 'Smoke 2', updatedAt: minutesAgo(0) });
      await loadedEditor();
      const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
      fireEvent.click(within(crumb).getByRole('button', { name: 'Smoke' }));
      const input = within(crumb).getByRole('textbox');
      fireEvent.change(input, { target: { value: 'Smoke 2' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(await within(crumb).findByRole('button', { name: 'Smoke 2' })).toBeTruthy();
      expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
    });

    it('deleting a selected group keeps its members', async () => {
      mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1)));
      const { container } = renderEditor();
      await screen.findByRole('group', { name: 'Group Cleanup' });
      fireEvent.click(flowNode(container, 'cleanup'));
      await waitFor(() => expect(flowNode(container, 'cleanup').classList).toContain('selected'));
      fireEvent.keyDown(document.body, { key: 'Delete' });
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Group Cleanup' })).toBeNull(),
      );
      expect(flowNode(container, 'run-a')).toBeTruthy();
      expect(flowNode(container, 'run-b')).toBeTruthy();
      expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    });

    it('Delete removes a selected edge; a mixed selection is one undo step; redo removes it again', async () => {
      mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1)));
      const { container } = renderEditor();
      await screen.findByRole('group', { name: 'Group Cleanup' });
      const edge = (id: string) =>
        container.querySelector(`.react-flow__edge[data-id="${id}"]`) as Element | null;
      await waitFor(() => expect(edge('in-vi')).toBeTruthy());

      fireEvent.click(edge('in-vi') as Element);
      await waitFor(() => expect(edge('in-vi')?.classList).toContain('selected'));
      fireEvent.keyDown(document.body, { key: 'Delete' });
      await waitFor(() => expect(edge('in-vi')).toBeNull());
      expect(flowNode(container, 'in')).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
      await waitFor(() => expect(edge('in-vi')).toBeTruthy());
      expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');

      // Group + a node outside it + an unrelated edge, selected together.
      fireEvent.click(flowNode(container, 'cleanup'));
      await waitFor(() => expect(flowNode(container, 'cleanup').classList).toContain('selected'));
      // React Flow's multi-select key: Meta on macOS user agents, Control elsewhere.
      const multi = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';
      // Earlier key presses had no keyup in jsdom; React Flow forgets held keys on window blur.
      fireEvent.blur(window);
      fireEvent.keyDown(window, { key: multi });
      fireEvent.click(flowNode(container, 'ev'));
      fireEvent.click(edge('sg-ro-a') as Element);
      fireEvent.keyUp(window, { key: multi });
      await waitFor(() => {
        expect(flowNode(container, 'ev').classList).toContain('selected');
        expect(edge('sg-ro-a')?.classList).toContain('selected');
        expect(flowNode(container, 'cleanup').classList).toContain('selected');
      });

      fireEvent.keyDown(document.body, { key: 'Backspace' });
      await waitFor(() => expect(flowNode(container, 'ev')).toBeNull());
      expect(screen.queryByRole('group', { name: 'Group Cleanup' })).toBeNull();
      expect(edge('sg-ro-a')).toBeNull();
      expect(flowNode(container, 'run-a')).toBeTruthy();

      // One undo brings all three back.
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(flowNode(container, 'ev')).toBeTruthy());
      expect(screen.getByRole('group', { name: 'Group Cleanup' })).toBeTruthy();
      expect(edge('sg-ro-a')).toBeTruthy();
      expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');

      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(flowNode(container, 'ev')).toBeNull());
      expect(screen.queryByRole('group', { name: 'Group Cleanup' })).toBeNull();
      expect(edge('sg-ro-a')).toBeNull();
      expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    });

    it('deleting the Start of a sub-workflow is refused with a toast and the node stays', async () => {
      mocks.get.mockResolvedValue({
        ...detail(otterFinchSub()),
        kind: 'subworkflow',
      });
      const { container } = renderEditor();
      await screen.findByRole('group', { name: /Action Keep languages/ });
      fireEvent.click(flowNode(container, 'start'));
      await waitFor(() => expect(flowNode(container, 'start').classList).toContain('selected'));
      fireEvent.keyDown(document.body, { key: 'Delete' });
      expect((await screen.findByRole('alert')).textContent).toContain(
        'A sub-workflow needs its start and end',
      );
      expect(flowNode(container, 'start')).toBeTruthy();
      expect(pill().textContent).toBe('v3 · saved 2 min ago');
    });

    it('selecting a node after an edge merges the two selection reports by kind', async () => {
      const { container } = await loadedEditor();
      const edge = () => container.querySelector('.react-flow__edge[data-id="in-keep"]') as Element;
      await waitFor(() => expect(edge()).toBeTruthy());
      fireEvent.click(edge());
      await waitFor(() => expect(edge().classList).toContain('selected'));
      fireEvent.click(flowNode(container, 'keep'));
      // React Flow reports "node selected" and "edge unselected" separately; both must land.
      await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
      expect(edge().classList).not.toContain('selected');
    });
  });
  it('a redacted webhook URL round-trips unchanged on save and is replaced only when typed over', async () => {
    const REDACTED = 'https://hooks.example.test/…';
    const graph = chainMainReplace();
    graph.nodes = graph.nodes.filter((n) => n.id !== 'ro');
    graph.nodes.push({
      id: 'hook',
      type: 'core:notify-webhook',
      typeVersion: 1,
      settings: { url: REDACTED, method: 'POST' },
      position: { x: 560, y: 0 },
    });
    graph.edges = [
      graph.edges[0] as WorkflowGraph['edges'][number],
      { id: 'keep-hook', from: { node: 'keep', port: 'file' }, to: { node: 'hook', port: 'file' } },
    ];
    mocks.get.mockResolvedValue(detail(graph));
    mocks.save.mockResolvedValueOnce(saveOk(4)).mockResolvedValueOnce(saveOk(5));
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'hook'));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const url = await within(inspector).findByLabelText('URL');
    expect(url).toHaveProperty('value', '');
    expect(url.getAttribute('placeholder')).toBe(`Saved (${REDACTED}); type to replace`);

    // Another edit: the stored URL travels back in its redacted form (the server keeps it).
    fireEvent.change(within(inspector).getByRole('textbox', { name: 'Name on the canvas' }), {
      target: { value: 'Tell the NAS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    const first = mocks.save.mock.calls[0]?.[0] as { graph: WorkflowGraph };
    expect(first.graph.nodes.find((n) => n.id === 'hook')?.settings).toEqual({
      url: REDACTED,
      method: 'POST',
    });

    // Typing a new URL sends it.
    fireEvent.change(within(inspector).getByLabelText('URL'), {
      target: { value: 'https://hooks.example.test/t0k3n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save v5' }));
    expect(await screen.findByText('Saved v5')).toBeTruthy();
    const second = mocks.save.mock.calls[1]?.[0] as { graph: WorkflowGraph };
    expect(second.graph.nodes.find((n) => n.id === 'hook')?.settings).toEqual({
      url: 'https://hooks.example.test/t0k3n',
      method: 'POST',
    });
  });

  describe('versions (Task 18)', () => {
    const notFound = () => new ORPCError('NOT_FOUND', { defined: true, status: 404 });

    it('saves with note "Layout only" when only positions changed, no note for a settings change, and the user note when given', async () => {
      // jsdom cannot drag a node; collapsing a group is the same kind of layout-only change.
      mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1)));
      mocks.save
        .mockResolvedValueOnce(saveOk(4))
        .mockResolvedValueOnce(saveOk(5))
        .mockResolvedValueOnce(saveOk(6));
      renderEditor();
      fireEvent.click(await screen.findByRole('button', { name: 'Collapse group Cleanup' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      expect(await screen.findByText('Saved v4')).toBeTruthy();
      expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ baseVersion: 3, note: 'Layout only' });

      fireEvent.click(paletteButton('Action', 'Remux'));
      fireEvent.click(screen.getByRole('button', { name: 'Save v5' }));
      expect(await screen.findByText('Saved v5')).toBeTruthy();
      expect(Object.keys(mocks.save.mock.calls[1]?.[0]).sort()).toEqual([
        'baseVersion',
        'graph',
        'id',
      ]);

      fireEvent.click(paletteButton('Action', 'Remux'));
      fireEvent.click(menuItem('Save with a note…') as HTMLElement);
      const dialog = screen.getByRole('dialog', { name: 'Save with a note' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note' }), {
        target: { value: '  Second remux ' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save v6' }));
      expect(await screen.findByText('Saved v6')).toBeTruthy();
      expect(mocks.save.mock.calls[2]?.[0]).toMatchObject({ baseVersion: 5, note: 'Second remux' });
    });

    it("the pill shows the loaded version's own time and opens the versions panel", async () => {
      mocks.versions.mockResolvedValue({
        versions: [
          { version: 3, note: 'Layout only', createdBy: 'u1', createdAt: minutesAgo(5) },
          { version: 2, note: null, createdBy: 'u1', createdAt: minutesAgo(60) },
        ],
      });
      await loadedEditor();
      await waitFor(() => expect(pill().textContent).toBe('v3 · Not active · saved 5 min ago'));
      fireEvent.click(pill());
      const panel = screen.getByRole('dialog', { name: 'Versions' });
      const v2 = await within(panel).findByRole('link', { name: /^v2 · / });
      expect(v2.getAttribute('href')).toBe('/workflows/wf1?version=2');
      expect(
        within(panel)
          .getByRole('link', { name: /^v3 · Layout only/ })
          .getAttribute('aria-current'),
      ).toBe('page');
    });

    it('?version=3 loads that version read-only with "Viewing v3 — current is v7" and disabled editing', async () => {
      mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 3), currentVersion: 7 });
      await loadedEditor('/workflows/wf1?version=3');
      expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1', version: 3 });
      const banner = screen.getByText('Viewing v3 — current is v7');
      expect(banner.closest('[role="status"]')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Restore as new version' })).toBeTruthy();
      expect(paletteButton('Action', 'Remux').getAttribute('aria-disabled')).toBe('true');
      // A past version is not saved from (final review M9): no Save button at all.
      expect(screen.queryByRole('button', { name: /^Save v/ })).toBeNull();
      expect(menuItem('Save with a note…')).toBeNull();
      fireEvent.keyDown(document.body, { key: '/' });
      expect(screen.queryByRole('dialog', { name: 'Add a node' })).toBeNull();
      expect(screen.queryByRole('toolbar', { name: 'Node actions' })).toBeNull();
      expect(mocks.validate).not.toHaveBeenCalled();
    });

    it('"Restore as new version" saves that graph with baseVersion = current and navigates to the current route', async () => {
      const old = chainMainReplace();
      mocks.get.mockResolvedValue({ ...detail(old, 3), currentVersion: 7 });
      mocks.save.mockResolvedValue(saveOk(8));
      const view = await loadedEditor('/workflows/wf1?version=3');
      mocks.get.mockResolvedValue({ ...detail(old, 8), currentVersion: 8 });
      fireEvent.click(screen.getByRole('button', { name: 'Restore as new version' }));
      expect(await screen.findByText('Restored v3 as v8')).toBeTruthy();
      expect(mocks.save).toHaveBeenCalledWith({
        id: 'wf1',
        baseVersion: 7,
        graph: old,
        note: 'Restored from v3',
        restoredFrom: 3,
      });
      expect(view.location()).toBe('/workflows/wf1');
      await waitFor(() => expect(mocks.get).toHaveBeenLastCalledWith({ id: 'wf1' }));
      expect(await screen.findByRole('button', { name: /^v8 · / })).toBeTruthy();
      expect(screen.queryByText(/^Viewing v3/)).toBeNull();
    });

    it('a restore answered VERSION_CONFLICT opens the conflict dialog worded for a restore; "Restore over it" restores on top of the newer version', async () => {
      mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 3), currentVersion: 7 });
      mocks.save.mockRejectedValueOnce(conflictError(8)).mockResolvedValueOnce(saveOk(9));
      const view = await loadedEditor('/workflows/wf1?version=3');
      fireEvent.click(screen.getByRole('button', { name: 'Restore as new version' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Someone saved v8 while you were editing',
      });
      // Final review M9: a restore has no unsaved changes to keep.
      expect(dialog.textContent).toContain(
        'Someone saved v8 since you opened v3. Restore v3 on top of it as a new version, or open the latest version.',
      );
      expect(dialog.textContent).not.toContain('Your changes are still here');
      expect(within(dialog).getByRole('button', { name: 'Open the latest version' })).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restore over it' }));
      expect(await screen.findByText('Restored v3 as v9')).toBeTruthy();
      expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({
        baseVersion: 8,
        note: 'Restored from v3',
      });
      expect(view.location()).toBe('/workflows/wf1');
    });

    it('"Save over it" after a layout-only edit sends no automatic note (final review I2)', async () => {
      mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1)));
      mocks.save.mockRejectedValueOnce(conflictError(5)).mockResolvedValueOnce(saveOk(6));
      renderEditor();
      fireEvent.click(await screen.findByRole('button', { name: 'Collapse group Cleanup' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Someone saved v5 while you were editing',
      });
      expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ note: 'Layout only' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save over it' }));
      expect(await screen.findByText('Saved v6')).toBeTruthy();
      expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({ baseVersion: 5 });
      expect(mocks.save.mock.calls[1]?.[0]).not.toHaveProperty('note');
    });

    it('HIDDEN_URL_UNKNOWN on a save shows inline which node needs its URL again; the draft stays (final review I4)', async () => {
      mocks.save.mockRejectedValueOnce(
        new ORPCError('HIDDEN_URL_UNKNOWN', {
          defined: true,
          status: 400,
          message: 'A hidden webhook URL could not be matched to a saved one. Enter the URL again.',
          data: { nodeIds: ['keep'] },
        }),
      );
      const { container } = await loadedEditor();
      fireEvent.click(paletteButton('Action', 'Remux'));
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(
        'A hidden webhook URL could not be matched to a saved one. Enter the URL again in Keep languages.',
      );
      expect(alert.closest('.canvas-banners')).toBeTruthy();
      expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
      fireEvent.click(within(alert).getByRole('button', { name: 'Show Keep languages' }));
      await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
      // The next successful save clears it.
      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      expect(await screen.findByText('Saved v4')).toBeTruthy();
      expect(screen.queryByText(/could not be matched/)).toBeNull();
    });

    it("opening the versions panel reuses the page's versions list (one fetch; final review M10)", async () => {
      await loadedEditor();
      await waitFor(() => expect(mocks.versions).toHaveBeenCalledTimes(1));
      fireEvent.click(pill());
      const panel = screen.getByRole('dialog', { name: 'Versions' });
      expect(await within(panel).findByRole('link', { name: /^v3 · / })).toBeTruthy();
      expect(mocks.versions).toHaveBeenCalledTimes(1);
    });

    it('an unknown ?version shows "Version 9 doesn\'t exist" with a link to the current version', async () => {
      mocks.get.mockRejectedValue(notFound());
      renderEditor('/workflows/wf1?version=9');
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe("Version 9 doesn't exist");
      const link = screen.getByRole('link', { name: 'Open the current version' });
      expect(link.getAttribute('href')).toBe('/workflows/wf1');
    });
  });
});
