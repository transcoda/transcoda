import type { WorkflowActive, WorkflowSummary } from '@transcoda/contract';
import { hasErrors, type Issue, type WorkflowGraph } from '@transcoda/shared';
import { graphEquals } from './equality.ts';
import type { OpResult } from './graph-ops.ts';
import { type History, push, redo, undo } from './history.ts';

export interface EditorState {
  workflow: WorkflowSummary;
  /** `baseVersion` for the next save. */
  savedVersion: number;
  /**
   * When `savedVersion` was saved, for the header pill: the workflow's `updatedAt` at load (the
   * API has no per-version time on `get`), the client's clock after a save. A rename does not
   * move it.
   */
  savedAt: string;
  /** Last loaded or saved graph (the dirty check's base). */
  saved: WorkflowGraph;
  /** What the canvas shows. */
  draft: WorkflowGraph;
  /** From the last validate or save response. */
  issues: Issue[];
  /**
   * The graph `issues` describe (the loaded graph, the validated draft, the saved graph): a
   * setting whose value has changed since is not judged by the server's stale message.
   */
  issuesGraph: WorkflowGraph;
  /** The active version's load errors (the detail's `activeIssues`); [] when it can run. */
  activeIssues: Issue[];
  /** What the last save changed against its base; the banner shows it until the next apply or load. */
  lastChanges: string[];
  validating: boolean;
  selection: { nodes: string[]; edges: string[]; group?: string };
  history: History;
  readOnly: boolean;
  dirty: boolean;
  /** Seq of the latest validate request; older responses are ignored. */
  validateSeq: number;
  /** `<coalesce>:<key>` of the last apply, so consecutive same-key applies share an undo step. */
  coalesceKey: string | null;
}

export type EditorAction =
  | {
      type: 'loaded';
      workflow: WorkflowSummary;
      version: number;
      graph: WorkflowGraph;
      issues: Issue[];
      activeIssues: Issue[];
      readOnly: boolean;
    }
  | { type: 'apply'; result: OpResult; coalesce?: 'move' | 'settings'; key?: string }
  | { type: 'select'; nodes: string[]; edges: string[]; group?: string }
  | { type: 'validating'; seq: number }
  | { type: 'validated'; seq: number; issues: Issue[] }
  /** The validate call failed: the issues stay as they were. */
  | { type: 'validateFailed'; seq: number }
  | {
      type: 'saved';
      /** The graph that was sent; the draft may have moved on while the request was in flight. */
      graph: WorkflowGraph;
      version: number;
      issues: Issue[];
      /** Unchanged by the save; echoed by the server. */
      active: WorkflowActive;
      changes: string[];
      /** Client time of the response (the save output has no timestamp). */
      savedAt: string;
    }
  /** "Save over it" after VERSION_CONFLICT: the next save is based on the newer version. */
  | { type: 'rebase'; version: number }
  /** Rename, activate and deactivate results. */
  | { type: 'workflow'; patch: Partial<WorkflowSummary> }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'setReadOnly'; readOnly: boolean };

/** No workflow loaded yet; the first action is always `loaded`. */
export function initialEditorState(): EditorState | null {
  return null;
}

/** Keeps only selected ids that still exist in `g` (after undo/redo). */
function pruneSelection(sel: EditorState['selection'], g: WorkflowGraph): EditorState['selection'] {
  const nodes = new Set(g.nodes.map((n) => n.id));
  const edges = new Set(g.edges.map((e) => e.id));
  const groups = new Set(g.groups.map((gr) => gr.id));
  return {
    nodes: sel.nodes.filter((id) => nodes.has(id)),
    edges: sel.edges.filter((id) => edges.has(id)),
    ...(sel.group !== undefined && groups.has(sel.group) ? { group: sel.group } : {}),
  };
}

function withDraft(s: EditorState, draft: WorkflowGraph, history: History): EditorState {
  return { ...s, draft, history, dirty: !graphEquals(draft, s.saved) };
}

