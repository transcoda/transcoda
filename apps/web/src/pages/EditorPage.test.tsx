import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import type { Issue, WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';
import { VALIDATE_DEBOUNCE_MS } from '../editor/ui/useValidation.ts';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import { chainMainReplace, tiggerPoohMain, tiggerPoohSub } from '../test/fixtures/graphs.ts';
import { renderAt } from '../test/render.tsx';

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
vi.mock('../api/client.ts', async () => {
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

import { EditorPage } from './EditorPage.tsx';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

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
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(2),
};

function detail(graph: WorkflowGraph = chainMainReplace(), version = 3): WorkflowDetail {
  return {
    ...summary,
    currentVersion: version,
    version,
    graph,
    issues: [],
    activeIssues: [],
    settings: null,
  };
}

const saveOk = (version: number) => ({
  version,
  issues: [],
  valid: true,
  active: null as WorkflowSummary['active'],
  changes: [] as string[],
});

const NODE_KEYS = [
  'id',
  'type',
  'typeVersion',
  'settings',
  'position',
  'label',
  'groupId',
  'bypassed',
];

function renderEditor(path = '/workflows/wf1') {
  return renderAt(path, <Route path="/workflows/:id" component={EditorPage} />);
}

async function loadedEditor(path?: string) {
  const view = renderEditor(path);
  await screen.findByRole('group', { name: /Action Keep languages/ });
  return view;
}

function paletteButton(section: string, name: string): HTMLElement {
  const palette = screen.getByRole('complementary', { name: 'Node palette' });
  return within(within(palette).getByRole('group', { name: section })).getByRole('button', {
    name,
  });
}

const pill = () => screen.getByRole('button', { name: /^(Active )?v\d+ · / });
/** Opens the header's "More actions" menu (when closed) and returns its item `name`, or null. */
function menuItem(name: string | RegExp): HTMLElement | null {
  const more = screen.getByRole('button', { name: 'More actions' });
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
  return screen.queryByRole('menuitem', { name });
}

const realMatchMedia = window.matchMedia;

/** Every media query answers `matches` (the editor asks only for max-width: 1023px). */
function stubNarrow(matches: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const conflictError = (currentVersion: number) =>
  new ORPCError('VERSION_CONFLICT', { defined: true, status: 409, data: { currentVersion } });

const flowNode = (container: HTMLElement, id: string) =>
  container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  resetCatalogCache();
  mocks.get.mockReset().mockResolvedValue(detail());
  mocks.list.mockReset().mockResolvedValue({ workflows: [summary] });
  mocks.validate.mockReset().mockResolvedValue({ issues: [], valid: true });
  mocks.save.mockReset().mockResolvedValue(saveOk(4));
  mocks.rename.mockReset();
  mocks.activate.mockReset();
  mocks.deactivate.mockReset();
  mocks.jobsList.mockReset().mockResolvedValue({ jobs: [] });
  mocks.versions.mockReset().mockResolvedValue({
    versions: [{ version: 3, note: null, createdBy: 'u1', createdAt: minutesAgo(2) }],
  });
  mocks.nodesList.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.librariesList.mockReset().mockResolvedValue({ libraries: [], notices: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  window.matchMedia = realMatchMedia;
  // Set by the connection test only (jsdom has no elementFromPoint).
  Reflect.deleteProperty(document, 'elementFromPoint');
});

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
    mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1)));
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse group Cleanup' }));
    expect(screen.getByRole('button', { name: 'Expand group Cleanup' })).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    cleanup();

    mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1), 2));
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
  it('EditorPage with a failing nodes.list shows "Node catalogue unavailable — reload", renders nodes as unknown and disables Save', async () => {
    mocks.nodesList.mockRejectedValue(new ORPCError('UNAUTHORIZED', { status: 401 }));
    renderEditor();
    const banner = await screen.findByText('Node catalogue unavailable — reload');
    expect(banner.closest('[role="status"]')).toBeTruthy();
    expect(await screen.findByRole('group', { name: /^Unknown core:keep-languages/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Unknown core:input-manual/ })).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save v4' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Node catalogue unavailable');
    // Read-only: no toolbar, Delete does nothing, nothing is validated or saved.
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');
    expect(mocks.validate).not.toHaveBeenCalled();

    mocks.nodesList.mockResolvedValue({ nodes: nodesFixture });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('group', { name: /Action Keep languages/ })).toBeTruthy();
    expect(screen.queryByText('Node catalogue unavailable — reload')).toBeNull();
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
    expect(viewport.style.transform).toBe('translate(12px,34px) scale(0.5)');
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

  it('the legend lists the five line meanings and the five keys', async () => {
    await loadedEditor();
    const key = screen.getByText('Key').closest('details') as HTMLElement;
    for (const text of [
      'file flow',
      'path this file took (moving)',
      'data, value on the line',
      'not taken',
      'leads to a broken node',
      'next node',
      'node actions',
      'connect',
      'remove',
      'add',
    ]) {
      expect(within(key).getByText(text)).toBeTruthy();
    }
    expect([...key.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Tab',
      'Enter',
      'C',
      'Del',
      '/',
    ]);
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
    fireEvent.change(within(inspector).getByRole('combobox', { name: 'Group' }), {
      target: { value: 'g1' },
    });
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
      mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1)));
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
      mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1)));
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
        ...detail(tiggerPoohSub()),
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
      mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1)));
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
      mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1)));
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

