import { type FinishContext, nodeMetadata, parseSettings } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import { modelFromProbe } from '../../engine/model/model.ts';
import { probeOf } from '../../engine/testing/builders.ts';
import { APPROVAL_TYPE } from '../availability.ts';
import { approval, approvalActionOf } from './approval.ts';
import { decideCtx, finish } from './testing.ts';

describe('approval node', () => {
  it('is a gate-phase finish step whose file leaves by Approved (pass) or Rejected (else)', () => {
    expect(approval).toMatchObject({
      type: APPROVAL_TYPE,
      kind: 'finish',
      finishPhase: 'gate',
      version: 1,
    });
    expect(approval.outputs.map((p) => [p.id, p.label])).toEqual([
      ['pass', 'Approved'],
      ['else', 'Rejected'],
    ]);
    expect(nodeMetadata(approval).finishPhase).toBe('gate');
  });

  it('waits 7 days by default, from 1 to 30', () => {
    expect(parseSettings(approval, {})).toEqual({ ok: true, value: { expireAfterDays: 7 } });
    expect(parseSettings(approval, { expireAfterDays: 30 }).ok).toBe(true);
    for (const bad of [0, 31, 2.5]) {
      expect(parseSettings(approval, { expireAfterDays: bad }).ok, String(bad)).toBe(false);
    }
  });

  it('returns no SDK action: the walk adds its core-only approval action', async () => {
    const probe = probeOf([{}]);
    const ctx: FinishContext = { ...decideCtx(probe), model: modelFromProbe(probe) };
    expect(await finish(approval, ctx, { expireAfterDays: 3 })).toEqual({
      actions: [],
      reason: 'wait for a person to approve the result (up to 3 days)',
    });
    expect(approvalActionOf('ap', ['run'], { expireAfterDays: 3 })).toEqual({
      kind: 'approval',
      expireAfterDays: 3,
      nodeId: 'ap',
      workflowPath: ['run'],
    });
    // A setting the walk could not read waits the default time.
    expect(approvalActionOf('ap', [], {}).expireAfterDays).toBe(7);
  });
});
