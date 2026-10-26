import { writeSync } from 'node:fs';
import { defineIntegration, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

const integration = defineIntegration({
  id: 'crash',
  title: 'Crash',
  settings: z.object({
    mode: z.enum(['none', 'exit', 'timer', 'heap', 'garbage', 'garbage-later']).default('none'),
  }),
  allowedOrigins: [],
  async test() {
    return { ok: true, message: 'ok' };
  },
});

/**
 * Writes straight to the inherited channel fd (3): a length-prefixed, structurally invalid V8
 * frame plus a newline, so it is malformed under either channel serialization.
 */
function garbageFrame(): void {
  const body = Buffer.from([0xff, 0x0f, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  writeSync(3, Buffer.concat([head, body, Buffer.from('\n')]));
}

export default definePlugin({
  name: 'crash',
  version: '0.1.0',
  sdk: '^1',
  integration,
  nodes: [],
  async setup(ctx) {
    const mode = ctx.settings.mode;
    if (mode === 'exit') process.exit(3);
    if (mode === 'timer') {
      setTimeout(() => {
        throw new Error('crash from a timer');
      }, 20);
    }
    if (mode === 'garbage') garbageFrame();
    if (mode === 'garbage-later') setTimeout(garbageFrame, 200);
    if (mode === 'heap') {
      const keep: number[][] = [];
      for (;;) keep.push(new Array<number>(100_000).fill(Math.random()));
    }
  },
});
