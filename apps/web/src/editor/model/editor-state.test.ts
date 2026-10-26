import { act, renderHook } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue } from '@transcoda/shared';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { catalogFixture as catalog } from '../../test/fixtures/catalog.ts';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import {
  type EditorAction,
  type EditorState,
  editorReducer,
  initialEditorState,
} from './editor-state.ts';
import { addNode, moveNodes, setLabel, setSettings } from './graph-ops.ts';
import { tidyUp } from './layout.ts';

const summary: WorkflowSummary = {
  id: 'wf1',
  name: 'TV cleanup',
  kind: 'workflow',
  active: {
    version: 7,
    runnable: true,
    activatedAt: '2026-10-02T10:00:00.000Z',
    activatedBy: 'u1',
  },
  currentVersion: 7,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  usedBy: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};

const warning: Issue = {
  severity: 'warning',
  code: 'NODE_UNREACHABLE',
  message: 'Unreachable',
  nodeId: 'ro',
};
const trigger: Issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'No trigger' };

function load(): EditorAction {
  return {
    type: 'loaded',
    workflow: summary,
    version: 7,
    graph: chainMainReplace(),
    issues: [warning],
    activeIssues: [],
    readOnly: false,
  };
}

/** One reducer step on a loaded state (the reducer only returns null for a null state). */
function step(s: EditorState, a: EditorAction): EditorState {
  const next = editorReducer(s, a);
  if (!next) throw new Error('state became null');
  return next;
}

function loaded(): EditorState {
  const s = editorReducer(initialEditorState(), load());
  if (!s) throw new Error('not loaded');
  return s;
}

function run(s: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(step, s);
}

