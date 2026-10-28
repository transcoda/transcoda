import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { NodeInfo, WorkflowSummary } from '@transcoda/contract';
import type { Issue, NodeInstance } from '@transcoda/shared';
import { type Edge, type NodeProps, Position, useStoreApi } from '@xyflow/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortSpec } from '../../hooks/useCatalog.ts';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { renderFlow } from '../../test/flow.tsx';
import { NEEDS_A_SETTING, nodeStateFor } from '../model/issues.ts';
import {
  DEFAULT_EDITOR_ACTIONS,
  type EditorActions,
  EditorActionsContext,
} from './actions-context.ts';
import { edgeTypes, nodeTypes } from './nodeTypes.ts';
import { SubworkflowsContext } from './subworkflows-context.ts';
import { portLabel } from './TcHandle.tsx';
import { TcNode as TcNodeCard } from './TcNode.tsx';
import type { TcNode } from './types.ts';

afterEach(cleanup);

function instance(id: string, type: string, extra: Partial<NodeInstance> = {}): NodeInstance {
  return { id, type, typeVersion: 1, settings: {}, position: { x: 0, y: 0 }, ...extra };
}

function tcNode(
  inst: NodeInstance,
  opts: { issues?: Issue[]; def?: NodeInfo | null; x?: number } = {},
): TcNode {
  return {
    id: inst.id,
    type: 'tc-node',
    position: { x: opts.x ?? 0, y: 0 },
    initialWidth: 210,
    initialHeight: 120,
    data: {
      instance: inst,
      def: opts.def === undefined ? (catalogFixture.byType.get(inst.type) ?? null) : opts.def,
      state: nodeStateFor(inst.id, opts.issues ?? [], inst.type),
      graphKind: 'workflow',
    },
  };
}

function issue(nodeId: string, code: string, message: string, severity = 'error'): Issue {
  return { code, severity, message, nodeId } as Issue;
}

async function show(
  nodes: TcNode[],
  edges: Edge[] = [],
  actions?: EditorActions,
  props: Omit<Parameters<typeof renderFlow>[2], 'nodeTypes' | 'edgeTypes'> = {},
) {
  // An editable canvas: the page provides the actions (Task 10); here each card gets them directly.
  const types = actions
    ? {
        'tc-node': (props: NodeProps<TcNode>) => (
          <EditorActionsContext.Provider value={actions}>
            <TcNodeCard {...props} />
          </EditorActionsContext.Provider>
        ),
      }
    : nodeTypes;
  return renderFlow(nodes, edges, { nodeTypes: types, edgeTypes, ...props });
}

/** Puts React Flow's store into a drag from `nodeId`'s `handleId` (what a pointer drag sets). */
function DragFrom({
  nodeId,
  handleId,
  type,
}: {
  nodeId: string;
  handleId: string;
  type: 'source' | 'target';
}) {
  const store = useStoreApi();
  useEffect(() => {
    const fromNode = store.getState().nodeLookup.get(nodeId);
    if (!fromNode) throw new Error(`no node ${nodeId}`);
    const position = type === 'source' ? Position.Right : Position.Left;
    store.setState({
      connection: {
        inProgress: true,
        isValid: null,
        from: { x: 0, y: 0 },
        fromHandle: { id: handleId, nodeId, type, position, x: 0, y: 0, width: 14, height: 14 },
        fromPosition: position,
        fromNode,
        to: { x: 300, y: 0 },
        toHandle: null,
        toPosition: Position.Left,
        toNode: null,
        pointer: { x: 300, y: 0 },
      },
    });
  }, [store, nodeId, handleId, type]);
  return null;
}

const card = (id: string) => screen.getByTestId(`tc-node-${id}`);
const handle = (id: string, port: string) =>
  card(id).querySelector(`[data-handleid="${port}"]`) as HTMLElement;

describe('portLabel', () => {
  const file = (id: string, label: string): PortSpec => ({ id, label, type: 'file' });
  it('reads Yes and No for pass and else, also for a plugin that kept the generic Pass/Else labels', () => {
    expect(portLabel(file('pass', 'Pass'))).toBe('Yes');
    expect(portLabel(file('else', 'Else'))).toBe('No');
    expect(portLabel(file('pass', 'Yes'))).toBe('Yes');
  });
  it('leaves a plugin\u2019s own words for a branch port alone, and other file ports read "file"', () => {
    expect(portLabel(file('pass', 'Wanted'))).toBe('Wanted');
    expect(portLabel(file('else', 'Other'))).toBe('Other');
    expect(portLabel(file('out', 'Out'))).toBe('file');
  });
});

