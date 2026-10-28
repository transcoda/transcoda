import { defineNode } from '@transcoda/sdk';
import { ALREADY_PROCESSED_TYPE, AlreadyProcessedSettingsSchema } from '@transcoda/shared';
import type { CoreTools } from '../../engine/check-source.ts';
import { filePort, passElse } from './common.ts';

/**
 * Yes when the file has already been through a workflow: a real job of it (at the version, if
 * set) ended done, nothing to do or kept original with this file as its source or its output,
 * known by fingerprint or, failing that, by its sampled content hash. "This workflow" (no
 * `workflowId`) is the workflow the job runs, also inside a sub-workflow. The lookup is the
 * engine's (`ctx.core`, server-side only).
 */
export const alreadyProcessed = defineNode({
  type: ALREADY_PROCESSED_TYPE,
  version: 1,
  kind: 'condition',
  title: 'Already processed',
  description: 'Checks whether the file has already been through a workflow.',
  icon: 'history',
  inputs: [filePort],
  outputs: passElse,
  settings: AlreadyProcessedSettingsSchema,
  async decide(ctx, { workflowId, version }) {
    const core = (ctx as { core?: CoreTools }).core;
    if (!core) throw new Error('already processed is not available here');
    const r = await core.alreadyProcessed({
      workflowId: workflowId ?? null,
      version: version ?? null,
    });
    return { port: r.processed ? 'pass' : 'else', reason: r.reason, findings: r.findings };
  },
});
