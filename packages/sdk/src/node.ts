import { type FinishPhase, HOOK_NAMES, type HookName, type JsonValue } from '@transcoda/shared';
import { z } from 'zod';
import type {
  BuildContext,
  BuildResult,
  DataContext,
  DataResult,
  DecideContext,
  DecideResult,
  FinishContext,
  FinishResult,
  FinishRunContext,
  FinishRunResult,
} from './engine.ts';

export const PORT_TYPE_PATTERN = /^(file|data:[a-z0-9-]+)$/;
export type PortType = 'file' | `data:${string}`;

/** `required` applies to inputs only; it defaults to true. */
export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  required?: boolean;
}

export const NODE_KINDS = [
  'trigger',
  'condition',
  'action',
  'finish',
  'data',
  'subworkflow-io',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const MIGRATION_RISKS = ['safe', 'behaviour'] as const;
export type MigrationRisk = (typeof MIGRATION_RISKS)[number];

export interface NodeRequirements {
  encoders?: string[];
  filters?: string[];
  hwaccels?: string[];
}

export interface NodeMigration {
  from: number;
  to: number;
  risk: MigrationRisk;
  note: string;
  /**
   * Output ports this step renames (`{ oldId: newId }`). Edges leaving a renamed port are
   * re-keyed when a core node's graph is upgraded, so the workflow keeps its wiring. Only core
   * nodes use it; the manifest of a plugin node does not carry it.
   */
  renameOutputs?: Record<string, string>;
  migrate(settings: JsonValue): JsonValue;
}

export interface NodeDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  type: string;
  version: number;
  kind: NodeKind;
  title: string;
  description: string;
  icon: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  settings: z.ZodObject<Shape>;
  onNodeSettings?: string[];
  requires?: NodeRequirements;
  migrations?: NodeMigration[];
  /** Required for `kind: 'finish'`: where the node's action sits in the finish order. */
  finishPhase?: FinishPhase | undefined;
  decide?(ctx: DecideContext, settings: z.infer<z.ZodObject<Shape>>): Promise<DecideResult>;
  build?(ctx: BuildContext, settings: z.infer<z.ZodObject<Shape>>): Promise<BuildResult>;
  finish?(ctx: FinishContext, settings: z.infer<z.ZodObject<Shape>>): Promise<FinishResult>;
  /** For `kind: 'data'` nodes. */
  data?(ctx: DataContext, settings: z.infer<z.ZodObject<Shape>>): Promise<DataResult>;
  /** For plugin finish nodes: does the work of a `plugin` action, after the write. */
  run?(ctx: FinishRunContext, settings: z.infer<z.ZodObject<Shape>>): Promise<FinishRunResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds definitions of every settings shape
export type AnyNodeDefinition = NodeDefinition<any>;

/** Identity function; exists so the settings shape is inferred. */
export function defineNode<Shape extends z.ZodRawShape>(
  def: NodeDefinition<Shape>,
): NodeDefinition<Shape> {
  return def;
}

/** Serialisable: what crosses the plugin IPC boundary in M3. */
export interface NodeMetadata {
  type: string;
  version: number;
  kind: NodeKind;
  title: string;
  description: string;
  icon: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  settingsSchema: JsonValue;
  onNodeSettings: string[];
  requires: NodeRequirements;
  migrations: Array<{ from: number; to: number; risk: MigrationRisk; note: string }>;
  finishPhase: FinishPhase | null;
  /** Which hooks the definition has. */
  hooks: HookName[];
}

function hasSecretSetting(schema: JsonValue): boolean {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const secret = (s: unknown): boolean => {
    if (typeof s !== 'object' || s === null) return false;
    const o = s as Record<string, unknown>;
    return (
      o.format === 'password' ||
      o['x-transcoda'] === 'secret' ||
      (Array.isArray(o.anyOf) && o.anyOf.some(secret))
    );
  };
  return Object.values(props).some(secret);
}

export function nodeMetadata(def: AnyNodeDefinition): NodeMetadata {
  if (def.kind === 'finish' && def.finishPhase === undefined) {
    throw new Error(`finish node ${def.type} declares no finishPhase`);
  }
  // A remote (plugin) definition carries the plugin's own schema; re-deriving it from the loose
  // z.fromJSONSchema() object would add `additionalProperties: {}` and drop formats.
  const settingsSchema = (
    'settingsJsonSchema' in def
      ? def.settingsJsonSchema
      : z.toJSONSchema(def.settings, { io: 'input' })
  ) as JsonValue;
  if (hasSecretSetting(settingsSchema)) {
    throw new Error(
      `node ${def.type}: settings may not contain a secret (format password) — put it in the integration settings`,
    );
  }
  return {
    type: def.type,
    version: def.version,
    kind: def.kind,
    title: def.title,
    description: def.description,
    icon: def.icon,
    inputs: def.inputs,
    outputs: def.outputs,
    settingsSchema,
    onNodeSettings: def.onNodeSettings ?? [],
    requires: def.requires ?? {},
    migrations: (def.migrations ?? []).map(({ from, to, risk, note }) => ({
      from,
      to,
      risk,
      note,
    })),
    finishPhase: def.finishPhase ?? null,
    hooks: HOOK_NAMES.filter((h) => typeof def[h] === 'function'),
  };
}

export type SettingsParseResult =
  | { ok: true; value: Record<string, JsonValue> }
  | { ok: false; issues: Array<{ path: string; message: string; missing: boolean }> };

function valueAt(root: JsonValue, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

export function parseSettings(def: AnyNodeDefinition, settings: JsonValue): SettingsParseResult {
  const result = def.settings.safeParse(settings);
  if (result.success) return { ok: true, value: result.data as Record<string, JsonValue> };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      missing: valueAt(settings, issue.path) === undefined,
    })),
  };
}

export function isPortRequired(port: PortSpec): boolean {
  return port.required ?? true;
}