describe('TcNode', () => {
  it('renders kind word, title and labelled port rows with the right handle shapes', async () => {
    await show([tcNode(instance('keep', 'core:keep-languages'))]);
    const node = card('keep');
    expect(node.getAttribute('role')).toBe('group');
    expect(node.getAttribute('aria-label')).toBe('Action Keep languages');
    expect(node.querySelector('.tc-node-eyebrow')?.textContent).toBe('Action');
    expect(within(node).getByText('Keep languages')).toBeTruthy();
    const rows = [...node.querySelectorAll('.tc-port')].map((r) => r.textContent);
    expect(rows).toEqual(['filefile', 'Original language']);
    expect(handle('keep', 'file')).toBeTruthy();
    const ins = node.querySelectorAll('.react-flow__handle.target');
    const outs = node.querySelectorAll('.react-flow__handle.source');
    expect([...ins].map((h) => h.className.match(/tc-handle-[a-z]+-[a-z]+/)?.[0])).toEqual([
      'tc-handle-file-in',
      'tc-handle-data-in',
    ]);
    expect([...outs].map((h) => h.className.match(/tc-handle-[a-z]+-[a-z]+/)?.[0])).toEqual([
      'tc-handle-file-out',
    ]);
    expect(node.querySelector('[data-icon="languages"]')).not.toBeNull();
  });

  it('labels branch outputs Yes and No (the ids stay pass and else) and plugin nodes with "· plugin"', async () => {
    await show([
      tcNode(instance('vi', 'core:video-is')),
      tcNode(instance('gen', 'test:unavailable'), { x: 400 }),
    ]);
    const rows = [...card('vi').querySelectorAll('.tc-port')].map((r) => r.textContent);
    // "Yes · file" on screen (the dot is drawn by the stylesheet); "Yes, file" read aloud.
    expect(rows).toEqual(['fileYes, file', 'No, file']);
    expect([...card('vi').querySelectorAll('.tc-port-type')].map((t) => t.textContent)).toEqual([
      ', file',
      ', file',
    ]);
    // What people read changed; the stored handle ids did not.
    expect(card('vi').querySelector('[data-handleid="pass"]')?.getAttribute('title')).toBe(
      'Yes, file out',
    );
    expect(card('vi').querySelector('[data-handleid="else"]')?.getAttribute('title')).toBe(
      'No, file out',
    );
    expect(card('gen').querySelector('.tc-node-eyebrow')?.textContent).toBe('Action · plugin');
  });

  it('a data branch and a plugin condition name their type too; zoomed out the type word goes', async () => {
    const def = (id: string, type: string, labels: [string, string]): NodeInfo => {
      const base = catalogFixture.byType.get('core:video-is') as NodeInfo;
      return {
        ...base,
        type: id,
        outputs: [
          { id: 'pass', label: labels[0], type },
          { id: 'else', label: labels[1], type },
        ],
      } as NodeInfo;
    };
    await show([
      tcNode(instance('d', 'test:data-branch'), {
        def: def('test:data-branch', 'data:language', ['Pass', 'Else']),
      }),
      tcNode(instance('p', 'test:plugin-cond'), {
        def: def('test:plugin-cond', 'file', ['Wanted', 'Other']),
        x: 400,
      }),
    ]);
    const outs = (id: string) =>
      [...card(id).querySelectorAll('.tc-port-out')].map((r) => r.textContent);
    expect(outs('d')).toEqual(['Yes, data', 'No, data']);
    expect(card('d').querySelector('.tc-port-out')?.classList.contains('is-branch-pass')).toBe(
      true,
    );
    expect(handle('d', 'pass').getAttribute('title')).toBe('Yes, data out');
    expect(outs('p')).toEqual(['Wanted, file', 'Other, file']);
    cleanup();

    await show([tcNode(instance('vi', 'core:video-is'))], [], undefined, {
      defaultViewport: { x: 0, y: 0, zoom: 0.5 },
      minZoom: 0.1,
    });
    expect(card('vi').querySelector('.tc-port-type')).toBeNull();
    expect(card('vi').querySelector('.tc-port-out')).toBeNull();
  });

  it('the size gate shows two outputs, Yes and No, each with a connect button', async () => {
    await show([tcNode(instance('sg', 'core:size-gate', { typeVersion: 2 }))], [], {
      ...DEFAULT_EDITOR_ACTIONS,
      readOnly: false,
      startConnectFrom: vi.fn(),
    });
    const rows = [...card('sg').querySelectorAll('.tc-port')].map((r) => r.textContent);
    expect(rows).toEqual(['fileYes, file', 'No, file']);
    expect(within(card('sg')).getByRole('button', { name: 'Connect from Yes' })).toBeTruthy();
    expect(within(card('sg')).getByRole('button', { name: 'Connect from No' })).toBeTruthy();
  });

  it('a Render card shows Done only until Quality check is on, then Done and Damaged', async () => {
    const actions = { ...DEFAULT_EDITOR_ACTIONS, readOnly: false, startConnectFrom: vi.fn() };
    const ports = () =>
      within(card('r'))
        .queryAllByRole('button', { name: /^Connect from / })
        .map((b) => b.getAttribute('aria-label'));
    await show([tcNode(instance('r', 'core:render'))], [], actions);
    expect(ports()).toEqual(['Connect from Done']);
    cleanup();
    await show(
      [tcNode(instance('r', 'core:render', { settings: { qualityCheck: true } }))],
      [],
      actions,
    );
    expect(ports()).toEqual(['Connect from Done', 'Connect from Damaged']);
  });

  it('shows badge icon + word for each NodeState and the bypass eyebrow', async () => {
    await show([
      tcNode(instance('a', 'core:notify-webhook'), {
        issues: [issue('a', 'INVALID_SETTINGS', NEEDS_A_SETTING)],
      }),
      tcNode(instance('b', 'core:remux'), {
        issues: [issue('b', 'UNKNOWN_NODE_VERSION', 'Plugin is missing')],
      }),
      tcNode(instance('c', 'test:unavailable'), {
        issues: [issue('c', 'NODE_UNAVAILABLE', 'Not here')],
      }),
      tcNode(instance('d', 'core:encode-video', { bypassed: true })),
      tcNode(instance('e', 'core:run-subworkflow'), {
        issues: [issue('e', 'SUBWORKFLOW_MISSING', 'gone')],
      }),
    ]);

    const a = card('a');
    expect(a.classList.contains('border-amber')).toBe(true);
    expect(a.getAttribute('aria-label')).toBe('Finish Notify webhook, needs a setting');
    expect(a.querySelector('.tc-badge')?.textContent).toBe('!needs a setting');
    expect(a.querySelector('.tc-node-row')?.textContent).toBe('needs a setting');

    const b = card('b');
    expect(b.classList.contains('border-red')).toBe(true);
    expect(b.querySelector('.tc-badge')?.textContent).toBe('needs a newer version');
    expect(b.querySelector('.tc-badge [data-icon="plug-off"]')).not.toBeNull();
    expect(b.querySelector('.tc-node-row')?.textContent).toBe('');

    const c = card('c');
    expect(c.classList.contains('border-dashed')).toBe(true);
    expect(c.style.opacity).toBe('0.6');
    expect(c.querySelector('.tc-badge')?.textContent).toBe('not on this server');
    expect(c.querySelector('.tc-badge [data-icon="lock"]')).not.toBeNull();

    const d = card('d');
    expect(d.classList.contains('is-bypassed')).toBe(true);
    expect(d.querySelector('.tc-node-eyebrow')?.textContent).toBe('ActionSkipped here');
    expect(d.getAttribute('aria-label')).toBe('Action Encode video, skipped here');
    expect(d.querySelector('.tc-badge')).toBeNull();
    expect(d.style.opacity).toBe('');

    expect(card('e').querySelector('.tc-badge [data-icon="workflow"]')).not.toBeNull();
    expect(card('e').querySelector('.tc-badge')?.textContent).toBe('sub-workflow problem');
  });

  it('falls back to the kind icon and the type as title for an unknown node', async () => {
    const remux = catalogFixture.byType.get('core:remux') as NodeInfo;
    await show([
      tcNode(instance('x', 'acme:frobnicate'), {
        issues: [issue('x', 'UNKNOWN_NODE_TYPE', 'Unknown node type acme:frobnicate')],
      }),
      tcNode(instance('y', 'core:remux'), { def: { ...remux, icon: 'no-such-icon' }, x: 400 }),
    ]);
    const x = card('x');
    expect(x.querySelector('.tc-node-eyebrow')?.textContent).toBe('Unknown');
    expect(within(x).getByText('acme:frobnicate')).toBeTruthy();
    expect(x.getAttribute('aria-label')).toBe('Unknown acme:frobnicate, plugin missing');
    expect(x.querySelector('.tc-node-eyebrow [data-icon="plug-off"]')).not.toBeNull();
    // An icon name this build does not know draws the kind icon, never a blank.
    expect(card('y').querySelector('.tc-node-eyebrow [data-icon="kind-action"]')).not.toBeNull();
  });

  it('gives an unknown node a handle per connected port so the broken edge into it draws', async () => {
    const { container } = await show(
      [
        tcNode(instance('rm', 'core:remux')),
        tcNode(instance('x', 'acme:frobnicate'), {
          issues: [issue('x', 'UNKNOWN_NODE_TYPE', 'Unknown node type acme:frobnicate')],
          x: 400,
        }),
      ],
      [
        {
          id: 'rm-x',
          type: 'tc-edge',
          source: 'rm',
          sourceHandle: 'file',
          target: 'x',
          targetHandle: 'video',
          data: { portType: 'file', broken: true },
        },
      ],
    );
    expect([...card('x').querySelectorAll('.tc-port')].map((r) => r.textContent)).toEqual([
      'video',
    ]);
    expect(container.querySelector('[data-id="rm-x"] path.edge-broken')).not.toBeNull();
  });

  it('uses the label as title and Start/End colours and icons', async () => {
    await show([
      tcNode(instance('s', 'core:subworkflow-start')),
      tcNode(instance('r', 'core:reorder-tracks', { label: 'English first' }), { x: 400 }),
    ]);
    expect(card('s').classList.contains('kind-start')).toBe(true);
    expect(card('s').querySelector('[data-icon="log-in"]')).not.toBeNull();
    expect(within(card('r')).getByText('English first')).toBeTruthy();
  });

  it('renders the "+" button only on free outputs', async () => {
    const startConnectFrom = vi.fn();
    const actions = { ...DEFAULT_EDITOR_ACTIONS, readOnly: false, startConnectFrom };
    await show(
      [tcNode(instance('vi', 'core:video-is')), tcNode(instance('rm', 'core:remux'), { x: 400 })],
      [
        {
          id: 'vi-rm',
          type: 'tc-edge',
          source: 'vi',
          sourceHandle: 'pass',
          target: 'rm',
          targetHandle: 'file',
          data: { portType: 'file', broken: false },
        },
      ],
      actions,
    );
    expect(within(card('vi')).queryByRole('button', { name: 'Connect from Yes' })).toBeNull();
    const plus = within(card('vi')).getByRole('button', { name: 'Connect from No' });
    fireEvent.click(plus);
    expect(startConnectFrom).toHaveBeenCalledWith(
      'vi',
      expect.objectContaining<Partial<PortSpec>>({ id: 'else' }),
    );
    expect(within(card('rm')).getByRole('button', { name: 'Connect from File' })).toBeTruthy();
    // Inputs never get one.
    expect(within(card('rm')).getAllByRole('button')).toHaveLength(1);
  });

  it('hides the "+" button on a read-only canvas', async () => {
    await show([tcNode(instance('rm', 'core:remux'))]);
    expect(within(card('rm')).queryByRole('button')).toBeNull();
  });
  it('TcNode at compact zoom hides port labels and at icon zoom renders only the icon with an aria-label', async () => {
    const at = (zoom: number) => ({ defaultViewport: { x: 0, y: 0, zoom }, minZoom: 0.1 });
    const keep = tcNode(instance('keep', 'core:keep-languages'));

    await show([keep], [], undefined, at(0.5));
    let node = card('keep');
    expect(node.classList.contains('zoom-compact')).toBe(true);
    expect(within(node).getByText('Keep languages')).toBeTruthy();
    expect(node.querySelectorAll('.tc-port')).toHaveLength(2);
    expect(node.querySelector('.tc-port-in, .tc-port-out')).toBeNull();
    expect(node.querySelector('.tc-node-row')).toBeNull();
    // The on-node row's summary text only (schema defaults: en, keep original and untagged).
    expect(node.querySelector('.tc-node-summary')?.textContent).toBe('en · original · untagged');
    expect(within(node).queryByRole('button')).toBeNull();
    expect(handle('keep', 'file')).toBeTruthy();
    cleanup();

    await show([keep], [], undefined, at(0.3));
    node = card('keep');
    expect(node.classList.contains('zoom-icon')).toBe(true);
    expect(node.getAttribute('aria-label')).toBe('Keep languages');
    expect(node.textContent).toBe('');
    expect(node.querySelector('[data-icon="languages"]')).not.toBeNull();
    expect(node.querySelector('.tc-port')).toBeNull();
    // Edges still need their ends.
    expect(handle('keep', 'file')).toBeTruthy();
    expect(node.querySelectorAll('.react-flow__handle')).toHaveLength(3);
  });

  it('counter-scales the icon when zoomed out: bigger below the threshold than on the full card', async () => {
    const keep = tcNode(instance('keep', 'core:keep-languages'));
    const at = (zoom: number) => ({ defaultViewport: { x: 0, y: 0, zoom }, minZoom: 0.1 });
    const iconWidth = () =>
      Number(card('keep').querySelector('[data-icon="languages"]')?.getAttribute('width'));
    await show([keep], [], undefined, at(1));
    expect(iconWidth()).toBe(11);
    cleanup();
    await show([keep], [], undefined, at(0.5));
    expect(iconWidth()).toBeGreaterThan(11);
    cleanup();
    await show([keep], [], undefined, at(0.3));
    expect(iconWidth()).toBeGreaterThan(28);
    expect(iconWidth()).toBeLessThanOrEqual(49);
  });

  it('an unreachable card shows a dashed "not reachable" badge and says so in its name', async () => {
    await show([
      tcNode(instance('u', 'core:encode-video'), {
        issues: [issue('u', 'NODE_UNREACHABLE', 'Nothing leads here', 'warning')],
      }),
    ]);
    const u = card('u');
    expect(u.classList.contains('border-dashed')).toBe(true);
    expect(u.style.opacity).toBe('0.7');
    const badge = u.querySelector('.tc-badge');
    expect(badge?.classList.contains('tone-dashed')).toBe(true);
    expect(badge?.textContent).toBe('!not reachable');
    expect(u.getAttribute('aria-label')).toBe('Action Encode video, not reachable');
  });

  it("keeps the state word in the icon tile's name", async () => {
    const issues = [issue('enc', 'NODE_UNAVAILABLE', 'needs NVENC')];
    await show([tcNode(instance('enc', 'core:encode-video'), { issues })], [], undefined, {
      defaultViewport: { x: 0, y: 0, zoom: 0.3 },
      minZoom: 0.1,
    });
    const node = card('enc');
    expect(node.getAttribute('aria-label')).toBe('Encode video, not on this server');
    expect(node.classList.contains('border-dashed')).toBe(true);
  });

  it('shows the toolbar on the selected node and wires it to the editor actions', async () => {
    const actions: EditorActions = {
      ...DEFAULT_EDITOR_ACTIONS,
      readOnly: false,
      duplicate: vi.fn(),
      toggleBypass: vi.fn(),
      remove: vi.fn(),
    };
    const keep = { ...tcNode(instance('keep', 'core:keep-languages')), selected: true };
    await show([keep], [], actions);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bypass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(actions.duplicate).toHaveBeenCalledWith('keep');
    expect(actions.toggleBypass).toHaveBeenCalledWith('keep');
    expect(actions.remove).toHaveBeenCalledWith(['keep']);
    expect(
      (screen.getByRole('button', { name: 'Try this node' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('renders the on-node row bound to setSettings and focusField', async () => {
    const actions: EditorActions = {
      ...DEFAULT_EDITOR_ACTIONS,
      readOnly: false,
      setSettings: vi.fn(),
      focusField: vi.fn(),
    };
    const settings = { codec: 'hevc', quality: 24 };
    await show(
      [
        tcNode(instance('enc', 'core:encode-video', { settings })),
        tcNode(instance('keep', 'core:keep-languages', { settings: { languages: ['en', 'de'] } }), {
          x: 400,
        }),
      ],
      [],
      actions,
    );
    const input = within(card('enc')).getByRole('spinbutton', { name: 'Quality (CRF)' });
    fireEvent.change(input, { target: { value: '22' } });
    expect(actions.setSettings).toHaveBeenCalledWith('enc', { ...settings, quality: 22 });
    fireEvent.click(within(card('keep')).getByRole('button', { name: /^Languages to keep:/ }));
    expect(actions.focusField).toHaveBeenCalledWith('keep', 'languages');
    // The control sits in the card's on-node row slot.
    expect(card('enc').querySelector('.tc-node-row .tc-onnode')).not.toBeNull();
  });

  it('two selected cards get one selection toolbar: "Group 2 nodes" and "Delete 2 nodes"', async () => {
    const actions: EditorActions = {
      ...DEFAULT_EDITOR_ACTIONS,
      readOnly: false,
      groupSelection: vi.fn(),
      remove: vi.fn(),
    };
    await show(
      [
        { ...tcNode(instance('keep', 'core:keep-languages')), selected: true },
        { ...tcNode(instance('rm', 'core:remux'), { x: 400 }), selected: true },
        tcNode(instance('ro', 'core:replace-original'), { x: 800 }),
      ],
      [],
      actions,
    );
    expect(screen.getAllByRole('toolbar')).toHaveLength(1);
    expect(screen.queryByRole('toolbar', { name: 'Node actions' })).toBeNull();
    const bar = screen.getByRole('toolbar', { name: 'Selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Group 2 nodes' }));
    expect(actions.groupSelection).toHaveBeenCalledWith('Group');
    fireEvent.click(within(bar).getByRole('button', { name: 'Delete 2 nodes' }));
    expect(actions.remove).toHaveBeenCalledWith(['keep', 'rm']);
  });

  it('has no selection toolbar on a read-only canvas', async () => {
    await show([
      { ...tcNode(instance('keep', 'core:keep-languages')), selected: true },
      { ...tcNode(instance('rm', 'core:remux'), { x: 400 }), selected: true },
    ]);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('has no toolbar on a read-only canvas', async () => {
    await show([{ ...tcNode(instance('keep', 'core:keep-languages')), selected: true }]);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it("fades a card that can't take the dragged edge and glows the free matching input", async () => {
    const wired: Edge = {
      id: 'in-hs',
      type: 'tc-edge',
      source: 'in',
      sourceHandle: 'file',
      target: 'hs',
      targetHandle: 'file',
      data: { portType: 'file', broken: false },
    };
    await show(
      [
        tcNode(instance('keep', 'core:keep-languages')),
        tcNode(instance('keep2', 'core:keep-languages'), { x: 300 }),
        tcNode(instance('in', 'core:input-manual'), { x: 600 }),
        tcNode(instance('hs', 'core:has-stream'), { x: 900 }),
      ],
      [wired],
      undefined,
      { children: <DragFrom nodeId="keep" handleId="file" type="source" /> },
    );
    // The dragged handle (no class of its own: nothing styles it) and the rest of its own card.
    expect(card('keep').querySelector('.source[data-handleid="file"]')?.className).not.toMatch(
      /is-(source|compatible|incompatible)/,
    );
    expect(card('keep').querySelector('.target[data-handleid="file"]')?.className).toContain(
      'is-incompatible',
    );
    expect(card('keep').className).not.toContain('is-faded');
    // A free file input glows; the data input next to it does not; the card stays.
    const keep2In = card('keep2').querySelector('.target[data-handleid="file"]');
    expect(keep2In?.className).toContain('is-compatible');
    expect(card('keep2').querySelector('[data-handleid="language"]')?.className).toContain(
      'is-incompatible',
    );
    expect(card('keep2').className).not.toContain('is-faded');
    // No input at all, or only an occupied file input and a data input: the card fades.
    expect(card('in').className).toContain('is-faded');
    expect(card('hs').querySelector('.target[data-handleid="file"]')?.className).toContain(
      'is-incompatible',
    );
    expect(card('hs').className).toContain('is-faded');
  });

  it('nothing glows or fades while no connection is dragged', async () => {
    await show([
      tcNode(instance('keep', 'core:keep-languages')),
      tcNode(instance('in', 'core:input-manual'), { x: 300 }),
    ]);
    expect(document.querySelector('.is-compatible, .is-incompatible')).toBeNull();
    expect(document.querySelector('.is-faded')).toBeNull();
  });

  it('an unknown node never glows while dragging', async () => {
    await show(
      [
        tcNode(instance('keep', 'core:keep-languages')),
        tcNode(instance('gone', 'plugin:gone'), { x: 300, def: null }),
      ],
      [
        {
          id: 'keep-gone',
          type: 'tc-edge',
          source: 'keep',
          sourceHandle: 'file',
          target: 'gone',
          targetHandle: 'file',
          data: { portType: 'file', broken: true },
        },
      ],
      undefined,
      { children: <DragFrom nodeId="gone" handleId="file" type="target" /> },
    );
    expect(handle('gone', 'file').className).not.toMatch(/is-(source|compatible|incompatible)/);
    expect(card('keep').querySelector('.source[data-handleid="file"]')?.className).toContain(
      'is-incompatible',
    );
    expect(card('keep').className).toContain('is-faded');
  });

  it('fades a dimmed card once: the fade replaces its dim instead of multiplying it', async () => {
    const unavailable = issue('in', 'NODE_UNAVAILABLE', 'Not here');
    await show(
      [
        tcNode(instance('keep', 'core:keep-languages')),
        tcNode(instance('in', 'core:input-manual'), { x: 300, issues: [unavailable] }),
      ],
      [],
      undefined,
      { children: <DragFrom nodeId="keep" handleId="file" type="source" /> },
    );
    expect(card('in').className).toContain('is-faded');
    expect(card('in').style.opacity).toBe('');
  });
});

describe('TcNode: Run sub-workflow summary', () => {
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
  const list = [
    summaryOf('sub-lang', 'Language cleanup', 3),
    summaryOf('sub-audio', 'Audio fixes', 1),
  ];
  const run = (id: string, settings: NodeInstance['settings'], extra: Partial<NodeInstance> = {}) =>
    instance(id, 'core:run-subworkflow', { settings, ...extra });

  async function showRuns(
    nodes: TcNode[],
    workflows: WorkflowSummary[] | undefined,
    actions: EditorActions = DEFAULT_EDITOR_ACTIONS,
    props: Omit<Parameters<typeof renderFlow>[2], 'nodeTypes' | 'edgeTypes'> = {},
  ) {
    const types = {
      'tc-node': (p: NodeProps<TcNode>) => (
        <EditorActionsContext.Provider value={actions}>
          <SubworkflowsContext.Provider value={workflows}>
            <TcNodeCard {...p} />
          </SubworkflowsContext.Provider>
        </EditorActionsContext.Provider>
      ),
    };
    return renderFlow(nodes, [], { nodeTypes: types, edgeTypes, ...props });
  }

  it("shows each card's sub-workflow name and pinned version, a button that focuses the picker", async () => {
    const actions: EditorActions = {
      ...DEFAULT_EDITOR_ACTIONS,
      readOnly: false,
      focusField: vi.fn(),
    };
    await showRuns(
      [
        tcNode(run('r1', { subworkflowId: 'sub-lang', version: 2, overrides: {} })),
        tcNode(run('r2', { subworkflowId: 'sub-audio', version: 1, overrides: {} }), { x: 400 }),
      ],
      list,
      actions,
    );
    expect(card('r1').querySelector('.tc-node-row')?.textContent).toBe('Language cleanup · v2');
    expect(card('r2').querySelector('.tc-node-row')?.textContent).toBe('Audio fixes · v1');
    // The card's name carries the sub-workflow, so two Run cards are told apart.
    expect(card('r1').getAttribute('aria-label')).toBe(
      'Action Run sub-workflow, Language cleanup · v2',
    );
    fireEvent.click(
      within(card('r1')).getByRole('button', {
        name: 'Sub-workflow: Language cleanup · v2. Edit in the inspector',
      }),
    );
    expect(actions.focusField).toHaveBeenCalledWith('r1', 'subworkflowId');
  });

  it('reads "missing sub-workflow" for a deleted one, with the sub-workflow badge', async () => {
    await showRuns(
      [
        tcNode(run('gone', { subworkflowId: 'sub-deleted', version: 4, overrides: {} }), {
          issues: [issue('gone', 'SUBWORKFLOW_MISSING', 'Sub-workflow "sub-deleted" not found')],
        }),
        // Not in the list, no issue yet (the draft is not validated): still missing.
        tcNode(run('gone2', { subworkflowId: 'sub-deleted', version: 4, overrides: {} }), {
          x: 400,
        }),
      ],
      list,
    );
    const gone = card('gone');
    const row = gone.querySelector('.tc-node-row .tc-onnode');
    expect(row?.textContent).toBe('missing sub-workflow');
    expect(row?.classList.contains('is-missing')).toBe(true);
    expect(gone.querySelector('.tc-badge')?.textContent).toBe('sub-workflow problem');
    expect(gone.querySelector('.tc-badge [data-icon="workflow"]')).not.toBeNull();
    expect(gone.getAttribute('aria-label')).toBe(
      'Action Run sub-workflow, missing sub-workflow, sub-workflow problem',
    );
    expect(card('gone2').querySelector('.tc-node-row')?.textContent).toBe('missing sub-workflow');
  });

  it('a missing-sub-workflow issue wins even before the list has loaded', async () => {
    await showRuns(
      [
        tcNode(run('gone', { subworkflowId: 'sub-deleted', version: 4, overrides: {} }), {
          issues: [issue('gone', 'SUBWORKFLOW_MISSING', 'gone')],
        }),
      ],
      undefined,
    );
    expect(card('gone').querySelector('.tc-node-row')?.textContent).toBe('missing sub-workflow');
  });

  it('a pinned version that cannot run keeps its name and shows the sub-workflow badge', async () => {
    await showRuns(
      [
        tcNode(run('br', { subworkflowId: 'sub-lang', version: 2, overrides: {} }), {
          issues: [issue('br', 'SUBWORKFLOW_BROKEN', 'Sub-workflow version 2 is not valid')],
        }),
      ],
      list,
    );
    const br = card('br');
    expect(br.querySelector('.tc-node-row')?.textContent).toBe('Language cleanup · v2');
    expect(br.classList.contains('border-red')).toBe(true);
    expect(br.querySelector('.tc-badge')?.textContent).toBe('sub-workflow problem');
  });

  it('shows the pinned version alone while the list is not there, and nothing extra without a pick', async () => {
    await showRuns(
      [
        tcNode(run('r1', { subworkflowId: 'sub-lang', version: 2, overrides: {} })),
        tcNode(run('none', { overrides: {} }), {
          x: 400,
          issues: [
            {
              ...issue('none', 'INVALID_SETTINGS', NEEDS_A_SETTING),
              settingPath: 'subworkflowId',
            } as Issue,
          ],
        }),
      ],
      undefined,
    );
    expect(card('r1').querySelector('.tc-node-row')?.textContent).toBe('Sub-workflow · v2');
    expect(card('r1').getAttribute('aria-label')).toBe(
      'Action Run sub-workflow, Sub-workflow · v2',
    );
    expect(card('none').querySelector('.tc-node-row')?.textContent).toBe('needs a setting');
  });

  it('keeps the name at compact zoom (text only) and in the icon tile’s name', async () => {
    const at = (zoom: number) => ({ defaultViewport: { x: 0, y: 0, zoom }, minZoom: 0.1 });
    const node = tcNode(run('r1', { subworkflowId: 'sub-lang', version: 2, overrides: {} }));
    await showRuns([node], list, DEFAULT_EDITOR_ACTIONS, at(0.5));
    let c = card('r1');
    expect(c.querySelector('.tc-node-summary')?.textContent).toBe('Language cleanup · v2');
    expect(within(c).queryByRole('button')).toBeNull();
    cleanup();

    await showRuns([node], list, DEFAULT_EDITOR_ACTIONS, at(0.3));
    c = card('r1');
    expect(c.classList.contains('zoom-icon')).toBe(true);
    expect(c.textContent).toBe('');
    expect(c.getAttribute('aria-label')).toBe('Run sub-workflow, Language cleanup · v2');
  });

  it('a traced Run card shows the name above its trace row', async () => {
    const node = tcNode(run('r1', { subworkflowId: 'sub-lang', version: 2, overrides: {} }));
    node.data.trace = {
      status: 'done',
      reason: 'ran v2',
      port: 'file',
      findings: {},
      attempt: 1,
      retried: false,
      expandable: true,
    };
    await showRuns([node], list);
    const c = card('r1');
    expect(c.querySelector('.tc-node-summary')?.textContent).toBe('Language cleanup · v2');
    expect(c.querySelector('.tc-trace-row')).not.toBeNull();
    expect(c.getAttribute('aria-label')).toBe('Action Run sub-workflow, Language cleanup · v2');
  });
});
