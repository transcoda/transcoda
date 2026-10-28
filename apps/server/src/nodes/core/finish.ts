import { defineNode, type NodeDefinition } from '@transcoda/sdk';
import { RENDER_DAMAGED_PORT, RENDER_DONE_PORT, RENDER_TYPE } from '@transcoda/shared';
import { z } from 'zod';
import { filePort, passElse } from './common.ts';

const finish: Pick<NodeDefinition, 'version' | 'kind' | 'inputs' | 'outputs'> = {
  version: 1,
  kind: 'finish',
  inputs: [filePort],
  outputs: [filePort],
};

/**
 * The one encode a path makes, between its last action and its finish steps: the engine renders
 * the plan the steps before it built (one ffmpeg run) and verifies it. Done continues. With Quality
 * check on, a source that turns out damaged while rendering continues on Damaged, whose steps run
 * without a written result; with it off, Damaged is hidden and such a job ends as it always has.
 */
export const render = defineNode({
  ...finish,
  type: RENDER_TYPE,
  finishPhase: 'render',
  title: 'Render',
  description:
    'Encodes the file as the steps before it planned. Done continues; with Quality check on, a damaged source continues on Damaged instead of failing.',
  icon: 'clapperboard',
  outputs: [
    { id: RENDER_DONE_PORT, label: 'Done', type: 'file' },
    {
      id: RENDER_DAMAGED_PORT,
      label: 'Damaged',
      type: 'file',
      shownWhen: { setting: 'qualityCheck', equals: true },
    },
  ],
  settings: z.object({
    qualityCheck: z.boolean().default(false).meta({
      description: 'Quality check',
      help: 'If the source turns out to be damaged while rendering, continue on Damaged instead of failing.',
    }),
  }),
  async finish(_ctx, { qualityCheck }) {
    return {
      actions: [{ kind: 'render', qualityCheck }],
      reason: qualityCheck ? 'render; a damaged source continues on Damaged' : 'render',
    };
  },
});

export const sizeGate = defineNode({
  ...finish,
  version: 2,
  // `pass` (shown "Yes"): the result saves enough, the finish steps continue. `else` (shown "No"):
  // it does not; the original is kept and only the non-writing finish steps wired to it run.
  outputs: passElse,
  migrations: [
    {
      from: 1,
      to: 2,
      risk: 'safe',
      note: 'the output is now "pass"; "else" is new',
      renameOutputs: { file: 'pass' },
      migrate: (settings) => settings,
    },
  ],
  type: 'core:size-gate',
  finishPhase: 'gate',
  title: 'Size gate',
  description:
    'Did the result save enough space? Yes: the finish steps continue. No: the original is kept and only the steps wired to No run.',
  icon: 'scale',
  onNodeSettings: ['minSavingPercent'],
  settings: z.object({
    minSavingPercent: z.number().min(0).max(100).default(10).describe('Saved at least (%)'),
  }),
  async finish(_ctx, { minSavingPercent }) {
    return {
      actions: [{ kind: 'size-gate', minSavingPercent }],
      reason: `size gate: at least ${minSavingPercent}% smaller`,
    };
  },
});

export const replaceOriginal = defineNode({
  ...finish,
  type: 'core:replace-original',
  finishPhase: 'write',
  title: 'Replace original',
  description: 'Replaces the source file with the result.',
  icon: 'replace',
  settings: z.object({
    recycleFolder: z
      .string()
      .min(1)
      .optional()
      .describe('Recycle folder for the original; unset means the library default'),
  }),
  async finish(_ctx, settings) {
    const recycleFolder = settings.recycleFolder ?? null;
    return {
      actions: [{ kind: 'replace', recycleFolder }],
      reason: `replace the original (recycle folder: ${recycleFolder ?? 'library default'})`,
    };
  },
});

export const moveCopy = defineNode({
  ...finish,
  type: 'core:move-copy',
  finishPhase: 'write',
  title: 'Move or copy',
  description: 'Writes the result to another folder.',
  icon: 'folder-output',
  settings: z.object({
    mode: z.enum(['move', 'copy']).default('copy').describe('Mode'),
    outputRoot: z.string().min(1).describe('Output folder'),
  }),
  async finish(_ctx, { mode, outputRoot }) {
    return {
      actions: [{ kind: 'move-copy', mode, outputRoot }],
      reason: `${mode} the result to ${outputRoot}`,
    };
  },
});

export const notifyWebhook = defineNode({
  ...finish,
  type: 'core:notify-webhook',
  finishPhase: 'notify',
  title: 'Notify webhook',
  description: 'Sends an HTTP request when the file is done.',
  icon: 'send',
  settings: z.object({
    url: z.url().describe('URL'),
    method: z.enum(['POST', 'PUT']).default('POST').describe('HTTP method'),
  }),
  // The URL may carry a token, so the reason (shown in the trace) never includes it.
  async finish(_ctx, { url, method }) {
    return { actions: [{ kind: 'notify', url, method }], reason: `notify webhook (${method})` };
  },
});
