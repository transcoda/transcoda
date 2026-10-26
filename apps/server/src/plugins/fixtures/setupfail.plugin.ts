import { defineIntegration, definePlugin, secret } from '@transcoda/sdk';
import { z } from 'zod';

const integration = defineIntegration({
  id: 'setupfail',
  title: 'Setup fail',
  settings: z.object({ apiKey: secret().optional() }),
  allowedOrigins: [],
  async test(ctx) {
    return { ok: true, message: `key is ${String(ctx.settings.apiKey)}` };
  },
});

/** Starts fine with no key; once a key is saved, the next start fails with the key in the message. */
export default definePlugin({
  name: 'setupfail',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [],
  async setup(ctx) {
    const key = ctx.settings.apiKey;
    if (typeof key === 'string' && key !== '') throw new Error(`rejected key ${key}`);
  },
});
