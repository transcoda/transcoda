import { defineNode } from '@transcoda/sdk';
import {
  CHECK_SOURCE_DAMAGED_PORT,
  CHECK_SOURCE_OK_PORT,
  CHECK_SOURCE_TYPE,
} from '@transcoda/shared';
import { z } from 'zod';
import type { CoreTools } from '../../engine/check-source.ts';
import { filePort } from './common.ts';

/**
 * Reads the whole file once (audio decoded, video copied unless "Decode video too") before
 * anything is encoded. OK continues; a file with source decode errors or cut off continues on
 * Damaged. A pass that cannot tell (an I/O error, a timeout) fails the job as a retryable failure,
 * never Damaged. The pass is the engine's (`ctx.core`, server-side only).
 */
export const checkSource = defineNode({
  type: CHECK_SOURCE_TYPE,
  version: 1,
  kind: 'condition',
  title: 'Check source',
  description:
    'Reads the whole file before anything is encoded. OK continues; a damaged file continues on Damaged.',
  icon: 'shield',
  inputs: [filePort],
  outputs: [
    { id: CHECK_SOURCE_OK_PORT, label: 'OK', type: 'file' },
    { id: CHECK_SOURCE_DAMAGED_PORT, label: 'Damaged', type: 'file' },
  ],
  settings: z.object({
    decodeVideo: z.boolean().default(false).meta({
      description: 'Decode video too',
      help: 'Also decodes the video, not only the audio. Slower; finds damaged video frames too.',
    }),
  }),
  async decide(ctx, { decodeVideo }) {
    const core = (ctx as { core?: CoreTools }).core;
    if (!core) throw new Error('check source is not available here');
    const r = await core.checkSource({ decodeVideo });
    if (r.kind === 'ok') {
      const warnings = r.warnings;
      return {
        port: CHECK_SOURCE_OK_PORT,
        reason: ['source reads clean', ...warnings].join('; '),
        findings: { warnings },
      };
    }
    if (r.kind === 'damaged') {
      return {
        port: CHECK_SOURCE_DAMAGED_PORT,
        reason: r.reason,
        findings: { reason: r.reason, ...(r.stream !== undefined ? { stream: r.stream } : {}) },
      };
    }
    throw Object.assign(new Error(`check source failed: ${r.message}`), { retryable: true });
  },
});
