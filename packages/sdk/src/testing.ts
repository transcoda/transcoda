import type { FetchErrorKind, JsonValue, PathMapping, ProbeStream } from '@transcoda/shared';
import type { z } from 'zod';
import {
  createCache,
  createPaths,
  type LogLevel,
  lang,
  type PluginContext,
  type PluginFetchInput,
  type PluginFetchResponse,
} from './context.ts';
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
import type { AnyIntegration, IntegrationTestFail, IntegrationTestOk } from './integration.ts';
import type { AnyNodeDefinition } from './node.ts';
import type { AnyTrigger, TriggerRequest, TriggerResult } from './trigger.ts';

export interface ScriptedResponse {
  match: { url: string | RegExp; method?: string | undefined };
  status?: number | undefined;
  body?: JsonValue | undefined;
  headers?: Record<string, string> | undefined;
}

export type FakePluginContext = PluginContext & {
  calls: PluginFetchInput[];
  logs: Array<[LogLevel, string]>;
};

/**
 * A fetch failure as a plugin bundle sees the host's: a plain `Error` carrying `name` and `kind`, not an
 * instance of the SDK's classes (the bundle inlines its own copy). `instanceof` misuse fails in unit tests.
 */
function fetchFailure(name: string, kind: FetchErrorKind, message: string): Error {
  return Object.assign(new Error(message), { name, kind });
}

/** A plugin context whose fetch answers from a script; an unscripted call throws a `failed`-kind error. */
export function fakePluginContext(
  opts: {
    settings?: Record<string, JsonValue> | undefined;
    responses?: ScriptedResponse[] | undefined;
    mappings?: PathMapping[] | undefined;
    dryRun?: boolean | undefined;
  } = {},
): FakePluginContext {
  const pending = [...(opts.responses ?? [])];
  const calls: PluginFetchInput[] = [];
  const logs: Array<[LogLevel, string]> = [];
  return {
    settings: opts.settings ?? {},
    async fetch(input): Promise<PluginFetchResponse> {
      calls.push(input);
      const method = input.method ?? 'GET';
      const at = pending.findIndex(({ match }) => {
        const urlOk =
          typeof match.url === 'string' ? match.url === input.url : match.url.test(input.url);
        return urlOk && (match.method === undefined || match.method === method);
      });
      const hit = at < 0 ? undefined : pending[at];
      if (!hit)
        throw fetchFailure(
          'FetchFailed',
          'failed',
          `no scripted response for ${method} ${input.url}`,
        );
      pending.splice(at, 1);
      return { status: hit.status ?? 200, headers: hit.headers ?? {}, body: hit.body ?? null };
    },
    paths: createPaths(opts.mappings ?? []),
    cache: createCache({ entries: 1000, bytes: 8_388_608 }),
    lang,
    async log(level, message) {
      logs.push([level, message]);
    },
    dryRun: opts.dryRun ?? false,
    job: null,
    calls,
    logs,
  };
}

const BASE_STREAM = {
  language: null,
  title: null,
  default: false,
  forced: false,
  attachedPic: false,
  dispositions: [],
  width: null,
  height: null,
  profile: null,
  level: null,
  pixelFormat: null,
  bitDepth: null,
  hdr: null,
  channels: null,
  sampleRate: null,
  bitrateKbps: null,
  frameRate: null,
} satisfies Omit<ProbeStream, 'index' | 'type' | 'codec'>;

/** A complete `DecideContext` (it is also a valid base for build, finish, data and run contexts). */
export function fakeHookContext(partial: Partial<DecideContext> = {}): DecideContext {
  return {
    now: Date.parse('2026-10-17T00:00:00.000Z'),
    probe: {
      container: 'matroska',
      durationSeconds: 60,
      sizeBytes: 1_000_000,
      bitrateKbps: null,
      streams: [
        {
          ...BASE_STREAM,
          index: 0,
          type: 'video',
          codec: 'hevc',
          width: 1920,
          height: 1080,
          pixelFormat: 'yuv420p10le',
          bitDepth: 10,
          hdr: 'none',
          frameRate: 24,
        },
        {
          ...BASE_STREAM,
          index: 1,
          type: 'audio',
          codec: 'aac',
          language: 'eng',
          channels: 2,
          sampleRate: 48_000,
        },
      ],
      formatName: 'matroska,webm',
      chapters: 0,
      raw: {},
    },
    file: {
      path: '/media/a.mkv',
      sizeBytes: 1_000_000,
      mtime: '2026-10-17T00:00:00.000Z',
      nlink: 1,
    },
    data: {},
    capabilities: { encoders: ['libx264'], filters: [], hwaccels: [] },
    log: () => {},
    plugin: fakePluginContext(),
    ...partial,
  };
}

function parse<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  settings: unknown,
): z.infer<z.ZodObject<Shape>> {
  return schema.parse(settings);
}

function hook<K extends 'decide' | 'build' | 'finish' | 'data' | 'run'>(
  node: AnyNodeDefinition,
  name: K,
): NonNullable<AnyNodeDefinition[K]> {
  const fn = node[name];
  if (typeof fn !== 'function') throw new Error(`${node.type} has no ${name} hook`);
  return fn.bind(node) as NonNullable<AnyNodeDefinition[K]>;
}

export async function runDecide(
  node: AnyNodeDefinition,
  ctx: DecideContext,
  settings: unknown,
): Promise<DecideResult> {
  return hook(node, 'decide')(ctx, parse(node.settings, settings));
}
export async function runBuild(
  node: AnyNodeDefinition,
  ctx: BuildContext,
  settings: unknown,
): Promise<BuildResult> {
  return hook(node, 'build')(ctx, parse(node.settings, settings));
}
export async function runFinish(
  node: AnyNodeDefinition,
  ctx: FinishContext,
  settings: unknown,
): Promise<FinishResult> {
  return hook(node, 'finish')(ctx, parse(node.settings, settings));
}
export async function runData(
  node: AnyNodeDefinition,
  ctx: DataContext,
  settings: unknown,
): Promise<DataResult> {
  return hook(node, 'data')(ctx, parse(node.settings, settings));
}
export async function runFinishRun(
  node: AnyNodeDefinition,
  ctx: FinishRunContext,
  settings: unknown,
): Promise<FinishRunResult> {
  return hook(node, 'run')(ctx, parse(node.settings, settings));
}

export async function runTrigger(
  trigger: AnyTrigger,
  ctx: PluginContext,
  request: TriggerRequest,
  settings: unknown,
): Promise<TriggerResult> {
  return trigger.handle(ctx, request, parse(trigger.settings, settings));
}

export async function runTest(
  integration: AnyIntegration,
  ctx: PluginContext,
): Promise<IntegrationTestOk | IntegrationTestFail> {
  return integration.test(ctx);
}
