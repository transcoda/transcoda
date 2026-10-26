import {
  createCache,
  createPaths,
  FetchFailed,
  FetchRateLimited,
  FetchRefused,
  FetchTimeout,
  type LogLevel,
  lang,
  type PluginCache,
  type PluginContext,
  type PluginFetchInput,
  type PluginFetchResponse,
} from '@transcoda/sdk';
import {
  type FetchInput,
  FetchInputSchema,
  type FetchResult,
  type JsonValue,
  type PathMapping,
  type PluginLimits,
} from '@transcoda/shared';

export interface HostContextOptions {
  settings: Record<string, JsonValue>;
  limits: PluginLimits;
  mappings: PathMapping[];
  /** Sends the request to the server's fetch proxy and resolves with its answer. */
  sendFetch(input: FetchInput): Promise<FetchResult>;
  sendLog(level: LogLevel, message: string, jobId: string | null): void;
  dryRun: boolean;
  job: { id: string; attempt: number } | null;
  /** One cache per plugin process, shared by every context; created from the limits when absent. */
  cache?: PluginCache | undefined;
}

export function createHostContext(opts: HostContextOptions): PluginContext {
  return {
    settings: opts.settings,
    async fetch(input: PluginFetchInput): Promise<PluginFetchResponse> {
      const parsed = FetchInputSchema.safeParse(input);
      if (!parsed.success) throw new FetchRefused(`invalid fetch input: ${parsed.error.message}`);
      const result = await opts.sendFetch(parsed.data);
      if (result.ok) return result.response;
      const { kind, message } = result.error;
      switch (kind) {
        case 'refused':
          throw new FetchRefused(message);
        case 'timeout':
          throw new FetchTimeout(message);
        case 'rate-limited':
          throw new FetchRateLimited(message);
        case 'failed':
          throw new FetchFailed(message);
      }
    },
    paths: createPaths(opts.mappings),
    cache:
      opts.cache ??
      createCache({ entries: opts.limits.cacheEntries, bytes: opts.limits.cacheBytes }),
    lang,
    async log(level, message) {
      opts.sendLog(level, message, opts.job?.id ?? null);
    },
    dryRun: opts.dryRun,
    job: opts.job,
  };
}
