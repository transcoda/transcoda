import { defineNode, type NodeDefinition } from '@transcoda/sdk';
import { z } from 'zod';
import { filePort } from './common.ts';

const trigger: Pick<NodeDefinition, 'version' | 'kind' | 'inputs' | 'outputs'> = {
  version: 1,
  kind: 'trigger',
  inputs: [],
  outputs: [filePort],
};

export const inputLibrary = defineNode({
  ...trigger,
  type: 'core:input-library',
  title: 'Library input',
  description: 'Starts the workflow for each file that appears in a library.',
  icon: 'folder',
  onNodeSettings: ['libraryId'],
  // Revisit (export/import): libraryId is a database row id inside the graph; export/import must remap it.
  settings: z.object({
    libraryId: z
      .string()
      .min(1)
      .describe('Library — Files from this library go to this workflow once a version is active.'),
  }),
});

export const inputWebhook = defineNode({
  ...trigger,
  type: 'core:input-webhook',
  title: 'Webhook input',
  description: 'Starts the workflow when an HTTP request arrives.',
  icon: 'webhook',
  // Revisit (engine track): no settings yet; the request shape, auth and endpoint id are undecided.
  settings: z.object({}),
});

export const inputManual = defineNode({
  ...trigger,
  type: 'core:input-manual',
  title: 'Manual input',
  description: 'Starts the workflow on a file you pick by hand.',
  icon: 'hand',
  settings: z.object({}),
});
