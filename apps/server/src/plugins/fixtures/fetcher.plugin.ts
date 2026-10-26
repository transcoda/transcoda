import {
  defineIntegration,
  defineNode,
  definePlugin,
  fetchErrorKind,
  secret,
} from '@transcoda/sdk';
import { z } from 'zod';

const integration = defineIntegration({
  id: 'fetcher',
  title: 'Fetcher',
  settings: z.object({ apiKey: secret(), url: z.string() }),
  allowedOrigins: [],
  /** Fetches `<url>/slow` with the (candidate) key: the server decides when to answer. */
  async test(ctx) {
    const response = await ctx.fetch({
      url: `${String(ctx.settings.url)}/slow`,
      headers: { 'X-Api-Key': String(ctx.settings.apiKey) },
    });
    return { ok: true, message: `status ${response.status}` };
  },
});

const value = [{ id: 'value', label: 'Value', type: 'data:fetch' }] as const;
const settings = z.object({ url: z.string(), waitMs: z.number().default(200) });

// `instanceof` does not hold across bundles: the host and the plugin each inline the SDK.
const kindOf = (e: unknown): string => fetchErrorKind(e) ?? 'other';

/** One fetch with the stored key; answers the status or the failure kind. */
const get = defineNode({
  type: 'fetcher:get',
  version: 1,
  kind: 'data',
  title: 'Get',
  description: 'Fetches its url with the stored key.',
  icon: 'drop',
  inputs: [],
  outputs: [...value],
  settings,
  async data(ctx, s) {
    try {
      const r = await ctx.plugin.fetch({
        url: s.url,
        headers: { 'X-Api-Key': String(ctx.plugin.settings.apiKey) },
      });
      return { value: { status: r.status }, reason: 'ok' };
    } catch (e) {
      return { value: { failed: kindOf(e) }, reason: 'failed' };
    }
  },
});

/** Fires a fetch without awaiting it and returns at once. */
const fire = defineNode({
  type: 'fetcher:fire',
  version: 1,
  kind: 'data',
  title: 'Fire',
  description: 'Starts a fetch and does not wait for it.',
  icon: 'drop',
  inputs: [],
  outputs: [...value],
  settings,
  async data(ctx, s) {
    ctx.plugin.fetch({ url: s.url, timeoutMs: 60_000 }).catch(() => {});
    // Long enough for the request to be in flight before the call settles.
    await new Promise((resolve) => setTimeout(resolve, s.waitMs));
    return { value: { fired: true }, reason: 'fired' };
  },
});

/** Waits, then fetches: a cancel that arrives in between must stop the fetch from being sent. */
const late = defineNode({
  type: 'fetcher:late',
  version: 1,
  kind: 'data',
  title: 'Late',
  description: 'Fetches its url after a delay.',
  icon: 'drop',
  inputs: [],
  outputs: [...value],
  settings,
  async data(ctx, s) {
    await new Promise((resolve) => setTimeout(resolve, s.waitMs));
    try {
      const r = await ctx.plugin.fetch({ url: s.url });
      return { value: { status: r.status }, reason: 'ok' };
    } catch (e) {
      await ctx.plugin.log('info', `late fetch failed: ${kindOf(e)}`);
      return { value: { failed: kindOf(e) }, reason: 'failed' };
    }
  },
});

export default definePlugin({
  name: 'fetcher',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [get, fire, late],
});
