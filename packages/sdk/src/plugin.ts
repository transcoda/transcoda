import {
  type FinishPhase,
  HOOK_EVENT_NAMES,
  type HookEventName,
  PluginIconSchema,
  type PluginManifest,
} from '@transcoda/shared';
import type { PluginContext } from './context.ts';
import { type AnyIntegration, checkIntegration } from './integration.ts';
import type { AnyNodeDefinition } from './node.ts';
import type { AnyTrigger } from './trigger.ts';

export const SDK_VERSION = '1.0.1';

export interface HookJob {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  path: string;
  outcome: string;
  reason: string | null;
  beforeBytes: number | null;
  afterBytes: number | null;
  replacedTo: 'recycle' | 'deleted' | null;
  problems: string[];
  dryRun: boolean;
  /** The job's page in the UI; null when `TRANSCODA_PUBLIC_URL` is not set. */
  jobUrl: string | null;
}

export interface PluginHooks {
  onJobDone?(ctx: PluginContext, job: HookJob): Promise<void>;
  onJobFailed?(ctx: PluginContext, job: HookJob): Promise<void>;
  afterReplace?(ctx: PluginContext, job: HookJob): Promise<void>;
}

export interface TranscodaPlugin {
  /** The bare plugin name ('example'), also the `<name>:` prefix of its node types. */
  name: string;
  version: string;
  /** The SDK majors the plugin supports, as a semver range ('^1'). */
  sdk: string;
  integration?: AnyIntegration | undefined;
  /**
   * The plugin's own icon as SVG markup (at most 16 KiB); shown as an image in the 40px tile of
   * the Plugins page. Without one the page shows a monogram. Ship only a mark you may use.
   */
  icon?: string | undefined;
  nodes: AnyNodeDefinition[];
  triggers?: AnyTrigger[] | undefined;
  hooks?: PluginHooks | undefined;
  setup?(ctx: PluginContext): Promise<void>;
}

const REFUSED_PHASES: readonly FinishPhase[] = ['gate', 'write'];

/** Identity function that refuses a plugin the host could never run. */
export function definePlugin(p: TranscodaPlugin): TranscodaPlugin {
  if (typeof p.sdk !== 'string' || p.sdk === '') {
    throw new TypeError(`plugin ${p.name}: sdk range is missing (for example '^1')`);
  }
  if (!Array.isArray(p.nodes)) throw new TypeError(`plugin ${p.name}: nodes must be an array`);
  if (p.icon !== undefined) {
    const icon = PluginIconSchema.safeParse(p.icon);
    if (!icon.success) {
      throw new TypeError(`plugin ${p.name}: ${icon.error.issues[0]?.message ?? 'bad icon'}`);
    }
  }
  if (p.integration) checkIntegration(p.integration);
  for (const node of p.nodes) {
    if (!node.type.startsWith(`${p.name}:`)) {
      throw new TypeError(`plugin ${p.name}: node type ${node.type} must start with ${p.name}:`);
    }
    if (node.kind === 'finish' && node.finishPhase === undefined) {
      throw new TypeError(`plugin ${p.name}: finish node ${node.type} declares no finishPhase`);
    }
    if (node.kind !== 'finish' && node.run !== undefined) {
      throw new TypeError(`plugin ${p.name}: ${node.type} has a run hook but is not a finish node`);
    }
    if (
      node.kind === 'finish' &&
      node.finishPhase !== undefined &&
      REFUSED_PHASES.includes(node.finishPhase)
    ) {
      throw new TypeError(
        `plugin finish nodes may use library-manager, media-server or notify; only core writes files (${node.type})`,
      );
    }
  }
  return p;
}

/** What the host announces and the catalog compares: no code, only names. */
export function pluginManifest(p: TranscodaPlugin): PluginManifest {
  return {
    name: p.name,
    version: p.version,
    sdk: p.sdk,
    nodes: p.nodes.map((n) => n.type),
    nodeVersions: p.nodes.map((n) => ({
      type: n.type,
      version: n.version,
      migrations: (n.migrations ?? []).map(({ from, to, risk }) => ({ from, to, risk })),
    })),
    nodeInfo: p.nodes.map((n) => ({ type: n.type, kind: n.kind, title: n.title })),
    integration: p.integration?.id ?? null,
    triggers: (p.triggers ?? []).map((t) => t.id),
    hooks: HOOK_EVENT_NAMES.filter((h) => typeof p.hooks?.[h] === 'function') as HookEventName[],
    ...(p.icon !== undefined ? { icon: p.icon } : {}),
  };
}
