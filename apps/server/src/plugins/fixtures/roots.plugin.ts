import { defineIntegration, definePlugin, pathMappings } from '@transcoda/sdk';
import { z } from 'zod';

// Reports the root folders it is given, as a media manager reports its own.
const integration = defineIntegration({
  id: 'roots',
  title: 'Roots',
  settings: z.object({ roots: z.array(z.string()).default([]), pathMappings: pathMappings() }),
  allowedOrigins: [],
  async test(ctx) {
    const roots = ctx.settings.roots as string[];
    return { ok: true, message: 'reachable', roots };
  },
});

export default definePlugin({
  name: 'roots',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [],
});