describe('EditorPage on-node settings, groups and bypass (Task 14)', () => {
  /** chainMainReplace plus an "Encode video" card. */
  function withEncode(): WorkflowGraph {
    const g = chainMainReplace();
    return {
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'ev',
          type: 'core:encode-video',
          typeVersion: 1,
          settings: { codec: 'hevc', quality: 24 },
          position: { x: 280, y: 300 },
        },
      ],
    };
  }

  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });
  /** Click, then Shift-click (a multi-selection key besides Meta/Control). */
  async function selectTwo(container: HTMLElement, a: string, b: string) {
    fireEvent.click(flowNode(container, a));
    await waitFor(() => expect(flowNode(container, a).classList).toContain('selected'));
    fireEvent.blur(window);
    fireEvent.keyDown(window, { key: 'Shift' });
    fireEvent.click(flowNode(container, b), { shiftKey: true });
    fireEvent.keyUp(window, { key: 'Shift' });
    await waitFor(() => {
      expect(flowNode(container, a).classList).toContain('selected');
      expect(flowNode(container, b).classList).toContain('selected');
    });
  }

  it('typing 22 in the card\'s "Quality (CRF)" updates the inspector', async () => {
    mocks.get.mockResolvedValue(detail(withEncode()));
    const { container } = await loadedEditor();
    const card = within(screen.getByRole('group', { name: /Action Encode video/ }));
    fireEvent.change(card.getByRole('spinbutton', { name: 'Quality (CRF)' }), {
      target: { value: '22' },
    });
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    fireEvent.click(flowNode(container, 'ev'));
    await waitFor(() =>
      expect(within(inspector()).getByRole('heading', { name: 'Encode video' })).toBeTruthy(),
    );
    const quality = within(inspector()).getByRole('spinbutton', { name: /^Quality/ });
    expect((quality as HTMLInputElement).value).toBe('22');
  });

  it('picking a language in the card\'s "Default audio" marks the workflow unsaved and keeps the list', async () => {
    const g = chainMainReplace();
    mocks.get.mockResolvedValue(
      detail({
        ...g,
        nodes: [
          ...g.nodes,
          {
            id: 'sdt',
            type: 'core:set-default-track',
            typeVersion: 1,
            settings: { audioLanguages: ['en', 'de'], subtitleLanguages: [] },
            position: { x: 280, y: 300 },
          },
        ],
      }),
    );
    await loadedEditor();
    const card = within(screen.getByRole('group', { name: /Action Set default track/ }));
    const select = card.getByRole('combobox', { name: 'Default audio' }) as HTMLSelectElement;
    expect(select.value).toBe('en');
    fireEvent.change(select, { target: { value: 'fr' } });
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
    expect((card.getByRole('combobox', { name: 'Default audio' }) as HTMLSelectElement).value).toBe(
      'fr',
    );
  });

  it('clicking the "Keep languages" summary selects the node and focuses its field', async () => {
    await loadedEditor();
    const card = within(screen.getByRole('group', { name: /Action Keep languages/ }));
    fireEvent.click(card.getByRole('button', { name: /^Languages to keep: en/ }));
    await waitFor(() =>
      expect(within(inspector()).getByRole('heading', { name: 'Keep languages' })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-field="languages"]')).not.toBeNull(),
    );
  });

  it('EditorPage: selecting two nodes and clicking "Group 2 nodes" creates a group around them and opens the group inspector', async () => {
    const { container } = await loadedEditor();
    await selectTwo(container, 'in', 'keep');
    const bar = await screen.findByRole('toolbar', { name: 'Selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Group 2 nodes' }));

    const box = await screen.findByRole('group', { name: 'Group Group' });
    expect(box.textContent).toContain('Group · 2 nodes');
    const name = within(inspector()).getByRole('textbox', { name: 'Group name' });
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(within(inspector()).getByText('2 nodes')).toBeTruthy();
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    fireEvent.change(name, { target: { value: 'Audio rules' } });
    expect(await screen.findByRole('group', { name: 'Group Audio rules' })).toBeTruthy();

    // Saved graph: both members carry the group id; the box surrounds their cards.
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    const graph = mocks.save.mock.calls[0]?.[0].graph as WorkflowGraph;
    const [group] = graph.groups;
    expect(group?.name).toBe('Audio rules');
    expect(graph.nodes.filter((n) => n.groupId === group?.id).map((n) => n.id)).toEqual([
      'in',
      'keep',
    ]);
    expect(group?.position).toEqual({ x: -24, y: -24 });
    expect(group?.size.width).toBeGreaterThanOrEqual(280 + 210 + 48);
  });

  it('EditorPage: collapsing a group hides its nodes and shows "Group · 2 nodes" on the tile', async () => {
    mocks.get.mockResolvedValue(detail(tiggerPoohMain('sub', 1)));
    const { container } = renderEditor();
    await screen.findByRole('group', { name: 'Group Cleanup' });
    fireEvent.click(flowNode(container, 'cleanup'));
    const collapsed = await within(inspector()).findByRole('switch', { name: 'Collapsed' });
    fireEvent.click(collapsed);
    await waitFor(() => expect(flowNode(container, 'run-a')).toBeNull());
    expect(flowNode(container, 'run-b')).toBeNull();
    const tile = screen.getByRole('group', { name: 'Group Cleanup' });
    expect(tile.classList).toContain('is-collapsed');
    expect(tile.textContent).toContain('Group · 2 nodes');
    expect(collapsed.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Expand group Cleanup' }));
    await waitFor(() => expect(flowNode(container, 'run-a')).toBeTruthy());

    // Ungroup keeps the members.
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Ungroup' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Group Cleanup' })).toBeNull());
    expect(flowNode(container, 'run-a')).toBeTruthy();
  });

  it('bypass from the toolbar marks the card Skipped here and the inspector switch on', async () => {
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'keep'));
    const bar = await screen.findByRole('toolbar', { name: 'Node actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Bypass' }));
    const card = await screen.findByRole('group', {
      name: 'Action Keep languages, skipped here',
    });
    expect(card.querySelector('.tc-node-skipped')?.textContent).toBe('Skipped here');
    expect(card.classList).toContain('is-bypassed');
    const sw = within(inspector()).getByRole('switch', { name: 'Bypass' });
    expect(sw.getAttribute('aria-checked')).toBe('true');

    // The inspector switch turns it back off.
    fireEvent.click(sw);
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Action Keep languages' })).toBeTruthy(),
    );
  });

  describe('sub-workflows (Task 15)', () => {
    const subSummary: WorkflowSummary = {
      ...summary,
      id: 'sub-lang',
      name: 'Language cleanup',
      kind: 'subworkflow',
      currentVersion: 2,
    };
    const subDetail = (usedBy: WorkflowSummary['usedBy'] = []): WorkflowDetail => ({
      ...detail(tiggerPoohSub()),
      id: 'sub-lang',
      name: 'Language cleanup',
      kind: 'subworkflow',
      usedBy,
    });

    it('a sub-workflow has no activation control', async () => {
      mocks.get.mockResolvedValue(subDetail([{ id: 'a', name: 'Smoke' }]));
      renderAt('/workflows/sub-lang', <Route path="/workflows/:id" component={EditorPage} />);
      await screen.findByRole('group', { name: /Action Keep languages/ });
      expect(pill().textContent).not.toMatch(/active/i);
      expect(menuItem(/^Activate v/)).toBeNull();
      expect(screen.getByText('Used by 1 workflow')).toBeTruthy();
    });

    it('EditorPage: Delete on the Start node of a sub-workflow shows the refusal toast and keeps the node', async () => {
      mocks.get.mockResolvedValue(subDetail());
      const { container } = renderAt(
        '/workflows/sub-lang',
        <Route path="/workflows/:id" component={EditorPage} />,
      );
      await screen.findByRole('group', { name: /Action Keep languages/ });
      fireEvent.click(flowNode(container, 'start'));
      const toolbar = await screen.findByRole('toolbar', { name: 'Node actions' });
      fireEvent.click(within(toolbar).getByRole('button', { name: 'Delete' }));
      expect((await screen.findByRole('alert')).textContent).toContain(
        'A sub-workflow needs its start and end',
      );
      expect(flowNode(container, 'start')).toBeTruthy();
      expect(pill().textContent).toBe('v3 · saved 2 min ago');
    });

    it('EditorPage: dropping a sub-workflow from the palette creates a Run node pinned to its current version', async () => {
      mocks.list.mockResolvedValue({ workflows: [summary, subSummary] });
      const { container } = await loadedEditor();
      const item = paletteButton('Sub-workflows', 'Language cleanup');
      const store = new Map<string, string>();
      const dataTransfer = {
        types: [] as string[],
        effectAllowed: 'none',
        dropEffect: 'none',
        setData(type: string, value: string) {
          store.set(type, value);
          this.types.push(type);
        },
        getData: (type: string) => store.get(type) ?? '',
      };
      fireEvent.dragStart(item, { dataTransfer });
      const pane = container.querySelector('.react-flow') as HTMLElement;
      fireEvent.dragOver(pane, { dataTransfer, clientX: 300, clientY: 200 });
      fireEvent.drop(pane, { dataTransfer, clientX: 300, clientY: 200 });
      expect(await screen.findByRole('group', { name: /^Action Run sub-workflow/ })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      await screen.findByText('Saved v4');
      const [arg] = mocks.save.mock.calls[0] ?? [];
      const run = (arg.graph as WorkflowGraph).nodes.find((n) => n.type === 'core:run-subworkflow');
      expect(run?.settings).toEqual({ subworkflowId: 'sub-lang', version: 2, overrides: {} });
    });

    it('EditorPage: "c" offers named sub-workflows; picking one adds a connected Run node pinned to its current version', async () => {
      mocks.list.mockResolvedValue({ workflows: [summary, subSummary] });
      mocks.get.mockResolvedValue(
        detail({ ...chainMainReplace(), edges: chainMainReplace().edges.slice(0, 1) }),
      );
      const { container } = await loadedEditor();
      fireEvent.click(flowNode(container, 'keep'));
      await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
      fireEvent.keyDown(flowNode(container, 'keep'), { key: 'c' });
      const dialog = await screen.findByRole('dialog', {
        name: /^Add the next node · \d+ matches$/,
      });
      fireEvent.click(
        within(dialog).getByRole('option', { name: 'Language cleanup, sub-workflow' }),
      );
      expect(await screen.findByRole('group', { name: /^Action Run sub-workflow/ })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      await screen.findByText('Saved v4');
      const [arg] = mocks.save.mock.calls[0] ?? [];
      const graph = arg.graph as WorkflowGraph;
      const run = graph.nodes.find((n) => n.type === 'core:run-subworkflow');
      expect(run?.settings).toEqual({ subworkflowId: 'sub-lang', version: 2, overrides: {} });
      expect(graph.edges.some((e) => e.from.node === 'keep' && e.to.node === run?.id)).toBe(true);
    });

    it('EditorPage: selecting a Run node shows its sub-workflow inspector', async () => {
      mocks.list.mockResolvedValue({ workflows: [summary, subSummary] });
      mocks.get.mockImplementation(async ({ id }: { id: string }) =>
        id === 'sub-lang'
          ? { ...subDetail(), version: 1, settings: [] }
          : detail(tiggerPoohMain('sub-lang', 1)),
      );
      const { container } = renderEditor();
      await waitFor(() => expect(flowNode(container, 'run-a')).toBeTruthy());
      fireEvent.click(flowNode(container, 'run-a'));
      const inspector = screen.getByRole('complementary', { name: 'Inspector' });
      const pick = (await within(inspector).findByRole('combobox', {
        name: 'Sub-workflow',
      })) as HTMLSelectElement;
      expect(pick.value).toBe('sub-lang');
      expect(within(inspector).getByText('v1 pinned · v2 available')).toBeTruthy();
      expect(mocks.get).toHaveBeenCalledWith({ id: 'sub-lang', version: 1 });
      // The stored override is not in the (empty) child settings any more.
      expect(
        await within(inspector).findByText('will be dropped on save: keep.languages'),
      ).toBeTruthy();
      fireEvent.click(within(inspector).getByRole('button', { name: 'Update to v2' }));
      expect(pill().textContent).toBe('v3 · Not active · unsaved changes');
      expect(within(inspector).getByText('v2 pinned')).toBeTruthy();
      await waitFor(() => expect(mocks.get).toHaveBeenCalledWith({ id: 'sub-lang', version: 2 }));
    });

    it('EditorHeader shows "Used by 2 workflows" and the pin banner while dirty', async () => {
      mocks.get.mockResolvedValue(
        subDetail([
          { id: 'a', name: 'Smoke' },
          { id: 'b', name: 'Movies' },
        ]),
      );
      renderAt('/workflows/sub-lang', <Route path="/workflows/:id" component={EditorPage} />);
      await screen.findByRole('group', { name: /Action Keep languages/ });
      const usedBy = screen.getByText('Used by 2 workflows');
      expect(usedBy.getAttribute('title')).toBe('Smoke, Movies');
      const banner =
        'N workflows pin older versions; they keep running the version they pinned until updated.';
      const text = banner.replace('N', '2');
      expect(screen.queryByText(text)).toBeNull();

      fireEvent.click(paletteButton('Action', 'Remux'));
      expect(pill().textContent).toBe('v3 · unsaved changes');
      const shown = screen.getByText(text);
      expect(shown.closest('[role="status"]')?.className).toContain('is-warning');
    });

    it('one user reads "Used by 1 workflow"; a workflow or an unused sub-workflow shows none', async () => {
      mocks.get.mockResolvedValue(subDetail([{ id: 'a', name: 'Smoke' }]));
      const { unmount } = renderAt(
        '/workflows/sub-lang',
        <Route path="/workflows/:id" component={EditorPage} />,
      );
      await screen.findByRole('group', { name: /Action Keep languages/ });
      expect(screen.getByText('Used by 1 workflow')).toBeTruthy();
      fireEvent.click(paletteButton('Action', 'Remux'));
      expect(
        screen.getByText(
          '1 workflow pins an older version; it keeps running the version it pinned until updated.',
        ),
      ).toBeTruthy();
      unmount();

      mocks.get.mockResolvedValue(subDetail());
      renderAt('/workflows/sub-lang', <Route path="/workflows/:id" component={EditorPage} />);
      await screen.findByRole('group', { name: /Action Keep languages/ });
      fireEvent.click(paletteButton('Action', 'Remux'));
      expect(screen.queryByText(/^Used by/)).toBeNull();
      expect(screen.queryByText(/pin(s)? (an )?older version/)).toBeNull();
    });
  });
});

