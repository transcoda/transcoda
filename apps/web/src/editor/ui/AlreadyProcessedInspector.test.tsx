import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import {
  ALREADY_PROCESSED_TYPE,
  type JsonValue,
  type NodeInstance,
  type WorkflowGraph,
} from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeStateFor } from '../model/issues.ts';
import { AlreadyProcessedInspector } from './AlreadyProcessedInspector.tsx';
import type { ApplyOptions, GraphOp } from './Canvas.tsx';

afterEach(cleanup);

const summaryOf = (
  id: string,
  name: string,
  currentVersion: number,
  kind: WorkflowSummary['kind'] = 'workflow',
): WorkflowSummary => ({
  id,
  name,
  kind,
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

const workflows = [
  summaryOf('w-self', 'Movies', 4),
  summaryOf('w-save', 'Save space', 3),
  summaryOf('w-audio', 'Audio fixes', 2),
  summaryOf('s-lang', 'Language cleanup', 5, 'subworkflow'),
];

function renderNode(settings: JsonValue, opts: { selfId?: string; readOnly?: boolean } = {}) {
  const instance: NodeInstance = {
    id: 'ap',
    type: ALREADY_PROCESSED_TYPE,
    typeVersion: 1,
    settings,
    position: { x: 0, y: 0 },
  };
  const dispatch = vi.fn((_op: GraphOp, _opts?: ApplyOptions) => true);
  const graph: WorkflowGraph = {
    formatVersion: 2,
    kind: 'workflow',
    nodes: [instance],
    edges: [],
    groups: [],
  };
  render(
    <AlreadyProcessedInspector
      instance={instance}
      state={nodeStateFor(instance.id, [])}
      workflows={workflows}
      selfId={opts.selfId ?? 'w-self'}
      readOnly={opts.readOnly ?? false}
      dispatch={dispatch}
    />,
  );
  const lastSettings = (): JsonValue => {
    const op = dispatch.mock.calls.at(-1)?.[0];
    if (!op) throw new Error('nothing dispatched');
    const result = op(graph);
    if (!result.ok) throw new Error(result.refusal.reason);
    return result.graph.nodes[0]?.settings ?? null;
  };
  return { dispatch, lastSettings };
}

const workflowPicker = () =>
  screen.getByRole('combobox', { name: 'Workflow' }) as HTMLSelectElement;
const versionPicker = () => screen.getByRole('combobox', { name: 'Version' }) as HTMLSelectElement;
const names = (select: HTMLSelectElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('AlreadyProcessedInspector', () => {
  it('defaults to This workflow and Any version; offers the other workflows by name, never sub-workflows', () => {
    renderNode({});
    expect(workflowPicker().value).toBe('');
    expect(names(workflowPicker())).toEqual(['This workflow', 'Audio fixes', 'Save space']);
    expect(versionPicker().value).toBe('');
    // This workflow's own versions, newest first.
    expect(names(versionPicker())).toEqual(['Any version', 'v4', 'v3', 'v2', 'v1']);
  });

  it('picking a workflow stores its id and starts over at any version; its versions follow', () => {
    const { lastSettings } = renderNode({ version: 2 });
    fireEvent.change(workflowPicker(), { target: { value: 'w-save' } });
    expect(lastSettings()).toEqual({ workflowId: 'w-save' });
  });

  it('a version stores the number; Any version removes it; This workflow removes the id', () => {
    const { lastSettings } = renderNode({ workflowId: 'w-save' });
    expect(names(versionPicker())).toEqual(['Any version', 'v3', 'v2', 'v1']);
    fireEvent.change(versionPicker(), { target: { value: '2' } });
    expect(lastSettings()).toEqual({ workflowId: 'w-save', version: 2 });
    cleanup();
    const again = renderNode({ workflowId: 'w-save', version: 2 });
    expect(versionPicker().value).toBe('2');
    fireEvent.change(versionPicker(), { target: { value: '' } });
    expect(again.lastSettings()).toEqual({ workflowId: 'w-save' });
    fireEvent.change(workflowPicker(), { target: { value: '' } });
    expect(again.lastSettings()).toEqual({});
  });

  it('a workflow that no longer exists stays selected and says so', () => {
    renderNode({ workflowId: 'w-gone', version: 7 });
    expect(workflowPicker().value).toBe('w-gone');
    expect(names(workflowPicker())).toContain('w-gone (no longer exists)');
    expect(versionPicker().value).toBe('7');
  });

  it('in a sub-workflow, This workflow has no known versions: a number to type', () => {
    const { lastSettings } = renderNode({}, { selfId: 's-lang' });
    const input = screen.getByRole('spinbutton', { name: 'Version' }) as HTMLInputElement;
    expect(input.placeholder).toBe('Any version');
    fireEvent.change(input, { target: { value: '3' } });
    expect(lastSettings()).toEqual({ version: 3 });
  });
});