/** Null until the first `loaded`; every other action leaves a null state as it is. */
export function editorReducer(s: EditorState | null, a: EditorAction): EditorState | null {
  if (a.type === 'loaded') return loadedState(a);
  return s && reduce(s, a);
}

function loadedState(a: Extract<EditorAction, { type: 'loaded' }>): EditorState {
  return {
    workflow: a.workflow,
    savedVersion: a.version,
    savedAt: a.workflow.updatedAt,
    saved: a.graph,
    draft: a.graph,
    issues: a.issues,
    issuesGraph: a.graph,
    activeIssues: a.activeIssues,
    lastChanges: [],
    validating: false,
    selection: { nodes: [], edges: [] },
    history: { past: [], future: [] },
    readOnly: a.readOnly,
    dirty: false,
    validateSeq: 0,
    coalesceKey: null,
  };
}

function reduce(s: EditorState, a: Exclude<EditorAction, { type: 'loaded' }>): EditorState {
  switch (a.type) {
    case 'apply': {
      // A refusal is shown as a toast by the page; read-only drafts never change.
      if (!a.result.ok || s.readOnly) return s;
      const graph = a.result.graph;
      // By reference first: a drag emits many applies and most ops return new objects anyway.
      if (graph === s.draft || graphEquals(graph, s.draft)) return s;
      const key = a.coalesce && a.key !== undefined ? `${a.coalesce}:${a.key}` : null;
      const joins = key !== null && key === s.coalesceKey;
      const history = joins ? s.history : push(s.history, s.draft);
      return { ...withDraft(s, graph, history), lastChanges: [], coalesceKey: key };
    }
    case 'select':
      return {
        ...s,
        selection: {
          nodes: a.nodes,
          edges: a.edges,
          ...(a.group !== undefined ? { group: a.group } : {}),
        },
        coalesceKey: null,
      };
    case 'validating':
      if (a.seq < s.validateSeq) return s;
      return { ...s, validating: true, validateSeq: a.seq };
    case 'validated':
      if (a.seq < s.validateSeq) return s;
      // Validation answers only for the current draft (useValidation drops older ones).
      return {
        ...s,
        validating: false,
        validateSeq: a.seq,
        issues: a.issues,
        issuesGraph: s.draft,
      };
    case 'validateFailed':
      if (a.seq < s.validateSeq) return s;
      return { ...s, validating: false, validateSeq: a.seq };
    case 'saved': {
      const errorCount = a.issues.filter((i) => i.severity === 'error').length;
      // The response's issues describe the sent graph; after an edit made during the save the
      // draft's own validation (already queued) owns `issues`.
      const current = graphEquals(s.draft, a.graph);
      return {
        ...s,
        saved: a.graph,
        savedVersion: a.version,
        savedAt: a.savedAt,
        issues: current ? a.issues : s.issues,
        issuesGraph: current ? a.graph : s.issuesGraph,
        dirty: !current,
        lastChanges: a.changes,
        coalesceKey: null,
        workflow: {
          ...s.workflow,
          currentVersion: a.version,
          active: a.active,
          valid: !hasErrors(a.issues),
          errorCount,
        },
      };
    }
    case 'rebase':
      return {
        ...s,
        savedVersion: a.version,
        workflow: { ...s.workflow, currentVersion: a.version },
      };
    case 'workflow': {
      // Deactivating, or activating a version that can run, leaves nothing to report about the active version.
      const cleared = 'active' in a.patch && (a.patch.active === null || a.patch.active.runnable);
      return {
        ...s,
        workflow: { ...s.workflow, ...a.patch },
        ...(cleared ? { activeIssues: [] } : {}),
      };
    }
    case 'undo':
    case 'redo': {
      if (s.readOnly) return s;
      const step = a.type === 'undo' ? undo(s.history, s.draft) : redo(s.history, s.draft);
      if (!step) return s;
      return {
        ...withDraft(s, step.graph, step.history),
        selection: pruneSelection(s.selection, step.graph),
        coalesceKey: null,
      };
    }
    case 'setReadOnly':
      return { ...s, readOnly: a.readOnly };
  }
}
