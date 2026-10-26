import type { WorkflowGraph } from '@transcoda/shared';
import { useEffect, useRef } from 'react';
import type { Catalog } from '../../hooks/useCatalog.ts';
import type { EditorState } from '../model/editor-state.ts';

export interface EditorKeyActions {
  selectNode(id: string): void;
  undo(): void;
  redo(): void;
  /** Removes the current selection (nodes, edges, group). */
  remove(): void;
  save(): void;
  openSearch(filter?: string): void;
  /** Starts a connection from the node's first free output (NodeSearch filtered by its type). */
  connectFrom(nodeId: string): void;
}

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"]';
const CONTROL = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
].join(', ');

/**
 * Graph order for Tab: by x, then y (the order a reader follows a left-to-right flow), not React
 * Flow's DOM order (insertion order); nodes hidden in a collapsed group are skipped.
 */
function tabOrder(g: WorkflowGraph): string[] {
  const collapsed = new Set(g.groups.filter((gr) => gr.collapsed).map((gr) => gr.id));
  return g.nodes
    .filter((n) => n.groupId === undefined || !collapsed.has(n.groupId))
    .slice()
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
    .map((n) => n.id);
}

/**
 * The editor's keyboard path (design "Keyboard path as drawn"), on `window`:
 * Tab / Shift+Tab with a node selected and focus on the canvas → next / previous node in graph
 * order (no wrap: at either end Tab leaves the canvas natively); "c" → connect from the selected node; "/" → node search; Delete / Backspace → remove the
 * selection (the only delete binding: React Flow's `deleteKeyCode` is off); Mod+Z / Shift+Mod+Z /
 * Mod+Y → undo / redo; Mod+S → save. Ignored while focus is in a field or a dialog; Delete,
 * Backspace and "c" are also ignored on buttons and links (they are not the canvas). Mod+S works
 * from fields too, so the browser's own save dialog never opens over the editor.
 */
export function useEditorKeys(opts: {
  enabled: boolean;
  graph: WorkflowGraph;
  selection: EditorState['selection'];
  catalog: Catalog | null;
  actions: EditorKeyActions;
}): void {
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    if (!opts.enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const { graph, selection, catalog, actions } = latest.current;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(DIALOG)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (mod && !e.altKey && key === 's') {
        e.preventDefault();
        actions.save();
        return;
      }
      if (target?.closest(FIELD)) return;

      if (mod && !e.altKey) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) actions.redo();
          else actions.undo();
        } else if (key === 'y') {
          e.preventDefault();
          actions.redo();
        }
        return;
      }
      if (e.altKey) return;
      const onControl = Boolean(target?.closest(CONTROL));

      if (key === 'Tab') {
        const current = selection.nodes[0];
        const onCanvas =
          target !== null &&
          target.closest('.react-flow') !== null &&
          target.closest('.tc-toolbar') === null;
        if (current === undefined || !onCanvas || onControl) return;
        const order = tabOrder(graph);
        const at = order.indexOf(current);
        if (at < 0) return;
        // No wrap: past the last node (or before the first) Tab leaves the canvas natively.
        const next = order[e.shiftKey ? at - 1 : at + 1];
        if (next === undefined) return;
        e.preventDefault();
        actions.selectNode(next);
        return;
      }
      if (e.shiftKey && key !== '/') return;
      if (key === 'Delete' || key === 'Backspace') {
        if (onControl) return;
        if (selection.nodes.length + selection.edges.length === 0 && !selection.group) return;
        e.preventDefault();
        actions.remove();
      } else if (key === '/') {
        e.preventDefault();
        actions.openSearch();
      } else if (key === 'c') {
        const only = selection.nodes.length === 1 ? selection.nodes[0] : undefined;
        if (onControl || only === undefined || catalog === null) return;
        e.preventDefault();
        actions.connectFrom(only);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [opts.enabled]);
}
