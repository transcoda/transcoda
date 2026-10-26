import { nodeMetadata } from '@transcoda/sdk';
import {
  type JsonValue,
  RUN_SUBWORKFLOW_TYPE,
  RunSubworkflowSettingsSchema,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { NodeRegistry } from '../nodes/registry.ts';

export interface SubworkflowSetting {
  /** `${nodeId}.${settingKey}` */
  key: string;
  nodeId: string;
  nodeTitle: string;
  settingKey: string;
  schema: JsonValue;
  default: JsonValue;
}

export interface OverrideCheck {
  unknownKeys: string[];
  invalid: Array<{ key: string; message: string }>;
}

function isObject(v: JsonValue): v is Record<string, JsonValue> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Node types whose settings a parent can never override: the start/end IO nodes, and nested
 * Run nodes (a parent must not re-pin a sub-workflow its child runs; no deep override paths).
 */
const NOT_OVERRIDABLE: string[] = [
  SUBWORKFLOW_START_TYPE,
  SUBWORKFLOW_END_TYPE,
  RUN_SUBWORKFLOW_TYPE,
];

export function subworkflowSettings(
  graph: WorkflowGraph,
  registry: NodeRegistry,
): SubworkflowSetting[] {
  const out: SubworkflowSetting[] = [];
  for (const n of graph.nodes) {
    if (NOT_OVERRIDABLE.includes(n.type)) continue;
    const def = registry.get(n.type)?.def;
    if (!def) continue;
    const schema = nodeMetadata(def).settingsSchema;
    const properties =
      isObject(schema) && isObject(schema.properties ?? null) ? schema.properties : {};
    for (const [settingKey, property] of Object.entries(properties as Record<string, JsonValue>)) {
      let value: JsonValue = null;
      if (isObject(n.settings) && settingKey in n.settings) {
        value = n.settings[settingKey] as JsonValue;
      } else if (isObject(property) && property.default !== undefined) {
        value = property.default;
      }
      out.push({
        key: `${n.id}.${settingKey}`,
        nodeId: n.id,
        nodeTitle: n.label ?? def.title,
        settingKey,
        schema: property,
        default: value,
      });
    }
  }
  return out;
}

/** Splits an override key `<nodeId>.<settingKey>`; null when malformed. */
export function splitOverrideKey(key: string): { nodeId: string; settingKey: string } | null {
  const dot = key.indexOf('.');
  if (dot < 1 || dot === key.length - 1) return null;
  return { nodeId: key.slice(0, dot), settingKey: key.slice(dot + 1) };
}

type SettingField = { safeParse(v: unknown): unknown };

function settingField(
  key: string,
  graph: WorkflowGraph,
  registry: NodeRegistry,
): SettingField | undefined {
  const parts = splitOverrideKey(key);
  const target = parts && graph.nodes.find((n) => n.id === parts.nodeId);
  if (!parts || !target || NOT_OVERRIDABLE.includes(target.type)) return undefined;
  const shape = registry.get(target.type)?.def.settings.shape as
    | Record<string, SettingField>
    | undefined;
  return shape && Object.hasOwn(shape, parts.settingKey) ? shape[parts.settingKey] : undefined;
}

/** True when `key` names an existing setting of an overridable node in `graph` (per its schema). */
export function isKnownOverrideKey(
  key: string,
  graph: WorkflowGraph,
  registry: NodeRegistry,
): boolean {
  return settingField(key, graph, registry) !== undefined;
}

export function checkOverrides(
  overrides: Record<string, JsonValue>,
  graph: WorkflowGraph,
  registry: NodeRegistry,
): OverrideCheck {
  const result: OverrideCheck = { unknownKeys: [], invalid: [] };
  for (const [key, value] of Object.entries(overrides)) {
    const field = settingField(key, graph, registry);
    if (!field) {
      result.unknownKeys.push(key);
      continue;
    }
    const parsed = field.safeParse(value) as
      | { success: true }
      | { success: false; error: { issues: Array<{ message: string }> } };
    if (!parsed.success) {
      result.invalid.push({ key, message: parsed.error.issues[0]?.message ?? 'invalid value' });
    }
  }
  return result;
}

export function applyOverrides(
  graph: WorkflowGraph,
  overrides: Record<string, JsonValue>,
  registry: NodeRegistry,
): WorkflowGraph {
  const byNode = new Map<string, Record<string, JsonValue>>();
  for (const [key, value] of Object.entries(overrides)) {
    const parts = splitOverrideKey(key);
    if (!parts || !settingField(key, graph, registry)) continue;
    const bucket = byNode.get(parts.nodeId) ?? {};
    bucket[parts.settingKey] = value;
    byNode.set(parts.nodeId, bucket);
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const bucket = byNode.get(n.id);
      if (!bucket) return n;
      return { ...n, settings: { ...(isObject(n.settings) ? n.settings : {}), ...bucket } };
    }),
  };
}

export function dropStaleOverrides(
  graph: WorkflowGraph,
  resolveChild: (id: string, version: number) => WorkflowGraph | null,
  registry: NodeRegistry,
): { graph: WorkflowGraph; dropped: Array<{ nodeId: string; key: string }> } {
  const dropped: Array<{ nodeId: string; key: string }> = [];
  const nodes = graph.nodes.map((n) => {
    if (n.type !== RUN_SUBWORKFLOW_TYPE) return n;
    const parsed = RunSubworkflowSettingsSchema.safeParse(n.settings);
    if (!parsed.success) return n;
    const child = resolveChild(parsed.data.subworkflowId, parsed.data.version);
    if (!child) return n;
    const valid = new Set(subworkflowSettings(child, registry).map((s) => s.key));
    const kept: Record<string, JsonValue> = {};
    let changed = false;
    for (const [key, value] of Object.entries(parsed.data.overrides)) {
      if (valid.has(key)) kept[key] = value;
      else {
        dropped.push({ nodeId: n.id, key });
        changed = true;
      }
    }
    return changed ? { ...n, settings: { ...parsed.data, overrides: kept } } : n;
  });
  return { graph: { ...graph, nodes }, dropped };
}