const move = (s: EditorState, id: string, x: number): EditorAction => ({
  type: 'apply',
  result: moveNodes(s.draft, [{ id, position: { x, y: 0 } }]),
  coalesce: 'move',
  key: id,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

describe('editorReducer', () => {
  it('starts empty and loads a clean state', () => {
    expect(initialEditorState()).toBeNull();
    const s = loaded();
    expect(s).toMatchObject({
      workflow: summary,
      savedVersion: 7,
      issues: [warning],
      validating: false,
      selection: { nodes: [], edges: [] },
      history: { past: [], future: [] },
      readOnly: false,
      dirty: false,
      validateSeq: 0,
    });
    expect(s.draft).toBe(s.saved);
  });

  it('tidy up after a drag is its own undo step and marks the draft unsaved', () => {
    const s = loaded();
    const dragged = run(s, move(s, 'keep', 300), move(s, 'keep', 900));
    const scrambled = run(dragged, move(dragged, 'ro', 40));
    const tidied = step(scrambled, {
      type: 'apply',
      result: tidyUp(scrambled.draft, { catalog }),
    });
    expect(tidied.dirty).toBe(true);
    expect(tidied.history.past).toHaveLength(scrambled.history.past.length + 1);
    expect(step(tidied, { type: 'undo' }).draft).toEqual(scrambled.draft);
  });

  it('tidy up changes nothing read-only', () => {
    const s = { ...loaded(), readOnly: true };
    const moved = moveNodes(s.draft, [{ id: 'keep', position: { x: 900, y: 500 } }]);
    if (!moved.ok) throw new Error('refused');
    expect(
      step({ ...s, draft: moved.graph }, { type: 'apply', result: tidyUp(moved.graph) }).draft,
    ).toBe(moved.graph);
  });

  it('apply pushes history and sets dirty; a refused op changes nothing', () => {
    const s = loaded();
    const next = step(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep EN') });
    expect(next.dirty).toBe(true);
    expect(next.history.past).toEqual([s.draft]);
    expect(next.draft.nodes.find((n) => n.id === 'keep')?.label).toBe('Keep EN');
    expect(next.saved).toBe(s.saved);

    const refused = step(next, {
      type: 'apply',
      result: setLabel(next.draft, 'gone', 'x'),
    });
    expect(refused).toBe(next);

    // Applying back to the saved graph makes it clean again (structural equality).
    const back = step(next, {
      type: 'apply',
      result: setLabel(next.draft, 'keep', undefined),
    });
    expect(back.dirty).toBe(false);
    expect(back.history.past).toHaveLength(2);

    // An op that changes nothing adds no undo step.
    expect(step(s, move(s, 'in', 0))).toBe(s);
  });

  it('consecutive coalesced moves of the same node make one undo step', () => {
    let s = loaded();
    s = run(s, move(s, 'keep', 300));
    s = run(s, move(s, 'keep', 320));
    s = run(s, move(s, 'keep', 340));
    expect(s.history.past).toHaveLength(1);
    // A different node starts a new step, as does a non-coalesced op in between.
    s = run(s, move(s, 'in', 20));
    expect(s.history.past).toHaveLength(2);
    s = run(s, { type: 'apply', result: setLabel(s.draft, 'in', 'Start') });
    s = run(s, move(s, 'in', 40));
    expect(s.history.past).toHaveLength(4);
    // Settings coalesce per key too, and a selection change ends the run.
    const set = (st: EditorState, v: string): EditorAction => ({
      type: 'apply',
      result: setSettings(st.draft, 'keep', { languages: [v] }),
      coalesce: 'settings',
      key: 'keep',
    });
    s = run(s, set(s, 'd'));
    s = run(s, set(s, 'de'));
    expect(s.history.past).toHaveLength(5);
    s = run(s, { type: 'select', nodes: ['keep'], edges: [] });
    s = run(s, set(s, 'deu'));
    expect(s.history.past).toHaveLength(6);

    // One undo returns the three coalesced keep moves at once.
    const first = loaded();
    let m = run(first, move(first, 'keep', 300));
    m = run(m, move(m, 'keep', 340));
    m = run(m, { type: 'undo' });
    expect(m.draft).toEqual(first.draft);
    expect(m.dirty).toBe(false);
    m = run(m, { type: 'redo' });
    expect(m.draft.nodes.find((n) => n.id === 'keep')?.position).toEqual({ x: 340, y: 0 });
    expect(m.dirty).toBe(true);
    // Undo with an empty stack is a no-op.
    expect(run(first, { type: 'undo' })).toBe(first);
    expect(run(first, { type: 'redo' })).toBe(first);
  });

  it('undo drops selected ids that no longer exist', () => {
    let s = loaded();
    const added = addNode(s.draft, 'core:remux', { x: 0, y: 200 }, catalog, { id: 'mux' });
    s = run(s, { type: 'apply', result: added });
    s = run(s, { type: 'select', nodes: ['mux', 'keep'], edges: ['in-keep'], group: 'g' });
    s = run(s, { type: 'undo' });
    expect(s.selection).toEqual({ nodes: ['keep'], edges: ['in-keep'] });
  });

  it('validated responses older than the latest request are ignored', () => {
    let s = loaded();
    s = run(s, { type: 'validating', seq: 1 }, { type: 'validating', seq: 2 });
    expect(s).toMatchObject({ validating: true, validateSeq: 2 });
    const stale = run(s, { type: 'validated', seq: 1, issues: [trigger] });
    expect(stale).toBe(s);
    // A `validating` that arrives late (lower seq) does not move the latest request back.
    expect(run(s, { type: 'validating', seq: 1 })).toBe(s);
    s = run(s, { type: 'validated', seq: 2, issues: [trigger] });
    expect(s).toMatchObject({ validating: false, issues: [trigger] });
  });

  it('issuesGraph is the graph the issues describe: loaded, validated draft, saved graph', () => {
    let s = loaded();
    expect(s.issuesGraph).toBe(s.draft);
    const edited = run(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep EN') });
    // An edit alone does not move it; the next validation does.
    expect(edited.issuesGraph).toBe(s.draft);
    s = run(edited, { type: 'validated', seq: 1, issues: [trigger] });
    expect(s.issuesGraph).toBe(edited.draft);
    const sent = s.draft;
    const later = run(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep DE') });
    const saved = run(later, {
      type: 'saved',
      graph: sent,
      version: 4,
      issues: [],
      active: summary.active,
      changes: [],
      savedAt: summary.updatedAt,
    });
    // Saved while the draft had moved on: the response's issues are not taken, nor their graph.
    expect(saved.issuesGraph).toBe(sent);
    expect(saved.issues).toEqual([trigger]);
  });

  it('validateFailed clears validating for the latest request and keeps the issues', () => {
    let s = run(loaded(), { type: 'validated', seq: 1, issues: [trigger] });
    s = run(s, { type: 'validating', seq: 2 });
    expect(run(s, { type: 'validateFailed', seq: 1 })).toBe(s);
    s = run(s, { type: 'validateFailed', seq: 2 });
    expect(s).toMatchObject({ validating: false, validateSeq: 2, issues: [trigger] });
  });

  it('saved sets saved=draft, savedVersion, issues and active/changes from the response, and keeps activeIssues; dirty becomes false', () => {
    let s = loaded();
    s = run(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep EN') });
    s = run(s, {
      type: 'saved',
      graph: s.draft,
      version: 8,
      issues: [trigger],
      active: summary.active,
      changes: ['Added Encode video'],
      savedAt: '2026-10-16T12:00:00.000Z',
    });
    expect(s.saved).toBe(s.draft);
    expect(s.savedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(s).toMatchObject({
      savedVersion: 8,
      issues: [trigger],
      dirty: false,
      lastChanges: ['Added Encode video'],
      workflow: {
        active: summary.active,
        currentVersion: 8,
        valid: false,
        errorCount: 1,
      },
    });
    // Undo after a save still works against the saved graph; the next change clears the notice.
    s = run(s, { type: 'undo' });
    expect(s.dirty).toBe(true);
    s = run(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep FR') });
    expect(s.lastChanges).toEqual([]);
  });

  it('an edit made while the save was in flight stays dirty', () => {
    let s = loaded();
    s = run(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep EN') });
    const sent = s.draft;
    s = run(s, { type: 'apply', result: setLabel(s.draft, 'ro', 'Swap') });
    s = run(s, { type: 'validated', seq: 1, issues: [trigger] });
    s = run(s, {
      type: 'saved',
      graph: sent,
      version: 8,
      issues: [],
      active: summary.active,
      changes: [],
      savedAt: '2026-10-16T12:00:00.000Z',
    });
    expect(s.saved).toBe(sent);
    expect(s.dirty).toBe(true);
    // The response's issues describe the sent graph, not the draft: validation's issues stay.
    expect(s.issues).toEqual([trigger]);
    expect(s.draft.nodes.find((n) => n.id === 'ro')?.label).toBe('Swap');
  });

  it('loaded stores activeIssues; an activate patch with runnable true clears them', () => {
    const broken: Issue = { severity: 'error', code: 'TRIGGER_COUNT', message: 'Node missing' };
    let s = step(loaded(), {
      ...(load() as Extract<EditorAction, { type: 'loaded' }>),
      activeIssues: [broken],
    });
    expect(s.activeIssues).toEqual([broken]);
    const stillBroken = { ...summary.active, version: 6, runnable: false } as NonNullable<
      WorkflowSummary['active']
    >;
    s = run(s, { type: 'workflow', patch: { active: stillBroken } });
    expect(s.activeIssues).toEqual([broken]);
    s = run(s, {
      type: 'workflow',
      patch: { active: { ...stillBroken, version: 7, runnable: true } },
    });
    expect(s.activeIssues).toEqual([]);
    expect(s.workflow.active?.version).toBe(7);
    s = step(loaded(), {
      ...(load() as Extract<EditorAction, { type: 'loaded' }>),
      activeIssues: [broken],
    });
    s = run(s, { type: 'workflow', patch: { active: null } });
    expect(s.activeIssues).toEqual([]);
  });

  it('a null state stays null until loaded and the reducer plugs into useReducer', () => {
    const select: EditorAction = { type: 'select', nodes: [], edges: [] };
    expect(editorReducer(null, select)).toBeNull();
    expect(editorReducer(null, { type: 'undo' })).toBeNull();
    const { result } = renderHook(() => useReducer(editorReducer, initialEditorState()));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1](load()));
    expect(result.current[0]?.savedVersion).toBe(7);
  });

  it('never mutates deep-frozen state or graphs', () => {
    const s = deepFreeze(loaded());
    const added = addNode(s.draft, 'core:remux', { x: 0, y: 200 }, catalog, { id: 'mux' });
    const actions: EditorAction[] = [
      { type: 'apply', result: added },
      { type: 'apply', result: moveNodes(s.draft, [{ id: 'keep', position: { x: 9, y: 9 } }]) },
      { type: 'apply', result: setSettings(s.draft, 'keep', { languages: ['de'] }) },
      { type: 'apply', result: setLabel(s.draft, 'in', 'Start'), coalesce: 'settings', key: 'in' },
      { type: 'select', nodes: ['keep'], edges: [] },
      { type: 'validating', seq: 3 },
      { type: 'validated', seq: 3, issues: [trigger] },
      { type: 'undo' },
      { type: 'redo' },
      { type: 'rebase', version: 9 },
      { type: 'workflow', patch: { name: 'x' } },
      {
        type: 'saved',
        graph: s.draft,
        version: 8,
        issues: [],
        active: summary.active,
        changes: [],
        savedAt: '2026-10-16T12:00:00.000Z',
      },
      { type: 'setReadOnly', readOnly: true },
    ];
    let cur: EditorState = s;
    for (const a of actions) cur = deepFreeze(step(cur, a));
    expect(cur.readOnly).toBe(true);
    expect(s.draft).toEqual(chainMainReplace());
  });

  it('rebase, workflow patch and read-only', () => {
    let s = loaded();
    s = run(s, { type: 'apply', result: setLabel(s.draft, 'keep', 'Keep EN') });
    s = run(s, { type: 'rebase', version: 9 });
    expect(s).toMatchObject({ savedVersion: 9, dirty: true });
    expect(s.workflow.currentVersion).toBe(9);
    const savedAt = s.savedAt;
    s = run(s, {
      type: 'workflow',
      patch: { name: 'Cleanup', active: null, updatedAt: '2026-10-20T00:00:00.000Z' },
    });
    expect(s.workflow).toMatchObject({ name: 'Cleanup', active: null, id: 'wf1' });
    // A rename moves the workflow's updatedAt, never the version's saved time.
    expect(s.savedAt).toBe(savedAt);
    s = run(s, { type: 'setReadOnly', readOnly: true });
    expect(s.readOnly).toBe(true);
    const ro = s;
    expect(run(ro, { type: 'apply', result: setLabel(ro.draft, 'keep', 'x') })).toBe(ro);
    expect(run(ro, { type: 'undo' })).toBe(ro);
  });
});