describe('EditorPage leave guard, undo/redo and save shortcut (Task 19)', () => {
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const keepCount = () => screen.getAllByRole('group', { name: /Action Keep languages/ }).length;
  const leaveDialog = () => screen.getByRole('dialog', { name: 'Leave without saving?' });
  const crumbLink = () =>
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
      name: 'Workflows',
    });

  it('navigating away with a dirty draft opens "Leave without saving?"; Stay keeps the route; Leave navigates; Save and leave saves first', async () => {
    mocks.save
      .mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }))
      .mockResolvedValueOnce(saveOk(4));
    const view = await loadedEditor();
    fireEvent.click(crumbLink());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.location()).toBe('/');

    view.navigate('/workflows/wf1');
    await screen.findByRole('group', { name: /Action Keep languages/ });
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Stay' }));
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    // A failed save stays inside the dialog; the draft and the route are kept.
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    const alert = await within(leaveDialog()).findByRole('alert');
    expect(alert.textContent).toContain('The workflow is too large to save (2 MB limit)');
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(view.location()).toBe('/'));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({ baseVersion: 3 });
  });

  it('"Leave" from the versions panel drops the draft and opens that version', async () => {
    mocks.versions.mockResolvedValue({
      versions: [
        { version: 3, note: null, createdBy: 'u1', createdAt: minutesAgo(2) },
        { version: 2, note: null, createdBy: 'u1', createdAt: minutesAgo(60) },
      ],
    });
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(pill());
    fireEvent.click(
      await within(screen.getByRole('dialog', { name: 'Versions' })).findByRole('link', {
        name: /^v2 · /,
      }),
    );
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Leave' }));
    expect(view.location()).toBe('/workflows/wf1?version=2');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1', version: 2 }));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('a conflict on "Save and leave" closes it and opens the conflict dialog', async () => {
    mocks.save.mockRejectedValueOnce(conflictError(5));
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    expect(
      await screen.findByRole('dialog', { name: 'Someone saved v5 while you were editing' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(view.location()).toBe('/workflows/wf1');
  });

  it('"Save and leave" stays when the draft changed while it saved', async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.save.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    // An edit lands while the save is in flight.
    fireEvent.click(paletteButton('Action', 'Remux'));
    await act(async () => answer(saveOk(4)));
    const alert = await within(leaveDialog()).findByRole('alert');
    expect(alert.textContent).toBe('It changed while saving. Save again to keep the new changes.');
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v4 · Not active · unsaved changes');
  });

  it('undo/redo header buttons reflect the stacks and loading a version clears them', async () => {
    mocks.versions.mockResolvedValue({
      versions: [
        { version: 4, note: null, createdBy: 'u1', createdAt: minutesAgo(0) },
        { version: 3, note: null, createdBy: 'u1', createdAt: minutesAgo(2) },
      ],
    });
    const view = await loadedEditor();
    expect(button('Undo').title).toBe('Undo (⌘Z)');
    expect(button('Redo').title).toBe('Redo (⇧⌘Z)');
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);

    fireEvent.click(paletteButton('Action', 'Keep languages'));
    expect(keepCount()).toBe(2);
    expect(button('Undo').disabled).toBe(false);
    expect(button('Redo').disabled).toBe(true);

    fireEvent.click(button('Undo'));
    await waitFor(() => expect(keepCount()).toBe(1));
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(false);
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');

    fireEvent.click(button('Redo'));
    await waitFor(() => expect(keepCount()).toBe(2));
    expect(button('Undo').disabled).toBe(false);
    expect(button('Redo').disabled).toBe(true);

    // Saving keeps the history; loading a version clears it.
    fireEvent.click(button('Save v4'));
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    expect(button('Undo').disabled).toBe(false);
    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 3), currentVersion: 4 });
    fireEvent.click(pill());
    fireEvent.click(
      await within(screen.getByRole('dialog', { name: 'Versions' })).findByRole('link', {
        name: /^v3 · /,
      }),
    );
    expect(view.location()).toBe('/workflows/wf1?version=3');
    await screen.findByText('Viewing v3 — current is v4');
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);

    // Back on the current version: a fresh load, nothing to undo.
    mocks.get.mockResolvedValue(detail(chainMainReplace(), 4));
    view.navigate('/workflows/wf1');
    await waitFor(() => expect(pill().textContent).toMatch(/^v4 · /));
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);
  });

  it('a reload after a conflict clears the undo history', async () => {
    mocks.save.mockRejectedValueOnce(conflictError(5));
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(button('Save v4'));
    const dialog = await screen.findByRole('dialog');
    mocks.get.mockResolvedValueOnce(detail(chainMainReplace(), 5));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload the latest version' }));
    await waitFor(() => expect(pill().textContent).toMatch(/^v5 · Not active · saved/));
    expect(button('Undo').disabled).toBe(true);
  });

  it('Mod+S saves when dirty and does nothing when clean or read-only', async () => {
    await loadedEditor();
    // Clean: nothing is sent, and the browser's own save dialog is still held off.
    expect(fireEvent.keyDown(document.body, { key: 's', metaKey: true })).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();

    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(pill().textContent).toMatch(/^v4 · /);
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    cleanup();

    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 3), currentVersion: 7 });
    await loadedEditor('/workflows/wf1?version=3');
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});

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

  it('a past version shows "Activate v2" beside "Restore as new version"; the active version shows "Viewing v3 — active" without it', async () => {
    mocks.get.mockResolvedValue({
      ...detail(chainMainReplace(), 2),
      currentVersion: 3,
      active: activeV3(),
    });
    await loadedEditor('/workflows/wf1?version=2');
    expect(screen.getByText('Viewing v2 — current is v3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore as new version' })).toBeTruthy();
    // Read-only: the header menu has no Activate, the past-version banner has the one.
    expect(screen.getAllByRole('button', { name: 'Activate v2' })).toHaveLength(1);
    expect(menuItem('Activate v2')).toBeNull();
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
    expect(screen.getAllByRole('button', { name: 'Activate v2' })).toHaveLength(1);
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
    fireEvent.click(screen.getByRole('button', { name: 'Activate v2' }));
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

describe('EditorPage try on a file (Task 24)', () => {
  const shows = {
    id: 'l1',
    name: 'Shows',
    path: '/media/Shows',
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    feeds: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  };

  beforeEach(() => {
    mocks.queue.mockReset().mockResolvedValue({ runId: 'r1', jobIds: ['j1'] });
    mocks.librariesList.mockReset().mockResolvedValue({ libraries: [shows], notices: [] });
    mocks.browse.mockReset().mockResolvedValue({
      dirs: [],
      files: [{ name: 'tigger-pooh.mp4', sizeBytes: 2_410_000_000, mtime: minutesAgo(60) }],
    });
  });

  async function pickTigger(title = 'Dry run Smoke on a file') {
    const dialog = await screen.findByRole('dialog', { name: title });
    fireEvent.click(await within(dialog).findByRole('button', { name: /tigger-pooh\.mp4/ }));
  }

  it('EditorPage "Dry run on a file" queues a dry run for the saved version and navigates to the job; with a dirty draft the button reads "Save, then try" and saves first', async () => {
    const view = await loadedEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run on a file' }));
    await pickTigger();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/Shows/tigger-pooh.mp4',
      workflowId: 'wf1',
      dryRun: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();

    view.navigate('/workflows/wf1');
    await screen.findByRole('group', { name: /Action Keep languages/ });
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    expect(screen.queryByRole('button', { name: 'Dry run on a file' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await pickTigger();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ id: 'wf1', baseVersion: 3 });
    // The save came first: the run is of the version just saved.
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queue.mock.invocationCallOrder[1] ?? 0,
    );
    // Nothing asked to leave: the draft was saved.
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
  });

  it('"Run on a file" is disabled until a version is active, then runs the active version for real', async () => {
    await loadedEditor();
    const off = menuItem('Run on a file') as HTMLElement;
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(off.title).toBe('Activate a version to run for real');
    cleanup();

    mocks.get.mockResolvedValue({
      ...detail(),
      active: {
        version: 2,
        runnable: true,
        activatedAt: minutesAgo(30),
        activatedBy: 'u1',
      },
    });
    const live = await loadedEditor();
    fireEvent.click(menuItem('Run on a file') as HTMLElement);
    const picker = await screen.findByRole('dialog', { name: 'Run Smoke v2 on a file' });
    fireEvent.click(await within(picker).findByRole('button', { name: /tigger-pooh\.mp4/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Run Smoke on this file?' });
    expect(confirm.textContent).toContain(
      'Applies Smoke v2 (active) to /media/Shows/tigger-pooh.mp4. The original moves to /media/Shows/.transcoda-recycle.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(live.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/Shows/tigger-pooh.mp4',
      workflowId: 'wf1',
      dryRun: false,
      fileOnly: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('"Dry run on a file" on a past version queues jobs.queue with workflowVersion: 2', async () => {
    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 2), currentVersion: 3 });
    const view = await loadedEditor('/workflows/wf1?version=2');
    fireEvent.click(screen.getByRole('button', { name: 'Dry run on a file' }));
    await pickTigger();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/Shows/tigger-pooh.mp4',
      workflowId: 'wf1',
      dryRun: true,
      workflowVersion: 2,
    });
  });

  it('"Save, then try" waits for a save already running, then queues (final review M8)', async () => {
    const pending = deferred<ReturnType<typeof saveOk>>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await screen.findByRole('dialog', { name: 'Dry run Smoke on a file' });
    // A save starts (header) while the picker is open.
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    await pickTigger();
    expect(mocks.queue).not.toHaveBeenCalled();
    await act(async () => pending.resolve(saveOk(4)));
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.queue).toHaveBeenCalledTimes(1);
  });

  it('a folder pick that queues several files navigates to the run summary', async () => {
    mocks.queue.mockResolvedValueOnce({ runId: 'r9', jobIds: ['j1', 'j2'] });
    const view = await loadedEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run on a file' }));
    await pickTigger();
    await waitFor(() => expect(view.location()).toBe('/runs/r9'));
  });

  it('a failed save stays in the editor without queueing; WORKFLOW_INVALID is a toast', async () => {
    mocks.save.mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }));
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await pickTigger();
    expect(await screen.findByText('The workflow is too large to save (2 MB limit)')).toBeTruthy();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    mocks.queue.mockRejectedValueOnce(
      new ORPCError('WORKFLOW_INVALID', { defined: true, status: 422, data: { issues: [] } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await pickTigger();
    expect(await screen.findByText('Fix the errors first')).toBeTruthy();
    expect(view.location()).toBe('/workflows/wf1');
  });

  it('toolbar "Try this node" navigates with ?node=<id> and JobPage preselects it', async () => {
    const view = await loadedEditor();
    const { container } = view;
    fireEvent.click(flowNode(container, 'keep'));
    await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
    fireEvent.click(await screen.findByRole('button', { name: 'Try this node' }));
    await pickTigger();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1?node=keep'));
  });

  it('a sub-workflow cannot be tried on a file', async () => {
    mocks.get.mockResolvedValue({
      ...detail(tiggerPoohSub()),
      kind: 'subworkflow',
    });
    renderEditor();
    const tryIt = (await screen.findByRole('button', {
      name: 'Dry run on a file',
    })) as HTMLButtonElement;
    expect(tryIt.disabled).toBe(true);
    expect(tryIt.title).toBe('A sub-workflow is tried from a workflow that runs it');
  });
});

describe('EditorPage library binding (library trigger T5)', () => {
  const lib = (id: string, name: string) => ({
    id,
    name,
    path: `/media/${name}`,
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    feeds: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  });

  /** chainMainReplace with its Manual input swapped for a Library input on `libraryId`. */
  function onLibrary(libraryId: string): WorkflowGraph {
    const g = chainMainReplace();
    g.nodes[0] = {
      id: 'in',
      type: 'core:input-library',
      typeVersion: 1,
      settings: { libraryId },
      position: { x: 0, y: 0 },
    };
    return g;
  }

  beforeEach(() => {
    mocks.librariesList
      .mockReset()
      .mockResolvedValue({ libraries: [lib('l1', 'Shows'), lib('l2', 'Movies')], notices: [] });
  });

  it('a draft that names another library than the one v3 feeds shows the library banner', async () => {
    mocks.get.mockResolvedValue({
      ...detail(onLibrary('l2'), 4),
      active: { version: 3, runnable: true, activatedAt: minutesAgo(60), activatedBy: 'u1' },
      feedsLibrary: { id: 'l1', name: 'Shows' },
    });
    await loadedEditor();
    expect(
      await screen.findByText(
        'Real runs still take files from Shows (v3 active). Activate this version to switch to Movies.',
      ),
    ).toBeTruthy();
  });

  it("the inspector's Library field carries the hint about active versions", async () => {
    mocks.get.mockResolvedValue(detail(onLibrary('l1')));
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'in'));
    expect(
      await screen.findByText(
        'Files from this library go to this workflow once a version is active.',
      ),
    ).toBeTruthy();
  });
});
