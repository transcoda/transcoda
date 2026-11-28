import { definePlugin, defineTrigger } from '@transcoda/sdk';
import { z } from 'zod';

type Body = { eventType?: string; paths?: string[]; files?: unknown; reason?: string };

// Answers by the request's `eventType`, so a test can ask for each kind of answer.
const answer = defineTrigger({
  id: 'import',
  title: 'Import',
  description: 'Queues the paths in the request body.',
  icon: 'download',
  settings: z.object({}),
  auth: { basic: true },
  async handle(_ctx, request) {
    const body = (request.body ?? {}) as Body;
    switch (body.eventType) {
      case 'Test':
        return { kind: 'test', message: 'test received' };
      case 'Headers':
        return { kind: 'test', message: Object.keys(request.headers).sort().join(',') };
      case 'Ignore':
        return { kind: 'ignore', reason: body.reason ?? 'not an import' };
      case 'Malformed':
        return { kind: 'files', files: body.files } as never;
      case 'Throw':
        throw new Error('trigger exploded');
      default:
        return {
          kind: 'files',
          files: (body.paths ?? []).map((path) => ({ path, note: 'imported' })),
        };
    }
  },
});

// The same, with the token in a named header instead of Basic auth.
const keyed = defineTrigger({ ...answer, id: 'keyed', auth: { header: 'x-api-key' } });

export default definePlugin({
  name: 'trigger',
  version: '0.1.0',
  sdk: '^1',
  nodes: [],
  triggers: [answer, keyed],
});
