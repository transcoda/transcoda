import type { JsonValue } from '../json.ts';
import type { NodeInstance, SharedValue, WorkflowGraph } from './graph.ts';

/** The shared value called `name`, if the graph has one. */
export function valueNamed(g: WorkflowGraph, name: string): SharedValue | undefined {
  return g.values?.entries.find((v) => v.name === name);
}

/** The nodes with at least one setting following the value called `name`. */
export function linkedNodes(g: WorkflowGraph, name: string): NodeInstance[] {
  return g.nodes.filter((n) => n.links && Object.values(n.links).includes(name));
}

const same = (a: JsonValue | undefined, b: JsonValue): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Copies every linked shared value into the setting that follows it, so the settings always hold
 * what runs: the engine, validation and upgrades never look at `values`. A link to a value that
 * does not exist leaves the setting as it is (validation warns). Returns `g` itself when nothing
 * changes.
 */
export function syncLinkedSettings(g: WorkflowGraph): WorkflowGraph {
  if (!g.values) return g;
  let changed = false;
  const nodes = g.nodes.map((n) => {
    if (!n.links) return n;
    const settings = n.settings;
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return n;
    let next: Record<string, JsonValue> | null = null;
    for (const [key, name] of Object.entries(n.links)) {
      const value = valueNamed(g, name);
      if (!value || same(settings[key], value.value)) continue;
      next ??= { ...settings };
      next[key] = value.value;
    }
    if (!next) return n;
    changed = true;
    return { ...n, settings: next };
  });
  return changed ? { ...g, nodes } : g;
}
