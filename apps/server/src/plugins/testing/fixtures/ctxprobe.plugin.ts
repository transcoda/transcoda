import { defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

// Reports what a node hook sees in ctx.plugin (dryRun, job) in its result and in a log line.
const file = { id: 'file', label: 'File', type: 'file' } as const;
const settings = z.object({});
const seen = (ctx: { plugin: { dryRun: boolean; job: { id: string; attempt: number } | null } }) =>
  `dryRun=${ctx.plugin.dryRun} job=${ctx.plugin.job === null ? 'null' : `${ctx.plugin.job.id}#${ctx.plugin.job.attempt}`}`;

const base = { version: 1, icon: 'probe', settings } as const;

export default definePlugin({
  name: 'ctxprobe',
  version: '0.1.0',
  sdk: '^1',
  nodes: [
    defineNode({
      ...base,
      type: 'ctxprobe:decide',
      kind: 'condition',
      title: 'Probe decide',
      description: 'Reports its context.',
      inputs: [file],
      outputs: [{ id: 'pass', label: 'Pass', type: 'file' }],
      async decide(ctx) {
        await ctx.plugin.log('info', `decide ${seen(ctx)}`);
        return { port: 'pass', reason: seen(ctx) };
      },
    }),
    defineNode({
      ...base,
      type: 'ctxprobe:build',
      kind: 'action',
      title: 'Probe build',
      description: 'Reports its context.',
      inputs: [file],
      outputs: [{ id: 'file', label: 'File', type: 'file' }],
      async build(ctx) {
        await ctx.plugin.log('info', `build ${seen(ctx)}`);
        return { model: ctx.model, reason: seen(ctx) };
      },
    }),
    defineNode({
      ...base,
      type: 'ctxprobe:finish',
      kind: 'finish',
      finishPhase: 'notify',
      title: 'Probe finish',
      description: 'Reports its context.',
      inputs: [file],
      outputs: [],
      async finish(ctx) {
        await ctx.plugin.log('info', `finish ${seen(ctx)}`);
        return { actions: [], reason: seen(ctx) };
      },
      async run(ctx) {
        await ctx.plugin.log('info', `run ${seen(ctx)}`);
        return { ok: true, message: seen(ctx) };
      },
    }),
    defineNode({
      ...base,
      type: 'ctxprobe:data',
      kind: 'data',
      title: 'Probe data',
      description: 'Reports its context.',
      inputs: [],
      outputs: [{ id: 'value', label: 'Language', type: 'data:language' }],
      async data(ctx) {
        await ctx.plugin.log('info', `data ${seen(ctx)}`);
        return { value: 'eng', reason: seen(ctx) };
      },
    }),
  ],
});
