import { type AnyFinishAction, defineNode } from '@transcoda/sdk';
import type { JsonValue } from '@transcoda/shared';
import { z } from 'zod';
import { APPROVAL_TYPE } from '../availability.ts';
import { filePort } from './common.ts';

/** The longest an Approval step waits for an answer. */
export const APPROVAL_EXPIRE_DAYS_MAX = 30;
const DEFAULT_EXPIRE_DAYS = 7;

const ApprovalSettingsSchema = z.object({
  expireAfterDays: z
    .number()
    .int()
    .min(1)
    .max(APPROVAL_EXPIRE_DAYS_MAX)
    .default(DEFAULT_EXPIRE_DAYS)
    .describe('Wait at most (days)')
    .meta({
      help: 'With no answer by then the result is rejected: it is discarded and the original kept.',
    }),
});

/**
 * The Approval step's action. Core-only, so it is not part of the SDK's `FinishAction` (the 1.x
 * API stays as it is): the walk adds it for an Approval node, and only the engine reads it.
 */
export interface ApprovalAction {
  kind: 'approval';
  expireAfterDays: number;
  nodeId: string;
  workflowPath: string[];
}

/** What the walk collects and the pipeline runs: the SDK's actions plus the core-only ones. */
export type EngineFinishAction = AnyFinishAction | ApprovalAction;

/**
 * A finish step that parks the rendered and verified result until a person approves or rejects
 * it on the job page (docs/dev/engine.md, "Approval"). Approved continues the finish steps;
 * Rejected, or no answer in time, discards the result and keeps the original, and runs only the
 * non-writing steps wired to it. Nothing is written while it waits.
 */
export const approval = defineNode({
  type: APPROVAL_TYPE,
  version: 1,
  kind: 'finish',
  finishPhase: 'gate',
  title: 'Approval',
  description:
    'Holds the result until a person approves it on the job page. Approved: the finish steps continue. Rejected, or no answer in time: the original is kept.',
  icon: 'user-check',
  inputs: [filePort],
  // The ids are the size gate's, so the walk and validation treat both gates alike.
  outputs: [
    { id: 'pass', label: 'Approved', type: 'file' },
    { id: 'else', label: 'Rejected', type: 'file' },
  ],
  settings: ApprovalSettingsSchema,
  async finish(_ctx, { expireAfterDays }) {
    return {
      actions: [],
      reason: `wait for a person to approve the result (up to ${expireAfterDays} days)`,
    };
  },
});

/** The Approval node's action, from its stored settings (the default wait when unreadable). */
export function approvalActionOf(
  nodeId: string,
  workflowPath: string[],
  settings: Record<string, JsonValue>,
): ApprovalAction {
  const parsed = ApprovalSettingsSchema.safeParse(settings);
  return {
    kind: 'approval',
    expireAfterDays: parsed.success ? parsed.data.expireAfterDays : DEFAULT_EXPIRE_DAYS,
    nodeId,
    workflowPath: [...workflowPath],
  };
}
