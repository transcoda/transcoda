import type {
  AnyNodeDefinition,
  BuildResult,
  DataResult,
  DecideResult,
  FinishAction,
  FinishResult,
  FinishRunContext,
  FinishRunResult,
  HookContextBase,
  NodeMetadata,
} from '@transcoda/sdk';
import type { HookName, JsonValue } from '@transcoda/shared';
import { z } from 'zod';
import type { CoreTools } from '../engine/check-source.ts';
import { serverSettingsSchema } from './plugin-settings-schema.ts';
import type { NodeSource } from './registry.ts';

/** The supervisor's side of a hook call (Task 7 implements it over IPC). */
export interface RemoteHooks {
  call(
    hook: HookName,
    nodeType: string,
    nodeVersion: number,
    ctx: JsonValue,
    settings: JsonValue,
    opts: { timeoutMs?: number; jobId: string | null; signal?: AbortSignal | undefined },
  ): Promise<
    { ok: true; result: JsonValue } | { ok: false; error: { message: string; retryable: boolean } }
  >;
}

export interface RemoteNodeDefinition extends AnyNodeDefinition {
  /** The plugin's own settings schema, verbatim (see `nodeMetadata`). */
  settingsJsonSchema: JsonValue;
}

/**
 * Thrown by a remote migration step if core ever tries to run it: plugin migration code lives in
 * the sandboxed host, which migrates at call time (and on a `migrate` message).
 */
export class PluginMigrationPending extends Error {
  constructor(nodeType: string) {
    super(`${nodeType}: settings are migrated by the plugin host when the node runs`);
    this.name = 'PluginMigrationPending';
  }
}

export function isRemoteDefinition(def: AnyNodeDefinition): def is RemoteNodeDefinition {
  return 'settingsJsonSchema' in def;
}

/** A hook of a plugin node failed; `retryable` lets the pipeline's retry-once rule apply. */
/** The longest message a plugin `run` may answer with (it is shown on the job page). */
export const MAX_RUN_MESSAGE = 2000;

/** What a plugin `run` must answer (`FinishRunResult`). */
const FinishRunResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: z.string().max(MAX_RUN_MESSAGE) }),
  z.object({
    ok: z.literal(false),
    message: z.string().max(MAX_RUN_MESSAGE),
    retryable: z.boolean().optional(),
  }),
]);

export class RemoteHookError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RemoteHookError';
    this.retryable = retryable;
  }
}

/**
 * What the server may attach to a hook context besides the SDK's fields: never sent to the plugin.
 * `signal` aborts when the job is cancelled or the server stops (a plugin `run` is then cancelled).
 */
export type ServerHookContext = (HookContextBase | FinishRunContext) & {
  signal?: AbortSignal | undefined;
  /** The node's stored typeVersion; older than the definition's, the host migrates the settings. */
  nodeVersion?: number | undefined;
  /** Engine tools for core nodes (Check source's pass); never sent to a plugin. */
  core?: CoreTools | undefined;
};

/**
 * Everything but `plugin`, `log` (the host builds its own), `signal` and `core`; `model` stays for
 * build/finish. The host rebuilds `ctx.plugin` from the top-level `job` and `dryRun` added here.
 */
export function wireContext(ctx: ServerHookContext): JsonValue {
  const {
    plugin,
    log: _log,
    signal: _signal,
    nodeVersion: _nodeVersion,
    core: _core,
    ...rest
  } = ctx;
  return { ...rest, job: plugin.job, dryRun: plugin.dryRun } as unknown as JsonValue;
}

