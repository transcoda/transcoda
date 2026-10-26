import type { NodeInfo } from '@transcoda/contract';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from './useAsync.ts';
import { useRefetchOn } from './useRefetchOn.ts';

/** Derived from the contract: the web app never imports @transcoda/sdk. */
export type NodeKind = NodeInfo['kind'];
export type PortSpec = NodeInfo['inputs'][number];
export type PortType = PortSpec['type'];

export interface Catalog {
  nodes: NodeInfo[];
  byType: ReadonlyMap<string, NodeInfo>;
  /** Kinds present in the catalogue, in palette order (subworkflow-io excluded). */
  kinds: ReadonlyArray<NodeKind>;
  portType(type: string, portId: string): PortType | null;
}

export const KIND_ORDER = ['trigger', 'condition', 'action', 'finish', 'data'] as const;

export function buildCatalog(nodes: NodeInfo[]): Catalog {
  const byType = new Map(nodes.map((n) => [n.type, n] as const));
  const present = new Set(nodes.map((n) => n.kind));
  return {
    nodes,
    byType,
    kinds: KIND_ORDER.filter((k) => present.has(k)),
    portType(type, portId) {
      const node = byType.get(type);
      if (!node) return null;
      const port = [...node.inputs, ...node.outputs].find((p) => p.id === portId);
      return port?.type ?? null;
    },
  };
}

// One nodes.list request shared by every consumer; reload() clears it and refetches everywhere.
let cache: Promise<Catalog> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function loadCatalog(): Promise<Catalog> {
  cache ??= api.nodes.list().then((r) => buildCatalog(r.nodes));
  return cache;
}

function reloadCatalog(): void {
  cache = null;
  generation++;
  for (const listener of listeners) listener();
}

export function useCatalog(): { catalog: Catalog | null; error: unknown; reload(): void } {
  const [gen, setGen] = useState(generation);
  useEffect(() => {
    const listener = () => setGen(generation);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // A plugin installed, removed, enabled or stopped changes the nodes the server offers.
  // Every consumer hears it; the first one clears the cache and the rest see it already cleared.
  useRefetchOn(
    (e) => e.type === 'plugins.changed',
    () => {
      if (cache !== null) reloadCatalog();
    },
  );
  const { data, error } = useAsync(loadCatalog, [gen]);
  return { catalog: data ?? null, error, reload: reloadCatalog };
}

/** Tests only: forget the cached catalogue. */
export function resetCatalogCache(): void {
  cache = null;
  generation = 0;
}
