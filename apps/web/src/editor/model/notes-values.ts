import {
  type Group,
  type JsonValue,
  MAX_GRAPH_GROUPS,
  MAX_NOTE_LENGTH,
  MAX_SHARED_VALUES,
  type NodeInstance,
  type SharedValue,
  syncLinkedSettings,
  valueNamed,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { OpResult, Position } from './graph-ops.ts';

/**
 * The values card's id on the canvas and in `selection.group` (the card is selected like a group).
 * `~` is outside the graph's id pattern, so no real group can have it.
 */
export const VALUES_CARD_ID = '~values';

/** A new note's frame: an empty group that only holds its note. */
export const NOTE_SIZE = { width: 320, height: 180 } as const;
export const DEFAULT_NOTE_NAME = 'Note';
/** How far above the topmost card the values card lands when the first value is made. */
const VALUES_GAP = 240;

const ok = (graph: WorkflowGraph): OpResult => ({ ok: true, graph });
const refuse = (reason: string): OpResult => ({ ok: false, refusal: { reason } });
const VALUE_MISSING = 'That value no longer exists';

/** A frame with no nodes in it and an empty note, at `position`. */
export function addNote(g: WorkflowGraph, position: Position, id: string): OpResult {
  if (g.groups.length >= MAX_GRAPH_GROUPS) {
    return refuse(`A workflow can have at most ${MAX_GRAPH_GROUPS} groups`);
  }
  const group: Group = {
    id,
    name: DEFAULT_NOTE_NAME,
    collapsed: false,
    position: { x: position.x, y: position.y },
    size: { ...NOTE_SIZE },
    note: '',
  };
  return ok({ ...g, groups: [...g.groups, group] });
}

/** The frame's Markdown note; an empty text removes it. */
export function setGroupNote(g: WorkflowGraph, groupId: string, note: string): OpResult {
  if (!g.groups.some((gr) => gr.id === groupId)) return refuse('That group no longer exists');
  if (note.length > MAX_NOTE_LENGTH) {
    return refuse(`A note can be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return ok({
    ...g,
    groups: g.groups.map((gr) => {
      if (gr.id !== groupId) return gr;
      if (note !== '') return { ...gr, note };
      const { note: _, ...rest } = gr;
      return rest;
    }),
  });
}

/** `name`, or `name 2`, `name 3`… when the graph already has a value called that. */
export function uniqueValueName(g: WorkflowGraph, name: string): string {
  if (!valueNamed(g, name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!valueNamed(g, candidate)) return candidate;
  }
}

/** Where the values card goes when it is first needed: above the leftmost, topmost cards. */
function cardSpot(g: WorkflowGraph): Position {
  if (g.nodes.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...g.nodes.map((n) => n.position.x)),
    y: Math.min(...g.nodes.map((n) => n.position.y)) - VALUES_GAP,
  };
}

function withEntries(g: WorkflowGraph, entries: SharedValue[]): WorkflowGraph {
  return { ...g, values: { position: g.values?.position ?? cardSpot(g), entries } };
}

/** Sets each node's links through `fn`; a node left without links loses the key. */
function mapLinks(
  g: WorkflowGraph,
  fn: (links: Record<string, string>, n: NodeInstance) => Record<string, string>,
): WorkflowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      if (!n.links) return n;
      const links = fn(n.links, n);
      if (links === n.links) return n;
      if (Object.keys(links).length > 0) return { ...n, links };
      const { links: _, ...rest } = n;
      return rest;
    }),
  };
}

/** The card with no values yet (it is also made by the first `addValue`). */
export function addValuesCard(g: WorkflowGraph, position: Position): OpResult {
  if (g.values) return refuse('This workflow already has a values card');
  return ok({ ...g, values: { position: { x: position.x, y: position.y }, entries: [] } });
}

export function moveValuesCard(g: WorkflowGraph, position: Position): OpResult {
  if (!g.values) return ok(g);
  return ok({ ...g, values: { ...g.values, position: { x: position.x, y: position.y } } });
}

/** Removes the card and every value on it; linked settings keep their current copies. */
export function removeValuesCard(g: WorkflowGraph): OpResult {
  const { values: _, ...rest } = mapLinks(g, () => ({}));
  return ok(rest);
}

export function addValue(
  g: WorkflowGraph,
  name: string,
  schema: JsonValue,
  value: JsonValue,
): OpResult {
  const trimmed = name.trim();
  if (trimmed === '') return refuse('A value needs a name');
  if (valueNamed(g, trimmed)) return refuse(`There is already a value called ${trimmed}`);
  const entries = g.values?.entries ?? [];
  if (entries.length >= MAX_SHARED_VALUES) {
    return refuse(`A workflow can have at most ${MAX_SHARED_VALUES} values`);
  }
  return ok(withEntries(g, [...entries, { name: trimmed, schema, value }]));
}

/** The value's new content, copied into every setting that follows it. */
export function setValue(g: WorkflowGraph, name: string, value: JsonValue): OpResult {
  if (!valueNamed(g, name)) return refuse(VALUE_MISSING);
  const entries = (g.values?.entries ?? []).map((v) => (v.name === name ? { ...v, value } : v));
  return ok(syncLinkedSettings(withEntries(g, entries)));
}

export function renameValue(g: WorkflowGraph, from: string, to: string): OpResult {
  const trimmed = to.trim();
  if (!valueNamed(g, from)) return refuse(VALUE_MISSING);
  if (trimmed === '') return refuse('A value needs a name');
  if (trimmed === from) return ok(g);
  if (valueNamed(g, trimmed)) return refuse(`There is already a value called ${trimmed}`);
  const entries = (g.values?.entries ?? []).map((v) =>
    v.name === from ? { ...v, name: trimmed } : v,
  );
  const renamed = mapLinks(g, (links) =>
    Object.values(links).includes(from)
      ? Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v === from ? trimmed : v]))
      : links,
  );
  return ok(withEntries(renamed, entries));
}

/** Removes the value; the settings that followed it keep their current copies. */
export function removeValue(g: WorkflowGraph, name: string): OpResult {
  if (!valueNamed(g, name)) return refuse(VALUE_MISSING);
  const unlinked = mapLinks(g, (links) =>
    Object.values(links).includes(name)
      ? Object.fromEntries(Object.entries(links).filter(([, v]) => v !== name))
      : links,
  );
  return ok(
    withEntries(
      unlinked,
      (g.values?.entries ?? []).filter((v) => v.name !== name),
    ),
  );
}

/** The setting follows the value from now on (and takes its content right away). */
export function linkSetting(g: WorkflowGraph, nodeId: string, key: string, name: string): OpResult {
  if (!valueNamed(g, name)) return refuse(VALUE_MISSING);
  if (!g.nodes.some((n) => n.id === nodeId)) return refuse('That node no longer exists');
  const nodes = g.nodes.map((n) =>
    n.id === nodeId ? { ...n, links: { ...(n.links ?? {}), [key]: name } } : n,
  );
  return ok(syncLinkedSettings({ ...g, nodes }));
}

/** The setting stops following its value and keeps the content it has now. */
export function unlinkSetting(g: WorkflowGraph, nodeId: string, key: string): OpResult {
  return ok(
    mapLinks(g, (links, n) => {
      if (n.id !== nodeId || !(key in links)) return links;
      const { [key]: _, ...rest } = links;
      return rest;
    }),
  );
}

/** A new value made from the setting's current content, which then follows it. */
export function shareSetting(
  g: WorkflowGraph,
  nodeId: string,
  key: string,
  name: string,
  schema: JsonValue,
): OpResult {
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!node) return refuse('That node no longer exists');
  const settings = node.settings;
  const current =
    settings !== null && typeof settings === 'object' && !Array.isArray(settings)
      ? settings[key]
      : undefined;
  const added = addValue(g, name, schema, current ?? null);
  return added.ok ? linkSetting(added.graph, nodeId, key, name.trim()) : added;
}
