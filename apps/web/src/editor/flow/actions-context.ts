import type { JsonValue } from '@transcoda/shared';
import { createContext, useContext } from 'react';
import type { PortSpec } from '../../hooks/useCatalog.ts';

/** What the canvas components may ask the editor page to do (provided by the page, Task 10). */
export interface EditorActions {
  readOnly: boolean;
  duplicate(id: string): void;
  toggleBypass(id: string): void;
  remove(ids: string[]): void;
  /** Phase B; null until the engine can try a single node. */
  tryNode: ((id: string) => void) | null;
  startConnectFrom(nodeId: string, port: PortSpec): void;
  setSettings(id: string, settings: JsonValue): void;
  focusField(id: string, key: string): void;
  groupSelection(name: string): void;
  /**
   * A group's collapse button (N10). Editable canvas: a graph op (`setGroupCollapsed`). Read-only
   * canvas: view-only local state applied with `withViewCollapse`, never written to the graph.
   */
  setGroupCollapsed(groupId: string, collapsed: boolean): void;
  /** Moves a node into a group (growing its box around the measured card) or out of it. */
  joinGroup(nodeId: string, groupId: string | undefined): void;
}

const noop = (): void => {};

/** Read-only and inert: keeps the components usable without a page (unit tests, previews). */
export const DEFAULT_EDITOR_ACTIONS: EditorActions = {
  readOnly: true,
  duplicate: noop,
  toggleBypass: noop,
  remove: noop,
  tryNode: null,
  startConnectFrom: noop,
  setSettings: noop,
  focusField: noop,
  groupSelection: noop,
  setGroupCollapsed: noop,
  joinGroup: noop,
};

export const EditorActionsContext = createContext<EditorActions>(DEFAULT_EDITOR_ACTIONS);

export function useEditorActions(): EditorActions {
  return useContext(EditorActionsContext);
}
