import { defineNode, definePlugin, type NodeDefinition } from '@transcoda/sdk';
import { z } from 'zod';

const file = { id: 'file', label: 'File', type: 'file' } as const;

function rename(from: string, to: string) {
  return (settings: unknown) => {
    const { [from]: value, ...rest } = settings as Record<string, unknown>;
    return { ...rest, [to]: value } as never;
  };
}

const thing = defineNode({
  type: 'versioned:thing',
  version: 3,
  kind: 'condition',
  title: 'Thing',
  description: 'A node that shipped three versions.',
  icon: 'file',
  inputs: [file],
  outputs: [
    { id: 'pass', label: 'Pass', type: 'file' },
    { id: 'else', label: 'Else', type: 'file' },
  ],
  settings: z.object({ value: z.string() }),
  migrations: [
    { from: 1, to: 2, risk: 'safe', note: 'old is now mid', migrate: rename('old', 'mid') },
    {
      from: 2,
      to: 3,
      risk: 'behaviour',
      note: 'value is now required',
      migrate: rename('mid', 'value'),
    },
  ],
  async decide(_ctx, settings) {
    return { port: 'pass', reason: `value is ${settings.value}` };
  },
});

const ports: Pick<NodeDefinition, 'inputs' | 'outputs'> = {
  inputs: [file],
  outputs: [
    { id: 'pass', label: 'Pass', type: 'file' },
    { id: 'else', label: 'Else', type: 'file' },
  ],
};

// Misbehaving migrations, selected by the old settings' `mode`.
const flaky = defineNode({
  type: 'versioned:flaky',
  version: 2,
  kind: 'condition',
  title: 'Flaky',
  description: 'Migrations that misbehave.',
  icon: 'file',
  ...ports,
  settings: z.object({ value: z.string() }),
  migrations: [
    {
      from: 1,
      to: 2,
      risk: 'safe',
      note: 'misbehaves',
      migrate: (s) => {
        const mode = (s as { mode?: string }).mode;
        if (mode === 'throw') throw new Error('boom');
        if (mode === 'undefined') return undefined as never;
        if (mode === 'promise') return Promise.resolve({ value: 'x' }) as never;
        if (mode === 'invalid') return { value: 42 } as never;
        if (mode === 'big') return { value: 'x'.repeat(300 * 1024) } as never;
        return { value: 'ok' };
      },
    },
  ],
  async decide(ctx, settings) {
    await ctx.plugin.log('info', 'decide-ran');
    return { port: 'pass', reason: `value is ${settings.value}` };
  },
});

const ambiguous = defineNode({
  type: 'versioned:ambiguous',
  version: 2,
  kind: 'condition',
  title: 'Ambiguous',
  description: 'Two steps share a from.',
  icon: 'file',
  ...ports,
  settings: z.object({ value: z.string() }),
  migrations: [
    { from: 1, to: 2, risk: 'safe', note: 'a', migrate: () => ({ value: 'a' }) },
    { from: 1, to: 2, risk: 'safe', note: 'b', migrate: () => ({ value: 'b' }) },
  ],
  async decide(_ctx, settings) {
    return { port: 'pass', reason: settings.value };
  },
});

const overshoot = defineNode({
  type: 'versioned:overshoot',
  version: 2,
  kind: 'condition',
  title: 'Overshoot',
  description: 'A step jumps past the current version.',
  icon: 'file',
  ...ports,
  settings: z.object({ value: z.string() }),
  migrations: [{ from: 1, to: 3, risk: 'safe', note: 'x', migrate: () => ({ value: 'a' }) }],
  async decide(_ctx, settings) {
    return { port: 'pass', reason: settings.value };
  },
});

export default definePlugin({
  name: 'versioned',
  version: '0.1.0',
  sdk: '^1',
  nodes: [thing, flaky, ambiguous, overshoot],
});
