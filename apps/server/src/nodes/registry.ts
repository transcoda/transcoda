import type { AnyNodeDefinition } from '@transcoda/sdk';
import { coreNodes } from './core/index.ts';

export type NodeSource = { kind: 'core' } | { kind: 'plugin'; name: string; version: string };

export interface RegisteredNode {
  def: AnyNodeDefinition;
  source: NodeSource;
  /** A reason the node cannot run now (plugin stopped/disabled); null for core and for a running plugin. */
  unavailable?: () => string | null;
}

function describeSource(source: NodeSource): string {
  return source.kind === 'core' ? 'core' : `plugin ${source.name}`;
}

export class NodeRegistry {
  private readonly byType = new Map<string, RegisteredNode>();
  /** Increments on every add/remove, so caches derived from the catalogue can tell it changed. */
  private generationCounter = 0;

  constructor(entries: RegisteredNode[]) {
    for (const entry of entries) {
      if (this.byType.has(entry.def.type)) throw new Error(`duplicate node type ${entry.def.type}`);
      this.byType.set(entry.def.type, entry);
    }
  }

  get generation(): number {
    return this.generationCounter;
  }

  /** Adds all or none: a type already registered (by core or a plugin) refuses the whole batch. */
  add(entries: RegisteredNode[]): void {
    const first = new Map<string, NodeSource>();
    for (const entry of entries) {
      const type = entry.def.type;
      const existing = this.byType.get(type);
      if (existing) {
        throw new Error(
          `node type ${type} is already provided by ${describeSource(existing.source)}`,
        );
      }
      const earlier = first.get(type);
      if (earlier) {
        throw new Error(
          `node type ${type} is provided twice in one batch (by ${describeSource(earlier)} and by ${describeSource(entry.source)})`,
        );
      }
      first.set(type, entry.source);
    }
    if (entries.length === 0) return;
    for (const entry of entries) this.byType.set(entry.def.type, entry);
    this.generationCounter++;
  }

  /** Removes every node of the named plugin; returns the removed types. */
  removeBySource(name: string): string[] {
    const removed: string[] = [];
    for (const [type, entry] of this.byType) {
      if (entry.source.kind === 'plugin' && entry.source.name === name) removed.push(type);
    }
    for (const type of removed) this.byType.delete(type);
    if (removed.length > 0) this.generationCounter++;
    return removed;
  }

  get(type: string): RegisteredNode | undefined {
    return this.byType.get(type);
  }

  /** Registration order. */
  list(): RegisteredNode[] {
    return [...this.byType.values()];
  }
}

export function createCoreRegistry(extra: RegisteredNode[] = []): NodeRegistry {
  const core = coreNodes.map((def): RegisteredNode => ({ def, source: { kind: 'core' } }));
  return new NodeRegistry([...core, ...extra]);
}