export function remoteNodeDefinition(
  meta: NodeMetadata,
  source: Extract<NodeSource, { kind: 'plugin' }>,
  hooks: RemoteHooks,
  limits: { callTimeoutMs: number; finishRunTimeoutMs: number },
): RemoteNodeDefinition {
  // Loose: unknown keys are kept. The host re-parses with the plugin's own zod before every hook;
  // this copy never runs the plugin's patterns or formats (ReDoS on the event loop).
  const settings = serverSettingsSchema(meta.settingsSchema);
  if (!(settings instanceof z.ZodObject)) {
    throw new Error(`plugin ${source.name}: settings of ${meta.type} are not an object schema`);
  }
  if (meta.kind === 'finish') {
    if (
      meta.finishPhase === null ||
      meta.finishPhase === 'render' ||
      meta.finishPhase === 'gate' ||
      meta.finishPhase === 'write'
    ) {
      throw new Error(
        `plugin ${source.name}: finish node ${meta.type} must declare finishPhase library-manager, media-server or notify (got ${meta.finishPhase ?? 'none'})`,
      );
    }
  }
  if (meta.hooks.includes('run') && meta.kind !== 'finish') {
    throw new Error(`plugin ${source.name}: ${meta.type} declares run but is not a finish node`);
  }
  if (meta.hooks.includes('decide') && meta.kind !== 'condition') {
    throw new Error(
      `plugin ${source.name}: ${meta.type} declares decide but is not a condition node`,
    );
  }
  const outputIds = new Set(meta.outputs.map((p) => p.id));

  async function call(hook: HookName, ctx: ServerHookContext, values: unknown): Promise<JsonValue> {
    const response = await hooks.call(
      hook,
      meta.type,
      ctx.nodeVersion ?? meta.version,
      wireContext(ctx),
      values as JsonValue,
      {
        timeoutMs: hook === 'run' ? limits.finishRunTimeoutMs : limits.callTimeoutMs,
        jobId: ctx.plugin.job?.id ?? null,
        signal: ctx.signal,
      },
    );
    if (!response.ok) throw new RemoteHookError(response.error.message, response.error.retryable);
    return response.result;
  }

  const def: RemoteNodeDefinition = {
    type: meta.type,
    version: meta.version,
    kind: meta.kind,
    title: meta.title,
    description: meta.description,
    icon: meta.icon,
    inputs: meta.inputs,
    outputs: meta.outputs,
    settings,
    onNodeSettings: meta.onNodeSettings,
    requires: meta.requires,
    // Links only: the settings are migrated inside the plugin host (call time / `migrate`).
    migrations: meta.migrations.map((m) => ({
      ...m,
      migrate: () => {
        throw new PluginMigrationPending(meta.type);
      },
    })),
    finishPhase: meta.finishPhase ?? undefined,
    damagedOnly: meta.damagedOnly === true,
    settingsJsonSchema: meta.settingsSchema,
  };
  const has = (h: HookName) => meta.hooks.includes(h);
  if (has('decide')) {
    def.decide = async (ctx, values) => {
      const result = (await call('decide', ctx, values)) as unknown as DecideResult;
      if (!outputIds.has(result.port)) {
        throw new RemoteHookError(
          `plugin ${source.name} chose port ${result.port}, which ${meta.type} does not declare`,
          false,
        );
      }
      return result;
    };
  }
  if (has('build')) {
    def.build = async (ctx, values) => (await call('build', ctx, values)) as unknown as BuildResult;
  }
  if (has('finish')) {
    def.finish = async (ctx, values) => {
      const result = (await call('finish', ctx, values)) as unknown as FinishResult;
      for (const action of result.actions as FinishAction[]) {
        if (action.kind !== 'plugin') {
          throw new RemoteHookError(
            `plugin ${source.name} returned a ${action.kind} action; only plugin actions are allowed`,
            false,
          );
        }
      }
      return result;
    };
  }
  if (has('data')) {
    def.data = async (ctx, values) => (await call('data', ctx, values)) as unknown as DataResult;
  }
  if (has('run')) {
    def.run = async (ctx, values) => {
      // The answer goes onto the job's trace (C2): checked, never cast.
      const parsed = FinishRunResultSchema.safeParse(await call('run', ctx, values));
      if (!parsed.success) {
        throw new RemoteHookError(
          `plugin ${source.name} sent an invalid run answer: ${z.prettifyError(parsed.error).split('\n')[0] ?? 'wrong shape'}`,
          false,
        );
      }
      return parsed.data as FinishRunResult;
    };
  }
  return def;
}
