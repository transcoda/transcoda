import type { JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';

/**
 * JSON with object keys sorted, so key order does not affect equality. Copied from the server's
 * `apps/server/src/workflows/upgrade.ts` (the web app never imports server code); unlike the
 * server's copy it skips `undefined` values, which in-memory drafts may carry for optional keys
 * and which `JSON.stringify` drops on the wire anyway.
 */
function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Serialised graphs by reference. Drafts are immutable values (every op returns a new graph), so a
 * graph is serialised once however often it is compared: on a drag each apply serialises only the
 * new graph, while the draft's and the saved graph's keys come from here.
 */
const keys = new WeakMap<WorkflowGraph, string>();

function graphKey(g: WorkflowGraph): string {
  let key = keys.get(g);
  if (key === undefined) {
    key = stableStringify(g as JsonValue);
    keys.set(g, key);
  }
  return key;
}

/** Structural equality, key-order independent (array order counts). Graphs must not be mutated. */
export function graphEquals(a: WorkflowGraph, b: WorkflowGraph): boolean {
  return a === b || graphKey(a) === graphKey(b);
}

/** The node's behaviour: everything except position, label and groupId. */
function behaviourKey(n: NodeInstance): string {
  return stableStringify([n.type, n.typeVersion, n.settings, n.bypassed ?? false]);
}

/** Sorted endpoint keys, duplicates kept, so parallel edges count (multiset; edge ids ignored). */
export function edgeKeys(g: WorkflowGraph): string[] {
  return g.edges
    .map((e) => JSON.stringify([e.from.node, e.from.port, e.to.node, e.to.port]))
    .sort();
}

/**
 * True when `next` differs from `base` only in node positions, labels, group membership and the
 * groups themselves (the server's safe-change list for a pin comparison). Two equal graphs are
 * layout-only too: there is no behaviour change.
 */
export function isLayoutOnlyChange(base: WorkflowGraph, next: WorkflowGraph): boolean {
  if (base.formatVersion !== next.formatVersion || base.kind !== next.kind) return false;
  if (base.nodes.length !== next.nodes.length) return false;
  const nextById = new Map(next.nodes.map((n) => [n.id, n]));
  if (nextById.size !== next.nodes.length) return false;
  for (const n of base.nodes) {
    const other = nextById.get(n.id);
    if (!other || behaviourKey(n) !== behaviourKey(other)) return false;
  }
  const a = edgeKeys(base);
  const b = edgeKeys(next);
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
