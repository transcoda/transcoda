import {
  defineIntegration,
  defineNode,
  definePlugin,
  type FetchError,
  secret,
} from '@transcoda/sdk';
import { z } from 'zod';

const integration = defineIntegration({
  id: 'leaky',
  title: 'Leaky',
  settings: z.object({ apiKey: secret() }),
  allowedOrigins: ['https://api.example.test'],
  async test() {
    return { ok: true, message: 'ok' };
  },
});

const value = [{ id: 'value', label: 'Value', type: 'data:leak' }] as const;
const none = z.object({});

/** Logs the key, puts it in the reason, then fetches with it in the URL path and a header. */
const leak = defineNode({
  type: 'leaky:leak',
  version: 1,
  kind: 'data',
  title: 'Leak',
  description: 'Tries to leak the integration api key every way it can.',
  icon: 'drop',
  inputs: [],
  outputs: [...value],
  settings: none,
  async data(ctx) {
    const key = String(ctx.plugin.settings.apiKey);
    await ctx.plugin.log('info', `api key is ${key}`);
    ctx.log(`key again ${key}`);
    try {
      const response = await ctx.plugin.fetch({
        url: `https://api.example.test/v1/${key}/items`,
        headers: { 'X-Api-Key': key },
      });
      return { value: { status: response.status, body: response.body }, reason: `used ${key}` };
    } catch (e) {
      // `instanceof` does not hold across bundles: the host and the plugin each inline the SDK.
      const kind = (e as FetchError).kind;
      throw new Error(`${(e as Error).name} (${kind}): ${(e as Error).message}`);
    }
  },
});

const findings = defineNode({
  type: 'leaky:findings',
  version: 1,
  kind: 'condition',
  title: 'Findings',
  description: 'Returns the key in its findings.',
  icon: 'drop',
  inputs: [{ id: 'file', label: 'File', type: 'file' }],
  outputs: [{ id: 'pass', label: 'Pass', type: 'file' }],
  settings: none,
  async decide(ctx) {
    const key = String(ctx.plugin.settings.apiKey);
    return { port: 'pass', reason: `key ${key}`, findings: { key } };
  },
});

const throws = defineNode({
  type: 'leaky:throws',
  version: 1,
  kind: 'data',
  title: 'Throws',
  description: 'Throws with the key in the message.',
  icon: 'drop',
  inputs: [],
  outputs: [...value],
  settings: none,
  async data(ctx) {
    throw new Error(`failed with key ${String(ctx.plugin.settings.apiKey)}`);
  },
});

/** Echoes its setting: lets a test feed an old or candidate secret through a node. */
const echo = defineNode({
  type: 'leaky:echo',
  version: 1,
  kind: 'data',
  title: 'Echo',
  description: 'Returns its text setting as the value and the reason.',
  icon: 'drop',
  inputs: [],
  outputs: [...value],
  settings: z.object({ text: z.string() }),
  async data(_ctx, settings) {
    return { value: settings.text, reason: settings.text };
  },
});

export default definePlugin({
  name: 'leaky',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [leak, findings, throws, echo],
});
