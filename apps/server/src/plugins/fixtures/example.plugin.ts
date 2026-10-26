import { defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

const file = { id: 'file', label: 'File', type: 'file' } as const;

const extensionIs = defineNode({
  type: 'example:extension-is',
  version: 1,
  kind: 'condition',
  title: 'Extension is',
  description: 'Branches on the file extension.',
  icon: 'file',
  inputs: [file],
  outputs: [
    { id: 'pass', label: 'Pass', type: 'file' },
    { id: 'else', label: 'Else', type: 'file' },
  ],
  settings: z.object({ extensions: z.array(z.string()).default(['mkv']) }),
  async decide(ctx, settings) {
    await ctx.plugin.log('debug', `checking ${ctx.file.path}`);
    const extension = ctx.file.path.split('.').pop() ?? '';
    const hit = settings.extensions.includes(extension.toLowerCase());
    return hit
      ? { port: 'pass', reason: `.${extension} is wanted` }
      : { port: 'else', reason: `.${extension} is not ${settings.extensions.join(', ')}` };
  },
});

const note = defineNode({
  type: 'example:note',
  version: 1,
  kind: 'finish',
  finishPhase: 'notify',
  title: 'Note',
  description: 'Records a note after the file is written.',
  icon: 'note',
  inputs: [file],
  outputs: [],
  settings: z.object({
    text: z.string().default('hello'),
    required: z.boolean().default(false),
    fail: z.boolean().default(false),
  }),
  async finish(_ctx, settings) {
    return {
      actions: [
        { kind: 'plugin', description: `note ${settings.text}`, required: settings.required },
      ],
      reason: 'note queued',
    };
  },
  async run(ctx, settings) {
    return settings.fail
      ? { ok: false, message: 'note failed on purpose' }
      : { ok: true, message: `noted ${ctx.newPath}` };
  },
});

const fixedLanguage = defineNode({
  type: 'example:fixed-language',
  version: 1,
  kind: 'data',
  title: 'Fixed language',
  description: 'Always answers the configured language.',
  icon: 'language',
  inputs: [],
  outputs: [{ id: 'value', label: 'Language', type: 'data:language' }],
  settings: z.object({ language: z.string().default('eng') }),
  async data(_ctx, settings) {
    return { value: settings.language, reason: 'fixed' };
  },
});

export default definePlugin({
  name: 'example',
  version: '0.1.0',
  sdk: '^1',
  nodes: [extensionIs, note, fixedLanguage],
  async setup(ctx) {
    await ctx.log('debug', 'example 0.1.0 loaded');
  },
});
