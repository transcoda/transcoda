import { defineIntegration, definePlugin, secret } from '@transcoda/sdk';
import { z } from 'zod';

const integration = defineIntegration({
  id: 'secrets',
  title: 'Secrets',
  settings: z.object({ apiKey: secret() }),
  allowedOrigins: [],
  async test(ctx) {
    return { ok: true, message: `key is ${String(ctx.settings.apiKey)}` };
  },
});

export default definePlugin({
  name: 'secrets',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [],
});
