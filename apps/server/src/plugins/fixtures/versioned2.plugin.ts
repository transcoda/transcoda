import { defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

const file = { id: 'file', label: 'File', type: 'file' } as const;

// The next release of `versioned`: `versioned:thing` moves to version 4 and no longer serves
// version 1 (the 1→2 migration is gone); 2→3 changes behaviour, 3→4 is safe.
const thing = defineNode({
  type: 'versioned:thing',
  version: 4,
  kind: 'condition',
  title: 'Thing',
  description: 'A node that shipped four versions; version 1 is no longer served.',
  icon: 'file',
  inputs: [file],
  outputs: [
    { id: 'pass', label: 'Pass', type: 'file' },
    { id: 'else', label: 'Else', type: 'file' },
  ],
  settings: z.object({ value: z.string() }),
  migrations: [
    {
      from: 2,
      to: 3,
      risk: 'behaviour',
      note: 'value is now required',
      migrate: (s) => {
        const { mid, ...rest } = s as Record<string, unknown>;
        return { ...rest, value: mid } as never;
      },
    },
    { from: 3, to: 4, risk: 'safe', note: 'nothing', migrate: (s) => s },
  ],
  async decide(_ctx, settings) {
    return { port: 'pass', reason: `value is ${settings.value}` };
  },
});

export default definePlugin({
  name: 'versioned',
  version: '0.1.0',
  sdk: '^1',
  nodes: [thing],
});
