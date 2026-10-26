import { defineNode } from '@transcoda/sdk';
import { RunSubworkflowSettingsSchema } from '@transcoda/shared';
import { z } from 'zod';
import { filePort } from './common.ts';

export const subworkflowStart = defineNode({
  type: 'core:subworkflow-start',
  version: 1,
  kind: 'subworkflow-io',
  title: 'Start',
  description: 'Where a sub-workflow receives its file.',
  icon: 'log-in',
  inputs: [],
  outputs: [filePort],
  settings: z.object({}),
});

export const subworkflowEnd = defineNode({
  type: 'core:subworkflow-end',
  version: 1,
  kind: 'subworkflow-io',
  title: 'End',
  description: 'Where a sub-workflow hands its file back.',
  icon: 'log-out',
  inputs: [filePort],
  outputs: [],
  settings: z.object({}),
});

export const runSubworkflow = defineNode({
  type: 'core:run-subworkflow',
  version: 1,
  kind: 'action',
  title: 'Run sub-workflow',
  description: 'Runs another workflow on the file and continues with its result.',
  icon: 'workflow',
  inputs: [filePort],
  outputs: [filePort],
  settings: RunSubworkflowSettingsSchema,
});
