import { setTimeout as sleep } from 'node:timers/promises';
import { defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

const hogNode = defineNode({
  type: 'hog:hog',
  version: 1,
  kind: 'data',
  title: 'Hog',
  description: 'Holds 64 MB buffers until the server kills it, for the RSS watchdog tests.',
  icon: 'memory',
  inputs: [],
  outputs: [{ id: 'value', label: 'Value', type: 'data:hog' }],
  settings: z.object({}),
  async data() {
    const chunks: Buffer[] = [];
    for (;;) {
      // Filled, so the pages are touched and count towards RSS.
      chunks.push(Buffer.alloc(64 * 1024 * 1024, 1));
      await sleep(20);
    }
  },
});

const bigResultNode = defineNode({
  type: 'hog:big-result',
  version: 1,
  kind: 'data',
  title: 'Big result',
  description: 'Returns a 17 MB string, for the IPC message cap test.',
  icon: 'memory',
  inputs: [],
  outputs: [{ id: 'value', label: 'Value', type: 'data:hog' }],
  settings: z.object({}),
  async data() {
    return { value: 'x'.repeat(17 * 1024 * 1024), reason: 'big' };
  },
});

export default definePlugin({
  name: 'hog',
  version: '0.1.0',
  sdk: '^1',
  nodes: [hogNode, bigResultNode],
});
