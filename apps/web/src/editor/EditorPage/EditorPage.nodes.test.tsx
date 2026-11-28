import { cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import type { WorkflowGraph } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';
import { chainMainReplace, otterFinchMain, otterFinchSub } from '../../testing/fixtures/graphs.ts';
import { renderAt } from '../../testing/render.tsx';

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

import { EditorPage } from './EditorPage.tsx';
import {
  detail,
  flowNode,
  loadedEditor,
  menuItem,
  paletteButton,
  pill,
  renderEditor,
  setupEditorPageMocks,
  summary,
} from './testing.tsx';

setupEditorPageMocks(mocks);
afterEach(cleanup);

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
    mocks.get.mockResolvedValue(detail(otterFinchMain('sub', 1)));
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
      ...detail(otterFinchSub()),
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
      fireEvent.click(within(toolbar).getByRole('button', { name: 'Remove node' }));
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
      fireEvent.dragOver(pane, { dataTransfer });
      // jsdom has no DragEvent, so the drop's pointer position is set on the event by hand.
      const drop = createEvent.drop(pane, { dataTransfer });
      Object.defineProperties(drop, { clientX: { value: 300 }, clientY: { value: 200 } });
      fireEvent(pane, drop);
      expect(await screen.findByRole('group', { name: /^Action Run sub-workflow/ })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
      await screen.findByText('Saved v4');
      const [arg] = mocks.save.mock.calls[0] ?? [];
      const run = (arg.graph as WorkflowGraph).nodes.find((n) => n.type === 'core:run-subworkflow');
      expect(run?.settings).toEqual({ subworkflowId: 'sub-lang', version: 2, overrides: {} });
      // Placed where it was dropped (a real position, not NaN).
      expect(Number.isFinite(run?.position.x) && Number.isFinite(run?.position.y)).toBe(true);
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
          : detail(otterFinchMain('sub-lang', 1)),
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
